/**
 * Standalone NBT files: format sniffing by magic bytes (instead of the old try-gzip-then-fallback),
 * Java (big-endian, MUTF-8) vs Bedrock (little-endian, UTF-8, optional 8-byte level.dat header).
 */
import { compress, decompress, isGzip, isZlib } from './compression';
import { NbtParseError, readNbt } from './reader';
import { TagType, type Compression, type Endian, type NbtRoot } from './types';
import { writeNbt } from './writer';

export interface NbtFormat {
  compression: Compression;
  endian: Endian;
  /** Bedrock level.dat: 8-byte header (storage version i32le + payload length i32le). */
  bedrockHeader: { version: number } | null;
}

export interface ParsedNbtFile {
  root: NbtRoot;
  format: NbtFormat;
  /** uncompressed payload size, used as size hint for writing */
  rawSize: number;
}

function hasBedrockHeader(b: Uint8Array): boolean {
  if (b.length < 9) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const len = dv.getInt32(4, true);
  return len === b.length - 8 && (b[8] === TagType.Compound || b[8] === TagType.List);
}

/**
 * Guess endianness of raw NBT from the root name length and the first child header.
 * Returns the more plausible order first.
 */
export function guessEndian(b: Uint8Array, offset = 0): Endian[] {
  if (b.length < offset + 3) return ['big', 'little'];
  const be = (b[offset + 1] << 8) | b[offset + 2];
  const le = b[offset + 1] | (b[offset + 2] << 8);
  if (be !== le) {
    const remaining = b.length - offset - 3;
    const beOk = be <= remaining;
    const leOk = le <= remaining;
    if (beOk && !leOk) return ['big', 'little'];
    if (leOk && !beOk) return ['little', 'big'];
    return be < le ? ['big', 'little'] : ['little', 'big'];
  }
  // Equal (typically an empty root name): look at the first child's name length.
  const p = offset + 3 + be;
  if (b.length >= p + 3 && b[offset] === TagType.Compound) {
    const cbe = (b[p + 1] << 8) | b[p + 2];
    const cle = b[p + 1] | (b[p + 2] << 8);
    if (cbe !== cle) return cbe < cle ? ['big', 'little'] : ['little', 'big'];
  }
  return ['big', 'little'];
}

function parseRaw(raw: Uint8Array, preferLittle: boolean): { root: NbtRoot; endian: Endian } {
  let order = guessEndian(raw);
  if (preferLittle && order[0] === 'big') order = ['little', 'big'];
  let firstError: unknown;
  for (const endian of order) {
    try {
      const { root } = readNbt(raw, endian);
      return { root, endian };
    } catch (e) {
      firstError ??= e;
    }
  }
  throw firstError;
}

export async function parseNbtFile(bytes: Uint8Array, fileName = ''): Promise<ParsedNbtFile> {
  const lower = fileName.toLowerCase();
  const preferLittle = lower.endsWith('.mcstructure');
  let compression: Compression = 'none';
  let raw = bytes;
  if (isGzip(bytes)) {
    compression = 'gzip';
    raw = await decompress(bytes, 'gzip');
  } else if (isZlib(bytes) && bytes[0] !== TagType.Compound) {
    compression = 'zlib';
    raw = await decompress(bytes, 'zlib');
  }

  if (compression === 'none' && hasBedrockHeader(raw)) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const version = dv.getInt32(0, true);
    const { root } = readNbt(raw, 'little', 8);
    return { root, format: { compression, endian: 'little', bedrockHeader: { version } }, rawSize: raw.length };
  }

  if (raw.length === 0) throw new NbtParseError('File is empty', 0);
  if (raw[0] !== TagType.Compound && raw[0] !== TagType.List) {
    throw new NbtParseError(`Not an NBT file (starts with byte 0x${raw[0].toString(16).padStart(2, '0')})`, 0);
  }
  const { root, endian } = parseRaw(raw, preferLittle);
  return { root, format: { compression, endian, bedrockHeader: null }, rawSize: raw.length };
}

export async function serializeNbtFile(root: NbtRoot, format: NbtFormat, sizeHint?: number): Promise<Uint8Array> {
  const payload = writeNbt(root, format.endian, sizeHint);
  if (format.bedrockHeader) {
    const out = new Uint8Array(payload.length + 8);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, format.bedrockHeader.version, true);
    dv.setInt32(4, payload.length, true);
    out.set(payload, 8);
    return out;
  }
  return compress(payload, format.compression);
}

export function describeFormat(f: NbtFormat): string {
  const ed = f.endian === 'little' ? 'Bedrock · LE' : 'Java · BE';
  const comp = f.compression === 'none' ? 'uncompressed' : f.compression;
  return `${ed} · ${comp}${f.bedrockHeader ? ` · header v${f.bedrockHeader.version}` : ''}`;
}
