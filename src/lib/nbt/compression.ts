/**
 * gzip / zlib through the platform's native Compression Streams API (runs off the JS thread,
 * no library). Works in all evergreen browsers and in Node 18+.
 */
import type { Compression } from './types';

async function pipe(data: Uint8Array | Blob, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = data instanceof Blob ? data.stream() : new Blob([data as BlobPart]).stream();
  const buf = await new Response(source.pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer();
  return new Uint8Array(buf);
}

export function gunzip(data: Uint8Array | Blob): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('gzip'));
}

export function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('gzip'));
}

/** zlib-wrapped deflate (RFC 1950), which the Compression Streams API calls "deflate". */
export function inflate(data: Uint8Array | Blob): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate'));
}

export function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate'));
}

export function isGzip(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

export function isZlib(b: Uint8Array): boolean {
  return b.length >= 2 && (b[0] & 0x0f) === 8 && ((b[0] << 8) | b[1]) % 31 === 0;
}

export async function decompress(data: Uint8Array, kind: Compression): Promise<Uint8Array> {
  if (kind === 'gzip') return gunzip(data);
  if (kind === 'zlib') return inflate(data);
  return data;
}

export async function compress(data: Uint8Array, kind: Compression): Promise<Uint8Array> {
  if (kind === 'gzip') return gzip(data);
  if (kind === 'zlib') return deflate(data);
  return data;
}
