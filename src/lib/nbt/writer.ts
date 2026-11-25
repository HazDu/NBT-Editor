import { encodeUtf8, isPlainAscii, writeMutf8, mutf8Length } from './mutf8';
import { TagType, type Endian, type NbtRoot, type Tag } from './types';

const HOST_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Growable-buffer NBT writer. Starts with a size estimate and doubles when needed, so a save is a
 * single traversal; arrays are written with bulk copies (+ byte swap when endianness differs).
 */
export class NbtWriter {
  private buf: Uint8Array;
  private dv: DataView;
  private pos = 0;
  private le: boolean;
  private mutf8: boolean;

  constructor(endian: Endian = 'big', initialSize = 64 * 1024) {
    this.le = endian === 'little';
    this.mutf8 = !this.le;
    this.buf = new Uint8Array(initialSize);
    this.dv = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v;
  }

  i32(v: number): void {
    this.ensure(4);
    this.dv.setInt32(this.pos, v, this.le);
    this.pos += 4;
  }

  string(s: string): void {
    if (isPlainAscii(s)) {
      const n = s.length;
      if (n > 0xffff) throw new Error(`String too long for NBT (${n} bytes)`);
      this.ensure(2 + n);
      this.dv.setUint16(this.pos, n, this.le);
      this.pos += 2;
      for (let i = 0; i < n; i++) this.buf[this.pos++] = s.charCodeAt(i);
      return;
    }
    if (this.mutf8) {
      const n = mutf8Length(s);
      if (n > 0xffff) throw new Error(`String too long for NBT (${n} bytes)`);
      this.ensure(2 + n);
      this.dv.setUint16(this.pos, n, this.le);
      this.pos = writeMutf8(s, this.buf, this.pos + 2);
    } else {
      const bytes = encodeUtf8(s);
      if (bytes.length > 0xffff) throw new Error(`String too long for NBT (${bytes.length} bytes)`);
      this.ensure(2 + bytes.length);
      this.dv.setUint16(this.pos, bytes.length, this.le);
      this.buf.set(bytes, this.pos + 2);
      this.pos += 2 + bytes.length;
    }
  }

  root(root: NbtRoot): void {
    this.u8(root.tag.type);
    this.string(root.name);
    this.payload(root.tag);
  }

  payload(tag: Tag): void {
    switch (tag.type) {
      case TagType.Byte:
        this.ensure(1);
        this.dv.setInt8(this.pos++, tag.value);
        return;
      case TagType.Short:
        this.ensure(2);
        this.dv.setInt16(this.pos, tag.value, this.le);
        this.pos += 2;
        return;
      case TagType.Int:
        this.i32(tag.value);
        return;
      case TagType.Long:
        this.ensure(8);
        this.dv.setBigInt64(this.pos, tag.value, this.le);
        this.pos += 8;
        return;
      case TagType.Float:
        this.ensure(4);
        this.dv.setFloat32(this.pos, tag.value, this.le);
        this.pos += 4;
        return;
      case TagType.Double:
        this.ensure(8);
        this.dv.setFloat64(this.pos, tag.value, this.le);
        this.pos += 8;
        return;
      case TagType.String:
        this.string(tag.value);
        return;
      case TagType.ByteArray:
        this.i32(tag.value.length);
        this.ensure(tag.value.length);
        this.buf.set(new Uint8Array(tag.value.buffer, tag.value.byteOffset, tag.value.length), this.pos);
        this.pos += tag.value.length;
        return;
      case TagType.IntArray:
        this.i32(tag.value.length);
        this.bulk(new Uint8Array(tag.value.buffer, tag.value.byteOffset, tag.value.byteLength), 4);
        return;
      case TagType.LongArray:
        this.i32(tag.value.length);
        this.bulk(new Uint8Array(tag.value.buffer, tag.value.byteOffset, tag.value.byteLength), 8);
        return;
      case TagType.List: {
        const items = tag.value;
        // An empty list keeps its declared element type (Minecraft writes End for empty lists).
        const elemType = items.length === 0 ? tag.elementType : items[0].type;
        this.u8(elemType);
        this.i32(items.length);
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type !== elemType) throw new Error(`List contains mixed types (${elemType} and ${item.type})`);
          this.payload(item);
        }
        return;
      }
      case TagType.Compound:
        for (const [name, child] of tag.value) {
          this.u8(child.type);
          this.string(name);
          this.payload(child);
        }
        this.u8(TagType.End);
        return;
    }
  }

  private bulk(src: Uint8Array, width: number): void {
    this.ensure(src.length);
    const dst = this.buf;
    const p = this.pos;
    dst.set(src, p);
    if (this.le !== HOST_LE) {
      for (let i = 0; i < src.length; i += width) {
        for (let j = 0; j < width >> 1; j++) {
          const t = dst[p + i + j];
          dst[p + i + j] = dst[p + i + width - 1 - j];
          dst[p + i + width - 1 - j] = t;
        }
      }
    }
    this.pos += src.length;
  }
}

export function writeNbt(root: NbtRoot, endian: Endian = 'big', sizeHint?: number): Uint8Array {
  const w = new NbtWriter(endian, Math.max(1024, sizeHint ?? 64 * 1024));
  w.root(root);
  return w.result();
}
