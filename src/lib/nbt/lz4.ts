/**
 * LZ4 as used by Minecraft 1.20.5+ region files (compression id 4).
 *
 * Minecraft wraps chunk data with lz4-java's LZ4BlockOutputStream, which is NOT the standard
 * LZ4 frame format. Each block is:
 *   "LZ4Block" (8 bytes) | token (method | level) | compressedLen i32le | rawLen i32le | checksum i32le | data
 * method 0x10 = raw (stored), 0x20 = LZ4 block. The stream ends with an empty raw block.
 * checksum = XXH32(raw, seed 0x9747b28c) & 0x0FFFFFFF (lz4-java's StreamingXXHash32.asChecksum()).
 */

const MAGIC = [0x4c, 0x5a, 0x34, 0x42, 0x6c, 0x6f, 0x63, 0x6b]; // "LZ4Block"
const HEADER = 8 + 1 + 4 + 4 + 4;
const METHOD_RAW = 0x10;
const METHOD_LZ4 = 0x20;
const SEED = 0x9747b28c;
const BLOCK_SIZE = 1 << 16; // lz4-java default
const LEVEL = 16 - 10; // log2(BLOCK_SIZE) - COMPRESSION_LEVEL_BASE

// ---------------------------------------------------------------------------------------- xxHash32
const P1 = 0x9e3779b1, P2 = 0x85ebca77, P3 = 0xc2b2ae3d, P4 = 0x27d4eb2f, P5 = 0x165667b1;
const rotl = (x: number, r: number) => (x << r) | (x >>> (32 - r));
const rd32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

export function xxh32(b: Uint8Array, seed = 0, start = 0, end = b.length): number {
  let i = start;
  const len = end - start;
  let h: number;
  if (len >= 16) {
    let v1 = (seed + P1 + P2) | 0, v2 = (seed + P2) | 0, v3 = seed | 0, v4 = (seed - P1) | 0;
    const limit = end - 16;
    while (i <= limit) {
      v1 = Math.imul(rotl((v1 + Math.imul(rd32(b, i), P2)) | 0, 13), P1); i += 4;
      v2 = Math.imul(rotl((v2 + Math.imul(rd32(b, i), P2)) | 0, 13), P1); i += 4;
      v3 = Math.imul(rotl((v3 + Math.imul(rd32(b, i), P2)) | 0, 13), P1); i += 4;
      v4 = Math.imul(rotl((v4 + Math.imul(rd32(b, i), P2)) | 0, 13), P1); i += 4;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    h = (seed + P5) | 0;
  }
  h = (h + len) | 0;
  while (i + 4 <= end) {
    h = Math.imul(rotl((h + Math.imul(rd32(b, i), P3)) | 0, 17), P4);
    i += 4;
  }
  while (i < end) {
    h = Math.imul(rotl((h + Math.imul(b[i], P5)) | 0, 11), P1);
    i++;
  }
  h ^= h >>> 15; h = Math.imul(h, P2);
  h ^= h >>> 13; h = Math.imul(h, P3);
  h ^= h >>> 16;
  return h >>> 0;
}

// ------------------------------------------------------------------------------------ LZ4 block
export function lz4BlockDecompress(src: Uint8Array, sStart: number, sEnd: number, dst: Uint8Array, dStart: number): number {
  let s = sStart, d = dStart;
  while (s < sEnd) {
    const token = src[s++];
    let lit = token >>> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    dst.set(src.subarray(s, s + lit), d);
    s += lit; d += lit;
    if (s >= sEnd) break; // last sequence has literals only
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0) throw new Error('LZ4: invalid offset 0');
    let ml = token & 15;
    if (ml === 15) { let b; do { b = src[s++]; ml += b; } while (b === 255); }
    ml += 4;
    let m = d - offset;
    if (m < dStart) throw new Error('LZ4: offset out of range');
    // Overlapping copy must go byte by byte.
    for (let k = 0; k < ml; k++) dst[d++] = dst[m++];
  }
  return d - dStart;
}

/** Greedy hash-chain-free LZ4 block compressor (same algorithm family as LZ4 "fast"). */
export function lz4BlockCompress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 16);
  let o = 0;
  const MIN_MATCH = 4, MFLIMIT = 12, LAST_LITERALS = 5;
  const table = new Int32Array(1 << 16).fill(-1);
  const hash = (i: number) => (Math.imul(rd32(src, i), 2654435761) >>> 16) & 0xffff;
  let anchor = 0;
  let i = 0;
  const matchLimit = n - MFLIMIT;

  const writeLen = (len: number) => {
    while (len >= 255) { out[o++] = 255; len -= 255; }
    out[o++] = len;
  };

  if (n >= MFLIMIT + 1) {
    while (i < matchLimit) {
      const h = hash(i);
      const ref = table[h];
      table[h] = i;
      if (ref < 0 || i - ref > 0xffff || rd32(src, ref) !== rd32(src, i)) { i++; continue; }
      // extend match forward
      let ml = MIN_MATCH;
      const maxEnd = n - LAST_LITERALS;
      while (i + ml < maxEnd && src[ref + ml] === src[i + ml]) ml++;
      const lit = i - anchor;
      const tokenPos = o++;
      let token = (lit >= 15 ? 15 : lit) << 4;
      if (lit >= 15) writeLen(lit - 15);
      out.set(src.subarray(anchor, i), o); o += lit;
      const off = i - ref;
      out[o++] = off & 0xff; out[o++] = off >>> 8;
      const mlx = ml - MIN_MATCH;
      token |= mlx >= 15 ? 15 : mlx;
      if (mlx >= 15) writeLen(mlx - 15);
      out[tokenPos] = token;
      i += ml;
      anchor = i;
    }
  }
  // last literals
  const lit = n - anchor;
  out[o++] = (lit >= 15 ? 15 : lit) << 4;
  if (lit >= 15) writeLen(lit - 15);
  out.set(src.subarray(anchor), o); o += lit;
  return out.subarray(0, o);
}

// ------------------------------------------------------------------- lz4-java block stream format
const rdI32 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
function wrI32(b: Uint8Array, i: number, v: number) {
  b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff; b[i + 2] = (v >>> 16) & 0xff; b[i + 3] = (v >>> 24) & 0xff;
}

export function isLz4BlockStream(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== MAGIC[i]) return false;
  return true;
}

export function lz4StreamDecompress(src: Uint8Array, verify = true): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let p = 0;
  while (p + HEADER <= src.length) {
    for (let k = 0; k < 8; k++) if (src[p + k] !== MAGIC[k]) throw new Error('LZ4Block: bad magic');
    const token = src[p + 8];
    const method = token & 0xf0;
    const clen = rdI32(src, p + 9);
    const rlen = rdI32(src, p + 13);
    const check = rdI32(src, p + 17);
    p += HEADER;
    if (rlen === 0) break; // end-of-stream marker
    if (clen < 0 || rlen < 0 || p + clen > src.length) throw new Error('LZ4Block: corrupt header');
    let block: Uint8Array;
    if (method === METHOD_RAW) {
      block = src.slice(p, p + clen);
    } else if (method === METHOD_LZ4) {
      block = new Uint8Array(rlen);
      const got = lz4BlockDecompress(src, p, p + clen, block, 0);
      if (got !== rlen) throw new Error('LZ4Block: length mismatch');
    } else {
      throw new Error(`LZ4Block: unknown method ${method}`);
    }
    if (verify && ((xxh32(block, SEED) & 0x0fffffff) | 0) !== (check & 0x0fffffff)) {
      throw new Error('LZ4Block: checksum mismatch');
    }
    parts.push(block);
    total += rlen;
    p += clen;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

export function lz4StreamCompress(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const header = (method: number, clen: number, rlen: number, check: number) => {
    const h = new Uint8Array(HEADER);
    h.set(MAGIC, 0);
    h[8] = method | LEVEL;
    wrI32(h, 9, clen); wrI32(h, 13, rlen); wrI32(h, 17, check);
    return h;
  };
  for (let off = 0; off < data.length; off += BLOCK_SIZE) {
    const raw = data.subarray(off, Math.min(off + BLOCK_SIZE, data.length));
    const check = xxh32(raw, SEED) & 0x0fffffff;
    const comp = lz4BlockCompress(raw);
    const useRaw = comp.length >= raw.length;
    const body = useRaw ? raw : comp;
    const h = header(useRaw ? METHOD_RAW : METHOD_LZ4, body.length, raw.length, check);
    chunks.push(h, body);
    total += h.length + body.length;
  }
  const end = header(METHOD_RAW, 0, 0, 0);
  chunks.push(end);
  total += end.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
