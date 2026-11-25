/**
 * Performance targets from the plan. Timings are logged so `npm run bench` doubles as a benchmark.
 * Limits are generous so slow CI machines don't flake; typical numbers are far lower.
 */
import { describe, expect, it } from 'vitest';
import { readNbt } from '../../src/lib/nbt/reader';
import { writeNbt } from '../../src/lib/nbt/writer';
import { parseNbtFile, serializeNbtFile } from '../../src/lib/nbt/nbtfile';
import { buildRegion, encodeChunk, parseRegionHeader, ChunkCompression, SECTOR, type RegionEntry } from '../../src/lib/nbt/region';
import { compileQuery, searchTree } from '../../src/lib/search/query';
import { TagType, countTags, type CompoundTag, type Tag } from '../../src/lib/nbt/types';

function entityLikeFile(count: number): { name: string; tag: CompoundTag } {
  const items: Tag[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      type: TagType.Compound,
      value: new Map<string, Tag>([
        ['id', { type: TagType.String, value: i % 7 === 0 ? 'minecraft:zombie' : 'minecraft:cow' }],
        ['Health', { type: TagType.Float, value: 20 }],
        ['UUID', { type: TagType.IntArray, value: Int32Array.from([i, -i, i * 3, 7]) }],
        ['Pos', { type: TagType.List, elementType: TagType.Double, value: [{ type: 6, value: i }, { type: 6, value: 64 }, { type: 6, value: -i }] }],
        ['CustomName', { type: TagType.String, value: `Entity number ${i} with ümlaut` }],
        ['Tags', { type: TagType.List, elementType: TagType.String, value: [{ type: 8, value: 'a' }, { type: 8, value: 'b' }] }],
      ]),
    });
  }
  return { name: '', tag: { type: TagType.Compound, value: new Map([['Entities', { type: TagType.List, elementType: TagType.Compound, value: items }]]) } };
}

const time = async <T>(label: string, fn: () => T | Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(44)} ${ms.toFixed(1).padStart(8)} ms`);
  return [r, ms];
};

describe('performance', () => {
  it('parses and writes a ~5 MB NBT file quickly', async () => {
    const root = entityLikeFile(30_000);
    const raw = writeNbt(root);
    console.log(`uncompressed size: ${(raw.length / 1024 / 1024).toFixed(2)} MB, ${countTags(root.tag).toLocaleString()} tags`);
    expect(raw.length).toBeGreaterThan(4 * 1024 * 1024);
    readNbt(raw); // warm-up
    const [, parseMs] = await time('parse 5 MB (uncompressed)', () => readNbt(raw));
    const [, writeMs] = await time('write 5 MB (uncompressed)', () => writeNbt(root, 'big', raw.length));
    const gz = await serializeNbtFile(root, { compression: 'gzip', endian: 'big', bedrockHeader: null });
    await time('gunzip + parse (level.dat style)', () => parseNbtFile(gz));
    const [, searchMs] = await time('search all values for "zombie"', () => {
      const m = compileQuery({ kind: 'quick', name: '', value: 'zombie', mode: 'contains', caseSensitive: false });
      let n = 0;
      for (const h of searchTree(root.tag, m)) if (h) n++;
      return n;
    });
    expect(parseMs).toBeLessThan(400);
    expect(writeMs).toBeLessThan(400);
    expect(searchMs).toBeLessThan(800);
  });

  it('opens a full region file by reading only its header', async () => {
    const entries: RegionEntry[] = [];
    const chunk = await encodeChunk(entityLikeFile(40), ChunkCompression.Zlib);
    for (let i = 0; i < 1024; i++) entries.push({ index: i, timestamp: i, data: chunk.record, size: chunk.record.length });
    const blob = buildRegion(entries);
    console.log(`region size: ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
    const [slots, ms] = await time('open region (header only)', async () => {
      const header = new Uint8Array(await blob.slice(0, 2 * SECTOR).arrayBuffer());
      return parseRegionHeader(header, blob.size);
    });
    expect(slots).toHaveLength(1024);
    expect(ms).toBeLessThan(50);
  });
});
