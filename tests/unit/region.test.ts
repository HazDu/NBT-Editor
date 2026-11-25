import { describe, expect, it } from 'vitest';
import {
  buildRegion, decodeChunk, encodeChunk, parseChunkRecord, parseRegionHeader, ChunkCompression, SECTOR, type RegionEntry,
} from '../../src/lib/nbt/region';
import { tagEquals, TagType } from '../../src/lib/nbt/types';
import { c, int, str } from './helpers';

function chunkRoot(x: number, z: number) {
  return {
    name: '',
    tag: c({ DataVersion: int(3953), xPos: int(x), zPos: int(z), Status: str('minecraft:full'), sections: { type: TagType.List, elementType: 0, value: [] } }),
  };
}

describe('region files', () => {
  it('writes and reads chunks with every compression scheme', async () => {
    const schemes = [ChunkCompression.Gzip, ChunkCompression.Zlib, ChunkCompression.None, ChunkCompression.Lz4];
    const entries: RegionEntry[] = [];
    for (let i = 0; i < schemes.length; i++) {
      const enc = await encodeChunk(chunkRoot(i, 0), schemes[i]);
      entries.push({ index: i, timestamp: 1000 + i, data: enc.record, size: enc.record.length });
    }
    const blob = buildRegion(entries);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length % SECTOR).toBe(0);
    const slots = parseRegionHeader(bytes.subarray(0, 2 * SECTOR), bytes.length);
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(slots[3].timestamp).toBe(1003);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const rec = parseChunkRecord(bytes.subarray(s.sectorOffset * SECTOR, (s.sectorOffset + s.sectorCount) * SECTOR));
      expect(rec.compressionId).toBe(schemes[i]);
      const root = await decodeChunk(rec.compressionId, rec.payload);
      expect(tagEquals(root.tag, chunkRoot(i, 0).tag)).toBe(true);
    }
  });

  it('copies unchanged chunks byte for byte from Blob slices', async () => {
    const enc = await encodeChunk(chunkRoot(5, 5), ChunkCompression.Zlib);
    const original = new Uint8Array(await buildRegion([{ index: 165, timestamp: 7, data: enc.record, size: enc.record.length }]).arrayBuffer());
    const file = new Blob([original]);
    const [slot] = parseRegionHeader(original.subarray(0, 2 * SECTOR), original.length);
    const slice = file.slice(slot.sectorOffset * SECTOR, (slot.sectorOffset + slot.sectorCount) * SECTOR);
    const rebuilt = new Uint8Array(await buildRegion([{ index: slot.index, timestamp: slot.timestamp, data: slice, size: slice.size }]).arrayBuffer());
    expect(rebuilt).toEqual(original);
  });

  it('marks oversized chunks as external (.mcc)', async () => {
    const huge = new Int8Array(1_200_000);
    for (let i = 0; i < huge.length; i++) huge[i] = (Math.imul(i, 2654435761) >>> 11) & 0xff;
    const enc = await encodeChunk({ name: '', tag: c({ data: { type: TagType.ByteArray, value: huge } }) }, ChunkCompression.None);
    expect(enc.external).not.toBeNull();
    expect(enc.record.length).toBe(5);
    expect(enc.record[4]).toBe(ChunkCompression.None | 0x80);
  });
});
