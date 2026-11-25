import { decodeMutf8, decodeUtf8 } from './mutf8';
import { TagType, type CompoundTag, type Endian, type ListTag, type NbtRoot, type Tag } from './types';

/** Minecraft itself rejects nesting deeper than 512; we allow more but cap to keep recursive consumers safe. */
export const MAX_DEPTH = 2048;

const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class NbtParseError extends Error {
  constructor(message: string, public offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = 'NbtParseError';
  }
}

interface Frame {
  tag: CompoundTag | ListTag;
  /** list only */
  elemType: TagType;
  index: number;
  count: number;
}

/**
 * Iterative (explicit stack) NBT reader. One DataView, one cursor, bulk typed-array copies.
 */
export class NbtReader {
  private dv: DataView;
  private u8: Uint8Array;
  private pos: number;
  private le: boolean;
  private mutf8: boolean;

  constructor(bytes: Uint8Array, endian: Endian = 'big', offset = 0) {
    this.u8 = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
    this.le = endian === 'little';
    // Java Edition uses Modified UTF-8, Bedrock uses plain UTF-8.
    this.mutf8 = !this.le;
  }

  get offset(): number {
    return this.pos;
  }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.u8.length) throw new NbtParseError('Unexpected end of data', this.pos);
  }

  private u8v(): number {
    this.need(1);
    return this.u8[this.pos++];
  }

  private i32(): number {
    this.need(4);
    const v = this.dv.getInt32(this.pos, this.le);
    this.pos += 4;
    return v;
  }

  /**
   * Short strings (compound keys, ids) repeat constantly, so they are interned through a small
   * hash cache: no string building, and repeated keys share one string in memory.
   */
  private cache: (string | undefined)[] = new Array(4096);

  private string(): string {
    this.need(2);
    const len = this.dv.getUint16(this.pos, this.le);
    this.pos += 2;
    this.need(len);
    const start = this.pos;
    const end = start + len;
    this.pos = end;
    const b = this.u8;
    if (len <= 24) {
      let h = len;
      let ascii = true;
      for (let i = start; i < end; i++) {
        const c = b[i];
        if (c >= 0x80) { ascii = false; break; }
        h = Math.imul(h ^ c, 0x01000193);
      }
      if (ascii) {
        const slot = (h ^ (h >>> 15)) & 4095;
        const hit = this.cache[slot];
        if (hit !== undefined && hit.length === len) {
          let same = true;
          for (let i = 0; i < len; i++) if (hit.charCodeAt(i) !== b[start + i]) { same = false; break; }
          if (same) return hit;
        }
        const str = len === 0 ? '' : String.fromCharCode.apply(null, b.subarray(start, end) as unknown as number[]);
        this.cache[slot] = str;
        return str;
      }
    }
    return this.mutf8 ? decodeMutf8(b, start, end) : decodeUtf8(b, start, end);
  }

  private arrayLength(elemSize: number): number {
    const n = this.i32();
    if (n < 0) throw new NbtParseError(`Negative array length ${n}`, this.pos - 4);
    this.need(n * elemSize);
    return n;
  }

  /** Reads a full root: type byte, name, payload. */
  readRoot(): NbtRoot {
    const type = this.u8v() as TagType;
    if (type === TagType.End) throw new NbtParseError('Root tag is TAG_End (empty file?)', this.pos - 1);
    if (type > TagType.LongArray) throw new NbtParseError(`Unknown root tag type ${type}`, this.pos - 1);
    const name = this.string();
    const tag = this.readPayload(type);
    return { name, tag };
  }

  /** Reads a payload of the given type (iteratively for containers). */
  readPayload(rootType: TagType): Tag {
    const stack: Frame[] = [];
    const root = this.begin(rootType, stack);
    while (stack.length > 0) {
      const f = stack[stack.length - 1];
      if (f.tag.type === TagType.List) {
        if (f.index >= f.count) { stack.pop(); continue; }
        f.tag.value[f.index++] = this.begin(f.elemType, stack);
      } else {
        const t = this.u8v() as TagType;
        if (t === TagType.End) { stack.pop(); continue; }
        if (t > TagType.LongArray) throw new NbtParseError(`Unknown tag type ${t}`, this.pos - 1);
        const name = this.string();
        f.tag.value.set(name, this.begin(t, stack));
      }
    }
    return root;
  }

  /** Reads a primitive/array payload or opens a container (pushing a frame). */
  private begin(type: TagType, stack: Frame[]): Tag {
    switch (type) {
      case TagType.Byte:
        this.need(1);
        return { type, value: this.dv.getInt8(this.pos++) };
      case TagType.Short: {
        this.need(2);
        const value = this.dv.getInt16(this.pos, this.le);
        this.pos += 2;
        return { type, value };
      }
      case TagType.Int:
        return { type, value: this.i32() };
      case TagType.Long: {
        this.need(8);
        const value = this.dv.getBigInt64(this.pos, this.le);
        this.pos += 8;
        return { type, value };
      }
      case TagType.Float: {
        this.need(4);
        const value = this.dv.getFloat32(this.pos, this.le);
        this.pos += 4;
        return { type, value };
      }
      case TagType.Double: {
        this.need(8);
        const value = this.dv.getFloat64(this.pos, this.le);
        this.pos += 8;
        return { type, value };
      }
      case TagType.String:
        return { type, value: this.string() };
      case TagType.ByteArray: {
        const n = this.arrayLength(1);
        const value = new Int8Array(n);
        value.set(new Int8Array(this.u8.buffer, this.u8.byteOffset + this.pos, n));
        this.pos += n;
        return { type, value };
      }
      case TagType.IntArray: {
        const n = this.arrayLength(4);
        const value = this.readInt32s(n);
        return { type, value };
      }
      case TagType.LongArray: {
        const n = this.arrayLength(8);
        const value = this.readInt64s(n);
        return { type, value };
      }
      case TagType.List: {
        const elemType = this.u8v() as TagType;
        if (elemType > TagType.LongArray) throw new NbtParseError(`Unknown list element type ${elemType}`, this.pos - 1);
        const count = this.i32();
        if (count < 0) throw new NbtParseError(`Negative list length ${count}`, this.pos - 4);
        // Every element takes at least one byte, except End (which must have count 0, but be lenient).
        if (elemType !== TagType.End && count > this.u8.length - this.pos) {
          throw new NbtParseError(`List length ${count} exceeds remaining data`, this.pos - 4);
        }
        const tag: ListTag = { type, value: new Array(elemType === TagType.End ? 0 : count), elementType: elemType };
        if (elemType !== TagType.End && count > 0) this.push(stack, { tag, elemType, index: 0, count });
        return tag;
      }
      case TagType.Compound: {
        const tag: CompoundTag = { type, value: new Map() };
        this.push(stack, { tag, elemType: TagType.End, index: 0, count: 0 });
        return tag;
      }
      default:
        throw new NbtParseError(`Unknown tag type ${type}`, this.pos);
    }
  }

  private push(stack: Frame[], f: Frame): void {
    if (stack.length >= MAX_DEPTH) throw new NbtParseError(`Nesting deeper than ${MAX_DEPTH}`, this.pos);
    stack.push(f);
  }

  private readInt32s(n: number): Int32Array {
    if (n <= 16) {
      // Small arrays (UUIDs, positions): a plain loop beats the copy + swap setup cost.
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++, this.pos += 4) out[i] = this.dv.getInt32(this.pos, this.le);
      return out;
    }
    const out = new Int32Array(n);
    const bytes = n * 4;
    const dst = new Uint8Array(out.buffer);
    dst.set(this.u8.subarray(this.pos, this.pos + bytes));
    if (this.le !== HOST_LE) {
      for (let i = 0; i < bytes; i += 4) {
        const a = dst[i], b = dst[i + 1];
        dst[i] = dst[i + 3]; dst[i + 1] = dst[i + 2]; dst[i + 2] = b; dst[i + 3] = a;
      }
    }
    this.pos += bytes;
    return out;
  }

  private readInt64s(n: number): BigInt64Array {
    const out = new BigInt64Array(n);
    const bytes = n * 8;
    const dst = new Uint8Array(out.buffer);
    dst.set(this.u8.subarray(this.pos, this.pos + bytes));
    if (this.le !== HOST_LE) {
      for (let i = 0; i < bytes; i += 8) {
        for (let j = 0; j < 4; j++) {
          const t = dst[i + j];
          dst[i + j] = dst[i + 7 - j];
          dst[i + 7 - j] = t;
        }
      }
    }
    this.pos += bytes;
    return out;
  }
}

export function readNbt(bytes: Uint8Array, endian: Endian = 'big', offset = 0): { root: NbtRoot; end: number } {
  const r = new NbtReader(bytes, endian, offset);
  const root = r.readRoot();
  return { root, end: r.offset };
}
