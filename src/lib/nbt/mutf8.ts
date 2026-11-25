/**
 * Java "Modified UTF-8" as used by DataInput/DataOutput (and therefore Java Edition NBT):
 *  - U+0000 is encoded as the two bytes C0 80
 *  - characters outside the BMP are encoded as two 3-byte surrogates (ED Ax xx ED Bx xx)
 * Everything else is identical to UTF-8, so when neither C0 nor ED appears we can use the
 * native TextDecoder, and for short ASCII strings a plain char-code loop is fastest.
 */

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

export function decodeMutf8(bytes: Uint8Array, start: number, end: number): string {
  const len = end - start;
  if (len === 0) return '';
  let ascii = true;
  let special = false;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b >= 0x80) {
      ascii = false;
      if (b === 0xc0 || b === 0xed) { special = true; break; }
    }
  }
  if (ascii) {
    if (len < 128) return String.fromCharCode.apply(null, bytes.subarray(start, end) as unknown as number[]);
    return utf8Decoder.decode(bytes.subarray(start, end));
  }
  if (!special) return utf8Decoder.decode(bytes.subarray(start, end));
  return decodeMutf8Slow(bytes, start, end);
}

function decodeMutf8Slow(bytes: Uint8Array, start: number, end: number): string {
  const units: number[] = [];
  let i = start;
  while (i < end) {
    const a = bytes[i++];
    if (a < 0x80) {
      units.push(a);
    } else if ((a & 0xe0) === 0xc0 && i < end) {
      const b = bytes[i++];
      units.push(((a & 0x1f) << 6) | (b & 0x3f));
    } else if ((a & 0xf0) === 0xe0 && i + 1 < end) {
      const b = bytes[i++];
      const c = bytes[i++];
      units.push(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
    } else if ((a & 0xf8) === 0xf0 && i + 2 < end) {
      // Not valid MUTF-8, but some third-party tools write standard 4-byte UTF-8. Be lenient.
      const cp = ((a & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      i += 3;
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      units.push(0xfffd);
    }
  }
  let s = '';
  for (let k = 0; k < units.length; k += 4096) s += String.fromCharCode(...units.slice(k, k + 4096));
  return s;
}

/** Returns the MUTF-8 byte length of a string. */
export function mutf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0 && c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else n += 3;
  }
  return n;
}

/** True if the string is pure 7-bit ASCII without NUL (byte-identical in MUTF-8, UTF-8 and Latin-1). */
export function isPlainAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0 || c >= 0x80) return false;
  }
  return true;
}

/** Writes MUTF-8 bytes of `s` into `out` at `pos`, returns new position. */
export function writeMutf8(s: string, out: Uint8Array, pos: number): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0 && c < 0x80) {
      out[pos++] = c;
    } else if (c < 0x800) {
      out[pos++] = 0xc0 | (c >> 6);
      out[pos++] = 0x80 | (c & 0x3f);
    } else {
      out[pos++] = 0xe0 | (c >> 12);
      out[pos++] = 0x80 | ((c >> 6) & 0x3f);
      out[pos++] = 0x80 | (c & 0x3f);
    }
  }
  return pos;
}

/** Standard UTF-8 (Bedrock Edition strings). */
export function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  if (end - start < 64) {
    let ascii = true;
    for (let i = start; i < end; i++) if (bytes[i] >= 0x80) { ascii = false; break; }
    if (ascii) {
      let s = '';
      for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }
  return utf8Decoder.decode(bytes.subarray(start, end));
}

export function encodeUtf8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}
