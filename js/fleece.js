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

class FleeceEncoder {
    constructor() {
        this.buffer = new Uint8Array(1024);
        this.pos = 0;
        this.stringTable = new Map(); // string -> offset
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

    encode(value) {
        this.pos = 0;
        this.stringTable.clear();
        this.buffer = new Uint8Array(1024);

        const rootInfo = this.writeValue(value); // Returns { type, target/data }

        // Root slot handling:
        // The file must end with a 2-byte slot pointing to the root.
        // If root is too far (> 64KB), we need an intermediate wide pointer.

        this.pad();
        const rootSlotPos = this.pos;

        // Calculate offset to root
        let offset = 0;
        let needsWide = false;

        if (rootInfo.type === 'pointer') {
            offset = rootSlotPos - rootInfo.target;
            if (offset > 65534) {
                 needsWide = true;
            }
        }

        if (needsWide) {
            // Write a Wide Pointer to the root.
            // 4 bytes.
            const offsetBytes = rootSlotPos - rootInfo.target;
            const o = offsetBytes / 2;
            // 31-bit offset. Big Endian.
            // 1ooooooo oooooooo oooooooo oooooooo
            const b0 = 0x80 | ((o >> 24) & 0x7F);
            const b1 = (o >> 16) & 0xFF;
            const b2 = (o >> 8) & 0xFF;
            const b3 = o & 0xFF;
            this.writeBytes(new Uint8Array([b0, b1, b2, b3]));

            // Now write a Narrow Pointer to this Wide Pointer.
            // The Wide Pointer is at `rootSlotPos`.
            // We are now at `rootSlotPos + 4`.
            // Offset is 4 bytes.
            // 4 / 2 = 2 units.
            // Narrow pointer to -2 units.
            // 0x8002 ? No.
            // b0 = 0x80 | ((2 >> 8) & 0x7F) = 0x80.
            // b1 = 2.
            this.writeBytes(new Uint8Array([0x80, 0x02]));
        } else {
             // Standard narrow slot
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
        } else if (typeof value === 'number') {
            if (Number.isInteger(value)) {
                if (value >= -2048 && value <= 2047) {
                    const val = value & 0xFFF;
                    const high = (val >> 8) & 0x0F;
                    const low = val & 0xFF;
                    return { type: 'immediate', data: new Uint8Array([high, low]) };
                } else {
                    // Long Int
                    this.pad();
                    const offset = this.pos;
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
                // Float
                this.pad();
                const offset = this.pos;
                this.writeByte(0x28);
                this.writeByte(0x00);

                const buffer = new Uint8Array(8);
                new DataView(buffer.buffer).setFloat64(0, value, true);
                this.writeBytes(buffer);
                return { type: 'pointer', target: offset };
            }
        } else if (typeof value === 'string') {
            if (this.stringTable.has(value)) {
                 // Check if existing offset is reachable for a narrow pointer.
                 // We don't know the future slot position yet.
                 // But typically string reuse is fine.
                 // If it's too far, we might need to duplicate it?
                 // For now, let's just return the pointer.
                 // If the collection becomes Wide, it handles 32-bit offsets, which covers 4GB.
                 return { type: 'pointer', target: this.stringTable.get(value) };
            }
            this.pad();
            const offset = this.pos;
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

        } else if (Array.isArray(value)) {
            const slots = value.map(item => this.writeValue(item));

            this.pad();
            const offset = this.pos;

            const count = slots.length;
            let ccc = count;
            let varintCount = false;
            if (count >= 2047) {
                ccc = 2047;
                varintCount = true;
            }

            // Check if Wide
            let wide = false;
            // A collection must be wide if any slot needs an offset > 65534 bytes.
            // Or if explicit wide flag is requested (not implemented).
            // Since we don't know the exact slot positions yet (they follow header/varint),
            // we estimate.
            // Current pos is `offset`. Header is 2 bytes + varint.
            // Slots start at `offset + 2 + varintLen`.
            let slotsStart = offset + 2;
            if (varintCount) {
                 // Calculate varint length
                 let n = count;
                 while (n >= 0x80) { slotsStart++; n >>= 7; }
                 slotsStart++;
            }

            // Iterate slots to check offsets
            let tempPos = slotsStart;
            for (const slot of slots) {
                if (slot.type === 'pointer') {
                     const off = tempPos - slot.target;
                     if (off > 65534) {
                         wide = true;
                         break;
                     }
                }
                tempPos += 2; // Check assuming narrow. If wide, offsets increase, but we check conservatively?
                // Actually if we switch to wide, slots are 4 bytes. Offsets become larger.
                // But Wide supports 4GB. So if it doesn't fit in Narrow, it fits in Wide.
            }

            const high3 = (ccc >> 8) & 0x07;
            const low8 = ccc & 0xFF;

            // Array Tag: 0110 w ccc
            // w is bit 3 of first byte.
            const wBit = wide ? 0x08 : 0x00;
            this.writeByte(0x60 | wBit | high3);
            this.writeByte(low8);

            if (varintCount) {
                this.writeVarInt(count);
            }

            let currentSlotPos = this.pos;
            const slotStep = wide ? 4 : 2;

            for (const slot of slots) {
                const finalized = this.finalizeSlot(slot, currentSlotPos, wide);
                this.writeBytes(finalized);
                currentSlotPos += slotStep;
            }

            return { type: 'pointer', target: offset };

        } else if (typeof value === 'object') {
            const keys = Object.keys(value).sort();

            const keySlots = keys.map(k => this.writeValue(k));
            const valSlots = keys.map(k => this.writeValue(value[k]));

            this.pad();
            const offset = this.pos;

            const count = keys.length;
            let ccc = count;
            let varintCount = false;
            if (count >= 2047) {
                ccc = 2047;
                varintCount = true;
            }

            // Check if Wide
            let wide = false;
            let slotsStart = offset + 2;
            if (varintCount) {
                 let n = count;
                 while (n >= 0x80) { slotsStart++; n >>= 7; }
                 slotsStart++;
            }

            let tempPos = slotsStart;
            for (let i = 0; i < count; i++) {
                // Key
                if (keySlots[i].type === 'pointer') {
                    if (tempPos - keySlots[i].target > 65534) { wide = true; break; }
                }
                tempPos += 2;
                // Val
                if (valSlots[i].type === 'pointer') {
                    if (tempPos - valSlots[i].target > 65534) { wide = true; break; }
                }
                tempPos += 2;
            }

            const high3 = (ccc >> 8) & 0x07;
            const low8 = ccc & 0xFF;
            const wBit = wide ? 0x08 : 0x00;

            this.writeByte(0x70 | wBit | high3);
            this.writeByte(low8);

            if (varintCount) {
                this.writeVarInt(count);
            }

            let currentSlotPos = this.pos;
            const slotStep = wide ? 4 : 2;

            for (let i = 0; i < count; i++) {
                const keyFinalized = this.finalizeSlot(keySlots[i], currentSlotPos, wide);
                this.writeBytes(keyFinalized);
                currentSlotPos += slotStep;

                const valFinalized = this.finalizeSlot(valSlots[i], currentSlotPos, wide);
                this.writeBytes(valFinalized);
                currentSlotPos += slotStep;
            }

            return { type: 'pointer', target: offset };
        }

        throw new Error("Unsupported type: " + typeof value);
    }

    finalizeSlot(slot, writePos, wide) {
        if (!wide) {
            // Narrow Slot (2 bytes)
            if (slot.type === 'immediate') {
                return slot.data;
            } else {
                const offsetBytes = writePos - slot.target;
                const offsetUnits = offsetBytes / 2;
                const o = offsetUnits;
                const b0 = 0x80 | ((o >> 8) & 0x7F);
                const b1 = o & 0xFF;
                return new Uint8Array([b0, b1]);
            }
        } else {
            // Wide Slot (4 bytes)
            if (slot.type === 'immediate') {
                // Write 2 bytes data, then 00 00?
                // Spec says: "3- or 4-byte values use less space in a wide collection since they can be inlined."
                // But Small Int is 2 bytes.
                // We'll write the 2 bytes of immediate data, then 2 bytes of padding?
                // Or padding then data?
                // "Values are always 2-byte aligned".
                // If we put 2 bytes at writePos. Then 2 bytes 0.
                // The next value is at writePos+4. Aligned.
                const data = new Uint8Array(4);
                data.set(slot.data, 0); // Copy 2 bytes
                // data[2], data[3] are 0.
                return data;
            } else {
                // Wide Pointer
                const offsetBytes = writePos - slot.target;
                const offsetUnits = offsetBytes / 2;
                const o = offsetUnits;
                // 31-bit offset.
                // 1ooooooo oooooooo oooooooo oooooooo
                const b0 = 0x80 | ((o >> 24) & 0x7F);
                const b1 = (o >> 16) & 0xFF;
                const b2 = (o >> 8) & 0xFF;
                const b3 = o & 0xFF;
                return new Uint8Array([b0, b1, b2, b3]);
            }
        }
    }
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
            // Pointer check
            // If wide context, 4 bytes.
            // If narrow context, 2 bytes.
            // Both have MSB set.

            if ((b0 & 0x80) !== 0) {
                 let offsetBytes = 0;
                 if (this.wide) {
                     // Wide pointer: 4 bytes
                     const b1 = this.buffer[this.pos + 1];
                     const b2 = this.buffer[this.pos + 2];
                     const b3 = this.buffer[this.pos + 3];

                     const o = ((b0 & 0x7F) << 24) | (b1 << 16) | (b2 << 8) | b3;
                     offsetBytes = o * 2;

                     // Target of pointer is NOT in wide context (unless it's another wide collection slot, which it isn't usually).
                     // Pointer points to a Value.
                     // The Value is self-contained.
                     // So we switch wide=false for the next iteration (unless we are just resolving indirection).

                 } else {
                     // Narrow pointer: 2 bytes
                     const b1 = this.buffer[this.pos + 1];
                     const o = ((b0 & 0x7F) << 8) | b1;
                     offsetBytes = o * 2;
                 }

                 if (offsetBytes === 0) throw new Error("Invalid pointer offset 0");
                 this.pos = this.pos - offsetBytes;

                 // Once resolved, we are at the target.
                 // The target is a normal Value.
                 // It is NOT wide (unless it is a slot in a wide array, but pointers point to Values, not slots).
                 // So we reset wide = false.
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
            case 0: // Small Int
            case 1: // Long Int
                return 'number';
            case 2: // Float
                return 'number';
            case 3: // Special
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

    *keys() {
        const slotSize = this.wide ? 4 : 2;
        for (let i = 0; i < this.count; i++) {
            const keySlotPos = this.dataPos + (i * 2 * slotSize);
            const keyVal = new FleeceValue(this.buffer, keySlotPos, this.view, !!this.wide);
            yield keyVal.asString();
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

        // Spec: "If this value is a pointer, dereference it (as a narrow pointer).
        // If *this* value is a pointer, dereference it (as a *wide* pointer)."

        // First resolve (Narrow)
        const root1 = new FleeceValue(this.buffer, pos, this.view, false);

        // Check if root1 resolved to a Wide Pointer
        // We need to inspect the byte at root1.pos to see if it is a pointer.
        // `FleeceValue` constructor already resolved pointers!
        // So `root1.pos` is the target.
        // But did `root1` constructor handle the "double dereference"?
        // `_resolvePointer` loops.
        // Iteration 1: 2-byte pointer (root slot). Resolves to Target1.
        // Iteration 2: Check bytes at Target1.
        // If Target1 is a Wide Pointer (Tag 1xxxxxxx and 4 bytes long).
        // `_resolvePointer` checks `b0 & 0x80`.
        // If it is set, it treats it as Narrow Pointer (unless `wide` param is true).
        // But here `wide` is false.
        // So it treats Target1 as Narrow Pointer.
        // This is WRONG if Target1 is actually a Wide Pointer.

        // So `FleeceValue` is not capable of handling this specific Root Logic automatically.
        // We should handle it manually in `getRoot`.

        // 1. Read root slot manually.
        let p = pos;
        let b0 = this.buffer[p];
        if ((b0 & 0x80) !== 0) {
            // It is a pointer (Narrow).
            let b1 = this.buffer[p+1];
            let o = ((b0 & 0x7F) << 8) | b1;
            p = p - o * 2;

            // 2. Check if the target is a pointer (Wide).
            b0 = this.buffer[p];
            if ((b0 & 0x80) !== 0) {
                 // It is a pointer. Assume Wide for this second hop.
                 // Read 4 bytes.
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

module.exports = { FleeceEncoder, FleeceDecoder, FleeceValue };
