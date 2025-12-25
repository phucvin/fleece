const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function readVarInt(buffer, pos) {
    let result = 0;
    let shift = 0;
    let length = 0;
    while (true) {
        const b = buffer[pos + length];
        length++;
        result |= (b & 0x7F) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result, length };
}

class FleeceValue {
    constructor(buffer, pos, view, wide) {
        this.buffer = buffer;
        this.view = view || new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        this.pos = pos;
        this.wide = wide || false;
        this._resolvePointer();
    }

    _resolvePointer() {
        let loopCount = 0;
        while (true) {
            if (loopCount++ > 100) throw new Error("Pointer cycle detected or too deep");
            if (this.pos >= this.buffer.length) return;

            const b0 = this.buffer[this.pos];
            if ((b0 & 0x80) !== 0) {
                 let offsetBytes = 0;
                 if (this.wide) {
                     const b1 = this.buffer[this.pos + 1];
                     const b2 = this.buffer[this.pos + 2];
                     const b3 = this.buffer[this.pos + 3];
                     const o = ((b0 & 0x7F) << 24) | (b1 << 16) | (b2 << 8) | b3;
                     offsetBytes = o * 2;
                 } else {
                     const b1 = this.buffer[this.pos + 1];
                     const o = ((b0 & 0x7F) << 8) | b1;
                     offsetBytes = o * 2;
                 }
                 if (offsetBytes === 0) throw new Error("Invalid pointer offset 0");
                 this.pos = this.pos - offsetBytes;
                 this.wide = false;
            } else {
                break;
            }
        }
    }

    getType() {
        const b0 = this.buffer[this.pos];
        const tag = b0 >> 4;
        switch (tag) {
            case 0: case 1: return 'number';
            case 2: return 'number';
            case 3:
                const s = (b0 >> 2) & 3;
                if (s === 0) return 'null';
                if (s === 1 || s === 2) return 'boolean';
                return 'undefined';
            case 4: return 'string';
            case 5: return 'binary';
            case 6: return 'array';
            case 7: return 'dict';
            default: return 'unknown';
        }
    }

    asMutable() {
        const type = this.getType();
        if (type === 'array') {
            return new MutableArray(this.asArray());
        }
        if (type === 'dict') {
            return new MutableDict(this.asDict());
        }
        return this.toJS();
    }

    toJS() {
        const type = this.getType();
        if (type === 'null') return null;
        if (type === 'boolean') return this.asBoolean();
        if (type === 'number') return this.asNumber();
        if (type === 'string') return this.asString();
        if (type === 'binary') return this.asBinary();
        if (type === 'array') {
            const arr = this.asArray();
            const res = [];
            for (let i = 0; i < arr.length; i++) {
                res.push(arr.get(i).toJS());
            }
            return res;
        }
        if (type === 'dict') {
            const dict = this.asDict();
            const res = {};
            for (const key of dict.keys()) {
                res[key] = dict.get(key).toJS();
            }
            return res;
        }
        return undefined;
    }

    asBoolean() {
        const b0 = this.buffer[this.pos];
        const tag = b0 >> 4;
        if (tag === 3) {
             const s = (b0 >> 2) & 3;
             if (s === 1) return false;
             if (s === 2) return true;
        }
        throw new Error("Value is not a boolean");
    }

    asNumber() {
        const b0 = this.buffer[this.pos];
        const b1 = this.buffer[this.pos + 1];
        const tag = b0 >> 4;

        if (tag === 0) { // Small Int
             const high = b0 & 0x0F;
             const low = b1;
             let val = (high << 8) | low;
             if (val & 0x800) val = val - 0x1000;
             return val;
        } else if (tag === 1) { // Long Int
             const u = (b0 >> 3) & 1;
             const ccc = b0 & 0x07;
             const size = ccc + 1;
             const intPos = this.pos + 1;
             let val = 0;
             if (size === 1) {
                val = this.view.getInt8(intPos);
                if (u) val = val & 0xFF;
             } else if (size === 2) {
                val = this.view.getInt16(intPos, true);
                if (u) val = val & 0xFFFF;
             } else if (size === 4) {
                val = this.view.getInt32(intPos, true);
                if (u) val = val >>> 0;
             } else if (size === 8) {
                val = this.view.getBigInt64(intPos, true);
                if (u) val = this.view.getBigUint64(intPos, true);
                if (val <= Number.MAX_SAFE_INTEGER && val >= Number.MIN_SAFE_INTEGER) {
                    val = Number(val);
                }
             }
             return val;
        } else if (tag === 2) { // Float
             const s = (b0 >> 3) & 1;
             const dataPos = this.pos + 2;
             if (s === 0) return this.view.getFloat32(dataPos, true);
             else return this.view.getFloat64(dataPos, true);
        }
        throw new Error("Value is not a number");
    }

    asString() {
        const b0 = this.buffer[this.pos];
        const tag = b0 >> 4;
        if (tag !== 4) throw new Error("Value is not a string");
        const cccc = b0 & 0x0F;
        let len = cccc;
        let dataPos = this.pos + 1;
        if (cccc === 15) {
            const { value, length } = readVarInt(this.buffer, dataPos);
            len = value;
            dataPos += length;
        }
        const bytes = this.buffer.slice(dataPos, dataPos + len);
        return textDecoder.decode(bytes);
    }

    asBinary() {
        const b0 = this.buffer[this.pos];
        const tag = b0 >> 4;
        if (tag !== 5) throw new Error("Value is not binary");
        const cccc = b0 & 0x0F;
        let len = cccc;
        let dataPos = this.pos + 1;
        if (cccc === 15) {
            const { value, length } = readVarInt(this.buffer, dataPos);
            len = value;
            dataPos += length;
        }
        return this.buffer.slice(dataPos, dataPos + len);
    }

    asArray() {
        if (this.getType() !== 'array') throw new Error("Value is not an array");
        return new FleeceArray(this.buffer, this.pos, this.view);
    }

    asDict() {
        if (this.getType() !== 'dict') throw new Error("Value is not a dict");
        return new FleeceDict(this.buffer, this.pos, this.view);
    }
}

class FleeceArray {
    constructor(buffer, pos, view) {
        this.buffer = buffer;
        this.view = view;
        this.pos = pos;

        const b0 = this.buffer[pos];
        const b1 = this.buffer[pos+1];
        this.wide = (b0 >> 3) & 1;
        const ccc = ((b0 & 0x07) << 8) | b1;

        this.count = ccc;
        this.dataPos = pos + 2;
        if (ccc === 2047) {
             const { value, length } = readVarInt(buffer, this.dataPos);
             this.count = value;
             this.dataPos += length;
        }
    }

    get length() {
        return this.count;
    }

    get(index) {
        if (index < 0 || index >= this.count) return undefined;
        const slotSize = this.wide ? 4 : 2;
        const slotPos = this.dataPos + (index * slotSize);
        return new FleeceValue(this.buffer, slotPos, this.view, !!this.wide);
    }

    asMutable() {
        return new MutableArray(this);
    }

    *[Symbol.iterator]() {
        for (let i = 0; i < this.count; i++) {
            yield this.get(i);
        }
    }
}

class FleeceDict {
    constructor(buffer, pos, view) {
        this.buffer = buffer;
        this.view = view;
        this.pos = pos;

        const b0 = this.buffer[pos];
        const b1 = this.buffer[pos+1];
        this.wide = (b0 >> 3) & 1;
        const ccc = ((b0 & 0x07) << 8) | b1;

        this.count = ccc;
        this.dataPos = pos + 2;
        if (ccc === 2047) {
             const { value, length } = readVarInt(buffer, this.dataPos);
             this.count = value;
             this.dataPos += length;
        }
    }

    get length() {
        return this.count;
    }

    get(key) {
        let low = 0;
        let high = this.count - 1;
        const slotSize = this.wide ? 4 : 2;

        while (low <= high) {
            const mid = (low + high) >>> 1;
            const keySlotPos = this.dataPos + (mid * 2 * slotSize);
            const keyVal = new FleeceValue(this.buffer, keySlotPos, this.view, !!this.wide);
            const keyStr = keyVal.asString();

            if (keyStr < key) {
                low = mid + 1;
            } else if (keyStr > key) {
                high = mid - 1;
            } else {
                const valSlotPos = keySlotPos + slotSize;
                return new FleeceValue(this.buffer, valSlotPos, this.view, !!this.wide);
            }
        }
        return undefined;
    }

    asMutable() {
        return new MutableDict(this);
    }

    *keys() {
        const slotSize = this.wide ? 4 : 2;
        for (let i = 0; i < this.count; i++) {
            const keySlotPos = this.dataPos + (i * 2 * slotSize);
            const keyVal = new FleeceValue(this.buffer, keySlotPos, this.view, !!this.wide);
            yield keyVal.asString();
        }
    }
}

class MutableDict {
    constructor(source) {
        this.source = source || null;
        this.changes = new Map();
    }

    get(key) {
        if (this.changes.has(key)) {
            const val = this.changes.get(key);
            return val === undefined ? undefined : val;
        }
        if (this.source) {
            return this.source.get(key);
        }
        return undefined;
    }

    set(key, value) {
        this.changes.set(key, value);
    }

    remove(key) {
        this.changes.set(key, undefined);
    }

    *keys() {
        const keys = new Set();
        if (this.source) {
            for (const k of this.source.keys()) {
                keys.add(k);
            }
        }
        for (const [k, v] of this.changes) {
            if (v === undefined) keys.delete(k);
            else keys.add(k);
        }
        for (const k of keys) yield k;
    }

    getMutable(key) {
        let val = this.get(key);
        if (val instanceof FleeceValue) {
            val = val.asMutable();
            this.set(key, val);
        }
        return val;
    }
}

class MutableArray {
    constructor(source) {
        this.items = [];
        if (source) {
            for (let i = 0; i < source.length; i++) {
                this.items.push(source.get(i));
            }
        }
    }

    get length() { return this.items.length; }

    get(index) { return this.items[index]; }
    set(index, value) { this.items[index] = value; }
    push(...values) { return this.items.push(...values); }
    pop() { return this.items.pop(); }
    splice(start, deleteCount, ...items) { return this.items.splice(start, deleteCount, ...items); }

    getMutable(index) {
        let val = this.items[index];
         if (val instanceof FleeceValue) {
            val = val.asMutable();
            this.items[index] = val;
        }
        return val;
    }

    *[Symbol.iterator]() {
        yield* this.items;
    }
}

class FleeceEncoder {
    constructor() {
        this.buffer = new Uint8Array(1024);
        this.pos = 0;
        this.stringTable = new Map();
        this.baseBuffer = null;
        this.baseLength = 0;
    }

    setBase(buffer) {
        this.baseBuffer = buffer;
        this.baseLength = buffer ? buffer.byteLength : 0;
    }

    ensureCapacity(size) {
        if (this.pos + size > this.buffer.length) {
            const newSize = Math.max(this.buffer.length * 2, this.pos + size);
            const newBuf = new Uint8Array(newSize);
            newBuf.set(this.buffer);
            this.buffer = newBuf;
        }
    }

    writeByte(byte) {
        this.ensureCapacity(1);
        this.buffer[this.pos++] = byte;
    }

    writeBytes(bytes) {
        this.ensureCapacity(bytes.length);
        this.buffer.set(bytes, this.pos);
        this.pos += bytes.length;
    }

    pad() {
        if (this.pos % 2 !== 0) {
            this.writeByte(0);
        }
    }

    writeVarInt(n) {
        while (n >= 0x80) {
            this.writeByte((n & 0x7F) | 0x80);
            n >>= 7;
        }
        this.writeByte(n);
    }

    get currentAbsolutePos() {
        return this.baseLength + this.pos;
    }

    encode(value) {
        this.pos = 0;
        this.stringTable.clear();
        this.buffer = new Uint8Array(1024);

        const rootInfo = this.writeValue(value);

        this.pad();
        const rootSlotPos = this.pos;
        const absoluteRootSlotPos = this.currentAbsolutePos; // baseLength + rootSlotPos

        let offset = 0;
        let needsWide = false;

        if (rootInfo.type === 'pointer') {
            offset = absoluteRootSlotPos - rootInfo.target;
            if (offset > 65534) {
                 needsWide = true;
            }
        }

        if (needsWide) {
            const offsetBytes = absoluteRootSlotPos - rootInfo.target;
            const o = offsetBytes / 2;
            const b0 = 0x80 | ((o >> 24) & 0x7F);
            const b1 = (o >> 16) & 0xFF;
            const b2 = (o >> 8) & 0xFF;
            const b3 = o & 0xFF;
            this.writeBytes(new Uint8Array([b0, b1, b2, b3]));

            this.writeBytes(new Uint8Array([0x80, 0x02]));
        } else {
             const finalized = this.finalizeSlot(rootInfo, rootSlotPos, false);
             this.writeBytes(finalized);
        }

        return this.buffer.slice(0, this.pos);
    }

    writeValue(value) {
        if (value === null) {
            return { type: 'immediate', data: new Uint8Array([0x30, 0x00]) };
        } else if (value === false) {
            return { type: 'immediate', data: new Uint8Array([0x34, 0x00]) };
        } else if (value === true) {
            return { type: 'immediate', data: new Uint8Array([0x38, 0x00]) };
        } else if (value instanceof FleeceValue) {
            if (this.baseBuffer && value.buffer === this.baseBuffer) {
                return { type: 'pointer', target: value.pos };
            }
            return this.writeValue(value.toJS());
        } else if (typeof value === 'number') {
            if (Number.isInteger(value)) {
                if (value >= -2048 && value <= 2047) {
                    const val = value & 0xFFF;
                    const high = (val >> 8) & 0x0F;
                    const low = val & 0xFF;
                    return { type: 'immediate', data: new Uint8Array([high, low]) };
                } else {
                    this.pad();
                    const offset = this.currentAbsolutePos;
                    let size, ccc;
                    if (value >= -128 && value <= 127) { size = 1; ccc = 0; }
                    else if (value >= -32768 && value <= 32767) { size = 2; ccc = 1; }
                    else if (value >= -2147483648 && value <= 2147483647) { size = 4; ccc = 3; }
                    else { size = 8; ccc = 7; }

                    const header = 0x10 | ccc;
                    this.writeByte(header);

                    const buffer = new Uint8Array(8);
                    const view = new DataView(buffer.buffer);
                    if (size === 1) view.setInt8(0, value);
                    else if (size === 2) view.setInt16(0, value, true);
                    else if (size === 4) view.setInt32(0, value, true);
                    else view.setBigInt64(0, BigInt(value), true);

                    this.writeBytes(buffer.slice(0, size));
                    return { type: 'pointer', target: offset };
                }
            } else {
                this.pad();
                const offset = this.currentAbsolutePos;
                this.writeByte(0x28);
                this.writeByte(0x00);

                const buffer = new Uint8Array(8);
                new DataView(buffer.buffer).setFloat64(0, value, true);
                this.writeBytes(buffer);
                return { type: 'pointer', target: offset };
            }
        } else if (typeof value === 'string') {
            if (this.stringTable.has(value)) {
                 return { type: 'pointer', target: this.stringTable.get(value) };
            }
            this.pad();
            const offset = this.currentAbsolutePos;
            const utf8 = textEncoder.encode(value);
            const len = utf8.length;

            if (len < 15) {
                this.writeByte(0x40 | len);
            } else {
                this.writeByte(0x4F);
                this.writeVarInt(len);
            }
            this.writeBytes(utf8);

            this.stringTable.set(value, offset);
            return { type: 'pointer', target: offset };

        } else if (Array.isArray(value) || (value instanceof MutableArray)) {
            let slots;
            let count;
            if (Array.isArray(value)) {
                slots = value.map(item => this.writeValue(item));
                count = value.length;
            } else {
                slots = [];
                for (const item of value) {
                    slots.push(this.writeValue(item));
                }
                count = slots.length;
            }
            return this.writeCollection(slots, count, 0x60); // 0x60 is Array Tag

        } else if (typeof value === 'object') {
            // Handle Generic Object or MutableDict
            let keys;
            let valGetter;
            if (value instanceof MutableDict) {
                keys = Array.from(value.keys()).sort();
                valGetter = (k) => value.get(k);
            } else {
                keys = Object.keys(value).sort();
                valGetter = (k) => value[k];
            }

            const keySlots = keys.map(k => this.writeValue(k));
            const valSlots = keys.map(k => this.writeValue(valGetter(k)));

            // Interleave slots for collection writing? No, writeCollection handles lists of slots.
            // But writeCollection expects linear slots.
            // For Dict, we have keySlots and valSlots.
            // We can interleave them into one list: [k1, v1, k2, v2...]
            const slots = [];
            for (let i = 0; i < keys.length; i++) {
                slots.push(keySlots[i]);
                slots.push(valSlots[i]);
            }
            return this.writeCollection(slots, keys.length, 0x70); // 0x70 is Dict Tag
        }

        throw new Error("Unsupported type: " + typeof value);
    }

    writeCollection(slots, count, tagBase) {
        this.pad();
        const offset = this.currentAbsolutePos;

        let ccc = count;
        let varintCount = false;
        if (count >= 2047) {
            ccc = 2047;
            varintCount = true;
        }

        let wide = false;
        // Estimate check for wide
        // Current absolute pos is `offset`.
        // Header is 2 bytes (or more).
        let headerSize = 2;
        if (varintCount) {
             let n = count;
             while (n >= 0x80) { headerSize++; n >>= 7; }
             headerSize++;
        }

        let slotsStartAbsolute = offset + headerSize;

        let tempPos = slotsStartAbsolute;
        for (const slot of slots) {
            if (slot.type === 'pointer') {
                 const off = tempPos - slot.target;
                 if (off > 65534) {
                     wide = true;
                     break;
                 }
            }
            tempPos += 2;
        }

        const high3 = (ccc >> 8) & 0x07;
        const low8 = ccc & 0xFF;
        const wBit = wide ? 0x08 : 0x00;

        this.writeByte(tagBase | wBit | high3);
        this.writeByte(low8);

        if (varintCount) {
            this.writeVarInt(count);
        }

        let currentSlotPos = this.pos; // Relative for finalizeSlot call?
        // finalizeSlot takes writePos.
        // It converts to absolute inside.
        // So we pass relative pos.
        const slotStep = wide ? 4 : 2;

        for (const slot of slots) {
            const finalized = this.finalizeSlot(slot, currentSlotPos, wide);
            this.writeBytes(finalized);
            currentSlotPos += slotStep;
        }

        return { type: 'pointer', target: offset };
    }

    finalizeSlot(slot, writePos, wide) {
        if (!wide) {
            if (slot.type === 'immediate') {
                return slot.data;
            } else {
                const absoluteWritePos = this.baseLength + writePos;
                const offsetBytes = absoluteWritePos - slot.target;
                const offsetUnits = offsetBytes / 2;
                const o = offsetUnits;
                const b0 = 0x80 | ((o >> 8) & 0x7F);
                const b1 = o & 0xFF;
                return new Uint8Array([b0, b1]);
            }
        } else {
            if (slot.type === 'immediate') {
                const data = new Uint8Array(4);
                data.set(slot.data, 0);
                return data;
            } else {
                const absoluteWritePos = this.baseLength + writePos;
                const offsetBytes = absoluteWritePos - slot.target;
                const offsetUnits = offsetBytes / 2;
                const o = offsetUnits;
                const b0 = 0x80 | ((o >> 24) & 0x7F);
                const b1 = (o >> 16) & 0xFF;
                const b2 = (o >> 8) & 0xFF;
                const b3 = o & 0xFF;
                return new Uint8Array([b0, b1, b2, b3]);
            }
        }
    }
}

class FleeceDecoder {
    constructor(buffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }

    getRoot() {
        if (this.buffer.length < 2) return null;
        let pos = this.buffer.length - 2;

        const root1 = new FleeceValue(this.buffer, pos, this.view, false);

        let p = pos;
        let b0 = this.buffer[p];
        if ((b0 & 0x80) !== 0) {
            let b1 = this.buffer[p+1];
            let o = ((b0 & 0x7F) << 8) | b1;
            p = p - o * 2;

            b0 = this.buffer[p];
            if ((b0 & 0x80) !== 0) {
                 let b1 = this.buffer[p+1];
                 let b2 = this.buffer[p+2];
                 let b3 = this.buffer[p+3];
                 let oWide = ((b0 & 0x7F) << 24) | (b1 << 16) | (b2 << 8) | b3;
                 p = p - oWide * 2;
            }
        }

        return new FleeceValue(this.buffer, p, this.view);
    }

    decode() {
        const root = this.getRoot();
        return root ? root.toJS() : undefined;
    }
}

module.exports = { FleeceEncoder, FleeceDecoder, FleeceValue, MutableDict, MutableArray };
