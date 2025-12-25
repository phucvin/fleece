const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

        const rootSlot = this.writeValue(value);

        // Ensure root slot is 2-byte aligned relative to the start of buffer.
        // Since we are appending it, we must ensure `pos` is even.
        this.pad();

        // Finalize the root slot at the current position
        const finalized = this.finalizeSlot(rootSlot, this.pos);
        this.writeBytes(finalized);

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
                    // Tag 0. Byte 0 = high. Byte 1 = low.
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
                // Float (Double)
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

            const high3 = (ccc >> 8) & 0x07;
            const low8 = ccc & 0xFF;

            this.writeByte(0x60 | high3);
            this.writeByte(low8);

            if (varintCount) {
                this.writeVarInt(count);
            }

            // We need to write the slots. Each slot is 2 bytes.
            // But pointers in slots are relative to the position of the slot!
            // The slots start at current `this.pos`.
            let currentSlotPos = this.pos;
            for (const slot of slots) {
                const finalized = this.finalizeSlot(slot, currentSlotPos);
                this.writeBytes(finalized);
                currentSlotPos += 2;
            }

            return { type: 'pointer', target: offset };

        } else if (typeof value === 'object') {
            const keys = Object.keys(value).sort();

            // Keys are strings.
            const keySlots = keys.map(k => this.writeValue(k));
            // Values
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

            const high3 = (ccc >> 8) & 0x07;
            const low8 = ccc & 0xFF;

            this.writeByte(0x70 | high3);
            this.writeByte(low8);

            if (varintCount) {
                this.writeVarInt(count);
            }

            let currentSlotPos = this.pos;
            for (let i = 0; i < count; i++) {
                const keyFinalized = this.finalizeSlot(keySlots[i], currentSlotPos);
                this.writeBytes(keyFinalized);
                currentSlotPos += 2;

                const valFinalized = this.finalizeSlot(valSlots[i], currentSlotPos);
                this.writeBytes(valFinalized);
                currentSlotPos += 2;
            }

            return { type: 'pointer', target: offset };
        }

        throw new Error("Unsupported type: " + typeof value);
    }

    finalizeSlot(slot, writePos) {
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
    }
}

class FleeceDecoder {
    constructor(buffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }

    decode() {
        // Find root.
        // Start 2 bytes from end.
        if (this.buffer.length < 2) return undefined;
        let pos = this.buffer.length - 2;

        const rootValue = this.readValue(pos);
        // "If this value is a pointer, dereference it... If *this* value is a pointer..."
        // `readValue` handles pointer dereferencing recursively?
        // No, `readValue` reads a value at `pos`.
        // If `pos` contains a pointer, `readValue` follows it.
        return rootValue;
    }

    readValue(pos) {
        // Read 2 bytes at pos.
        const b0 = this.buffer[pos];
        const b1 = this.buffer[pos + 1];

        const tag = b0 >> 4;

        if (tag === 0) {
            // Small Int
            // 0000iiii iiiiiiii
            const high = b0 & 0x0F;
            const low = b1;
            let val = (high << 8) | low;
            // Sign extend 12-bit
            if (val & 0x800) {
                val = val - 0x1000;
            }
            return val;
        } else if (tag === 1) {
            // Long Int
            // 0001uccc
            const u = (b0 >> 3) & 1;
            const ccc = b0 & 0x07;
            const count = ccc + 1; // bytes of int. Actually `ccc = byte count - 1`.
            // Wait, spec says "ccc = byte count - 1"?
            // "0001uccc ... ccc = byte count - 1".
            // If ccc=0, count=1.
            // If ccc=7, count=8.
            const size = ccc + 1; // Wait, my encoder used ccc=0 for 1 byte. Correct.

            // Value is at pos + 2 (after header).
            // But wait, "Longer strings and integers include a byte count in the 2-byte header".
            // Wait, Long Int header is 1 byte?
            // "0001uccc iiiiiiii..."
            // "0001uccc" is byte 0.
            // What about byte 1?
            // "LE integer follows".
            // Does it follow immediately after byte 0?
            // "Values ... occupy at least two bytes."
            // If header is 1 byte and int is 1 byte. Total 2 bytes. Fits.
            // So int starts at pos + 1.

            const intPos = pos + 1;
            // Read size bytes from intPos. LE.
            let val = 0;
            // Use DataView
            if (size === 1) {
                val = this.view.getInt8(intPos);
                if (u) val = val & 0xFF; // Unsigned? `u` bit.
            } else if (size === 2) {
                val = this.view.getInt16(intPos, true);
                if (u) val = val & 0xFFFF;
            } else if (size === 4) {
                val = this.view.getInt32(intPos, true);
                if (u) val = val >>> 0;
            } else if (size === 8) {
                val = this.view.getBigInt64(intPos, true);
                if (u) val = this.view.getBigUint64(intPos, true);
                // Convert to Number if safe?
                if (val <= Number.MAX_SAFE_INTEGER && val >= Number.MIN_SAFE_INTEGER) {
                    val = Number(val);
                }
            }
            return val;

        } else if (tag === 2) {
            // Float
            // 0010sx--
            const s = (b0 >> 3) & 1;
            // pos+2 is data.
            const dataPos = pos + 2;
            if (s === 0) {
                return this.view.getFloat32(dataPos, true);
            } else {
                return this.view.getFloat64(dataPos, true);
            }
        } else if (tag === 3) {
            // Special
            // 0011ss--
            const s = (b0 >> 2) & 3;
            if (s === 0) return null;
            if (s === 1) return false;
            if (s === 2) return true;
            return undefined;
        } else if (tag === 4) {
            // String
            // 0100cccc
            const cccc = b0 & 0x0F;
            let len = cccc;
            let dataPos = pos + 1;
            if (cccc === 15) {
                // Varint follows
                const { value, length } = this.readVarInt(dataPos);
                len = value;
                dataPos += length;
            }
            // Read bytes
            const bytes = this.buffer.slice(dataPos, dataPos + len);
            return textDecoder.decode(bytes);

        } else if (tag === 5) {
            // Binary
            // 0101cccc
            // Same as string
            const cccc = b0 & 0x0F;
            let len = cccc;
            let dataPos = pos + 1;
            if (cccc === 15) {
                const { value, length } = this.readVarInt(dataPos);
                len = value;
                dataPos += length;
            }
            return this.buffer.slice(dataPos, dataPos + len);

        } else if (tag === 6) {
            // Array
            // 0110wccc
            const w = (b0 >> 3) & 1;
            const ccc = ((b0 & 0x07) << 8) | b1;
            let count = ccc;
            let dataPos = pos + 2;
            if (ccc === 2047) {
                const { value, length } = this.readVarInt(dataPos);
                count = value;
                dataPos += length;
            }

            const res = [];
            for (let i = 0; i < count; i++) {
                // Read slot.
                // Narrow array: 2 bytes.
                // Wide array: 4 bytes.
                let val;
                if (w) {
                    // Wide not supported in encoder, but let's just skip/fail.
                    throw new Error("Wide array decoding not implemented");
                } else {
                    // Recurse?
                    // The slot *is* a value (maybe a pointer).
                    // `readValue(dataPos)` will handle it.
                    // But wait, `readValue` expects `pos` to be the start of the value.
                    // Yes, the slot contains the value.
                    val = this.readValue(dataPos);
                    dataPos += 2;
                }
                res.push(val);
            }
            return res;

        } else if (tag === 7) {
            // Dictionary
            // 0111wccc
            const w = (b0 >> 3) & 1;
            const ccc = ((b0 & 0x07) << 8) | b1;
            let count = ccc;
            let dataPos = pos + 2;
            if (ccc === 2047) {
                const { value, length } = this.readVarInt(dataPos);
                count = value;
                dataPos += length;
            }

            const res = {};
            for (let i = 0; i < count; i++) {
                // Key
                const key = this.readValue(dataPos);
                dataPos += 2; // narrow
                // Value
                const val = this.readValue(dataPos);
                dataPos += 2; // narrow

                res[key] = val;
            }
            return res;

        } else if (tag >= 8) {
            // Pointer
            // 1ooooooo oooooooo
            const o = ((b0 & 0x7F) << 8) | b1;
            if (o === 0) {
                 throw new Error("Invalid pointer offset 0");
            }
            const offsetBytes = o * 2;
            const targetPos = pos - offsetBytes;
            return this.readValue(targetPos);
        }
    }

    readVarInt(pos) {
        let result = 0;
        let shift = 0;
        let length = 0;
        while (true) {
            const b = this.buffer[pos + length];
            length++;
            result |= (b & 0x7F) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7;
        }
        return { value: result, length };
    }
}

module.exports = { FleeceEncoder, FleeceDecoder };
