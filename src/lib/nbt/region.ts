/**
 * Anvil / McRegion files (r.<x>.<z>.mca|mcr), 32×32 chunks.
 *
 *   bytes 0..4095     1024 × (offset u24be in 4 KiB sectors, sectorCount u8)   index = x + z*32
 *   bytes 4096..8191  1024 × timestamp i32be
 *   sector data       length i32be (incl. compression byte) | compression u8 | payload
 *
 * Compression ids: 1 gzip, 2 zlib, 3 none (1.15.1+), 4 LZ4 (1.20.5+), 127 custom (named, 24w05a+).
 * If bit 0x80 is set, the payload lives in a sibling file c.<chunkX>.<chunkZ>.mcc (chunks > 1 MiB).
 *
 * Opening only touches the 8 KiB header; chunks are decoded on demand. Saving copies unchanged
 * chunk sectors straight from the original File (Blob slices, zero copy) and only re-encodes edits.
 */
import { gunzip, gzip, deflate, inflate } from './compression';
import { lz4StreamCompress, lz4StreamDecompress } from './lz4';
import { readNbt } from './reader';
import type { NbtRoot } from './types';
import { writeNbt } from './writer';

export const SECTOR = 4096;
export const REGION_NAME = /^r\.(-?\d+)\.(-?\d+)\.(mca|mcr)$/i;
export const MCC_NAME = /^c\.(-?\d+)\.(-?\d+)\.mcc$/i;

export const ChunkCompression = { Gzip: 1, Zlib: 2, None: 3, Lz4: 4, Custom: 127 } as const;
export const EXTERNAL_FLAG = 0x80;

export const COMPRESSION_NAMES: Record<number, string> = { 1: 'gzip', 2: 'zlib', 3: 'none', 4: 'LZ4', 127: 'custom' };

export interface ChunkSlot {
  /** index in the header table (x + z * 32) */
  index: number;
  /** local chunk coordinates 0..31 */
  x: number;
  z: number;
  sectorOffset: number;
  sectorCount: number;
  timestamp: number;
}

export function parseRegionName(name: string): { rx: number; rz: number; ext: string } | null {
  const m = REGION_NAME.exec(name);
  return m ? { rx: Number(m[1]), rz: Number(m[2]), ext: m[3].toLowerCase() } : null;
}

export function parseRegionHeader(header: Uint8Array, fileSize: number): ChunkSlot[] {
  if (header.length < 2 * SECTOR) throw new Error('Region file is smaller than its 8 KiB header');
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const slots: ChunkSlot[] = [];
  const maxSector = Math.ceil(fileSize / SECTOR);
  for (let i = 0; i < 1024; i++) {
    const loc = dv.getUint32(i * 4, false);
    if (loc === 0) continue;
    const sectorOffset = loc >>> 8;
    const sectorCount = loc & 0xff;
    if (sectorOffset < 2 || sectorCount === 0 || sectorOffset >= maxSector) continue; // corrupt/empty entry
    slots.push({
      index: i,
      x: i & 31,
      z: i >> 5,
      sectorOffset,
      sectorCount,
      timestamp: dv.getInt32(SECTOR + i * 4, false),
    });
  }
  return slots;
}

export interface ChunkRecord {
  compressionId: number;
  external: boolean;
  /** compressed payload (empty when external) */
  payload: Uint8Array;
}

/** Parses the bytes starting at a chunk's first sector. */
export function parseChunkRecord(bytes: Uint8Array): ChunkRecord {
  if (bytes.length < 5) throw new Error('Chunk record truncated');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = dv.getInt32(0, false);
  if (length < 1 || length + 4 > bytes.length) throw new Error(`Chunk record has invalid length ${length}`);
  const type = bytes[4];
  return {
    compressionId: type & 0x7f,
    external: (type & EXTERNAL_FLAG) !== 0,
    payload: bytes.subarray(5, 4 + length),
  };
}

export async function decompressChunk(compressionId: number, payload: Uint8Array): Promise<Uint8Array> {
  switch (compressionId) {
    case ChunkCompression.Gzip: return gunzip(payload);
    case ChunkCompression.Zlib: return inflate(payload);
    case ChunkCompression.None: return payload;
    case ChunkCompression.Lz4: return lz4StreamDecompress(payload);
    case ChunkCompression.Custom:
      throw new Error('This chunk uses a custom compression algorithm (id 127) provided by a mod; it cannot be read here.');
    default:
      throw new Error(`Unknown chunk compression id ${compressionId}`);
  }
}

export async function compressChunk(compressionId: number, raw: Uint8Array): Promise<Uint8Array> {
  switch (compressionId) {
    case ChunkCompression.Gzip: return gzip(raw);
    case ChunkCompression.None: return raw;
    case ChunkCompression.Lz4: return lz4StreamCompress(raw);
    case ChunkCompression.Zlib:
    default: return deflate(raw);
  }
}

export async function decodeChunk(compressionId: number, payload: Uint8Array): Promise<NbtRoot> {
  const raw = await decompressChunk(compressionId, payload);
  return readNbt(raw, 'big').root;
}

export interface EncodedChunk {
  /** record bytes to place in the region file: length | type | payload */
  record: Uint8Array;
  /** set when the chunk must be stored in an external .mcc file */
  external: Uint8Array | null;
}

/** Largest record that still fits the 255-sector limit of the location table. */
const MAX_INLINE = 255 * SECTOR - 5;

export async function encodeChunk(root: NbtRoot, compressionId: number): Promise<EncodedChunk> {
  const id = compressionId === ChunkCompression.Custom ? ChunkCompression.Zlib : compressionId;
  const payload = await compressChunk(id, writeNbt(root, 'big'));
  if (payload.length > MAX_INLINE) {
    const record = new Uint8Array(5);
    new DataView(record.buffer).setInt32(0, 1, false);
    record[4] = id | EXTERNAL_FLAG;
    return { record, external: payload };
  }
  const record = new Uint8Array(payload.length + 5);
  new DataView(record.buffer).setInt32(0, payload.length + 1, false);
  record[4] = id;
  record.set(payload, 5);
  return { record, external: null };
}

export interface RegionEntry {
  index: number;
  timestamp: number;
  /** record bytes (any length; padded to sectors here) — a Blob slice of the original file or new bytes */
  data: Blob | Uint8Array;
  /** byte length of `data` */
  size: number;
}

/** Assembles a region file. Unchanged chunks are passed as Blob slices, so no bytes are copied in JS. */
export function buildRegion(entries: RegionEntry[]): Blob {
  const header = new Uint8Array(2 * SECTOR);
  const dv = new DataView(header.buffer);
  const parts: (Blob | Uint8Array)[] = [header];
  let sector = 2;
  const sorted = [...entries].sort((a, b) => a.index - b.index);
  for (const e of sorted) {
    const count = Math.ceil(e.size / SECTOR);
    if (count > 255) throw new Error(`Chunk ${e.index & 31},${e.index >> 5} is too large for an inline region entry`);
    dv.setUint32(e.index * 4, (sector << 8) | count, false);
    dv.setInt32(SECTOR + e.index * 4, e.timestamp, false);
    parts.push(e.data);
    const pad = count * SECTOR - e.size;
    if (pad > 0) parts.push(new Uint8Array(pad));
    sector += count;
  }
  return new Blob(parts as BlobPart[]);
}

export function mccName(rx: number, rz: number, localX: number, localZ: number): string {
  return `c.${rx * 32 + localX}.${rz * 32 + localZ}.mcc`;
}
