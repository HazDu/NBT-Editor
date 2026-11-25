import { describe, expect, it } from 'vitest';
import { readNbt } from '../../src/lib/nbt/reader';
import { writeNbt } from '../../src/lib/nbt/writer';
import { decodeMutf8, writeMutf8, mutf8Length } from '../../src/lib/nbt/mutf8';
import { parseNbtFile, serializeNbtFile } from '../../src/lib/nbt/nbtfile';
import { lz4StreamCompress, lz4StreamDecompress, xxh32 } from '../../src/lib/nbt/lz4';
import { parseSnbt, toSnbt, makeList } from '../../src/lib/nbt/snbt';
import { tagEquals, TagType, cloneTag, type Tag, type ListTag } from '../../src/lib/nbt/types';
import { describeDataVersion } from '../../src/lib/nbt/dataversion';
import { parsePrimitive, formatPath } from '../../src/lib/nbt/format';
import { sampleRoot, c, int } from './helpers';

describe('MUTF-8', () => {
  it('encodes NUL as C0 80 and supplementary chars as surrogate pairs', () => {
    const s = 'a\u0000🔥';
    const out = new Uint8Array(mutf8Length(s));
    writeMutf8(s, out, 0);
    expect(Array.from(out.slice(0, 3))).toEqual([0x61, 0xc0, 0x80]);
    expect(out.length).toBe(1 + 2 + 6);
    expect(out[3]).toBe(0xed);
    expect(decodeMutf8(out, 0, out.length)).toBe(s);
  });
  it('decodes plain UTF-8 multi-byte text via the fast path', () => {
    const bytes = new TextEncoder().encode('Grüße');
    expect(decodeMutf8(bytes, 0, bytes.length)).toBe('Grüße');
  });
});

describe('binary NBT', () => {
  for (const endian of ['big', 'little'] as const) {
    it(`round-trips every tag type byte-identically (${endian})`, () => {
      const root = sampleRoot();
      const bytes = writeNbt(root, endian);
      const { root: back, end } = readNbt(bytes, endian);
      expect(end).toBe(bytes.length);
      expect(back.name).toBe('Data');
      expect(tagEquals(back.tag, root.tag)).toBe(true);
      expect(writeNbt(back, endian)).toEqual(bytes);
    });
  }

  it('keeps compound key order', () => {
    const bytes = writeNbt(sampleRoot());
    const { root } = readNbt(bytes);
    expect([...(root.tag as { value: Map<string, Tag> }).value.keys()].slice(0, 3)).toEqual(['byte', 'short', 'int']);
  });

  it('parses deep nesting without recursion overflow', () => {
    let tag: Tag = int(1);
    for (let i = 0; i < 1500; i++) tag = { type: TagType.List, elementType: tag.type, value: [tag] } as ListTag;
    // Writer is recursive, but 1500 levels is fine; the reader must be iterative.
    const bytes = writeNbt({ name: '', tag: c({ deep: tag }) });
    const { root } = readNbt(bytes);
    expect(tagEquals(root.tag, c({ deep: tag }))).toBe(true);
  });

  it('rejects truncated data with a useful error', () => {
    const bytes = writeNbt(sampleRoot());
    expect(() => readNbt(bytes.slice(0, bytes.length - 5))).toThrow(/Unexpected end/);
  });

  it('handles a 1M element long array quickly', () => {
    const arr = new BigInt64Array(1_000_000);
    for (let i = 0; i < arr.length; i++) arr[i] = BigInt(i) * 1234567n;
    const root = { name: '', tag: c({ a: { type: TagType.LongArray, value: arr } }) };
    const t0 = performance.now();
    const bytes = writeNbt(root);
    const back = readNbt(bytes).root;
    const ms = performance.now() - t0;
    expect(tagEquals(back.tag, root.tag)).toBe(true);
    expect(ms).toBeLessThan(1000);
  });
});

describe('file formats', () => {
  it('detects gzip and round-trips', async () => {
    const root = sampleRoot();
    const file = await serializeNbtFile(root, { compression: 'gzip', endian: 'big', bedrockHeader: null });
    expect(file[0]).toBe(0x1f);
    const parsed = await parseNbtFile(file);
    expect(parsed.format.compression).toBe('gzip');
    expect(parsed.format.endian).toBe('big');
    expect(tagEquals(parsed.root.tag, root.tag)).toBe(true);
  });

  it('detects zlib', async () => {
    const file = await serializeNbtFile(sampleRoot(), { compression: 'zlib', endian: 'big', bedrockHeader: null });
    const parsed = await parseNbtFile(file);
    expect(parsed.format.compression).toBe('zlib');
  });

  it('detects uncompressed little-endian (Bedrock .mcstructure)', async () => {
    const root = { name: '', tag: c({ format_version: int(1), size: { type: TagType.List, elementType: 3, value: [int(1), int(2), int(3)] } as Tag }) };
    const bytes = writeNbt(root, 'little');
    const parsed = await parseNbtFile(bytes, 'house.mcstructure');
    expect(parsed.format.endian).toBe('little');
    expect(tagEquals(parsed.root.tag, root.tag)).toBe(true);
  });

  it('detects and preserves the Bedrock level.dat header', async () => {
    const root = { name: '', tag: c({ LevelName: { type: 8, value: 'My World' }, StorageVersion: int(10) }) };
    const fmt = { compression: 'none' as const, endian: 'little' as const, bedrockHeader: { version: 10 } };
    const file = await serializeNbtFile(root, fmt);
    const parsed = await parseNbtFile(file, 'level.dat');
    expect(parsed.format.bedrockHeader).toEqual({ version: 10 });
    expect(await serializeNbtFile(parsed.root, parsed.format)).toEqual(file);
  });

  it('rejects non-NBT data', async () => {
    await expect(parseNbtFile(new TextEncoder().encode('hello world'))).rejects.toThrow(/Not an NBT file/);
  });
});

describe('LZ4 (lz4-java block stream)', () => {
  it('xxh32 matches reference vectors', () => {
    expect(xxh32(new Uint8Array(0), 0)).toBe(0x02cc5d05);
    expect(xxh32(new TextEncoder().encode('a'), 0)).toBe(0x550d7456);
    expect(xxh32(new TextEncoder().encode('abc'), 0)).toBe(0x32d153ff);
    expect(xxh32(new TextEncoder().encode('Nobody inspects the spammish repetition'), 0)).toBe(0xe2293b2f);
  });

  it('round-trips compressible and incompressible data across block boundaries', () => {
    const text = writeNbt(sampleRoot());
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = text[i % text.length];
    const rnd = new Uint8Array(70_000);
    for (let i = 0; i < rnd.length; i++) rnd[i] = (Math.imul(i, 2654435761) >>> 13) & 0xff;
    for (const data of [big, rnd, new Uint8Array(0), new Uint8Array([1, 2, 3])]) {
      const comp = lz4StreamCompress(data);
      expect(lz4StreamDecompress(comp)).toEqual(data);
    }
    expect(lz4StreamCompress(big).length).toBeLessThan(big.length / 4);
  });
});

describe('SNBT', () => {
  it('round-trips every tag type', () => {
    const root = sampleRoot();
    const s = toSnbt(root.tag);
    expect(tagEquals(parseSnbt(s), root.tag)).toBe(true);
    const pretty = toSnbt(root.tag, { indent: '  ' });
    expect(tagEquals(parseSnbt(pretty), root.tag)).toBe(true);
  });

  it('parses classic and 1.21.5+ syntax', () => {
    const t = parseSnbt(`{a:1b,b:2s,c:3,d:4L,e:1.5f,f:2.5,g:true,h:0xFF,i:255ub,j:1_000,k:'it\\'s',l:[B;1b,2b],m:[I;1,2],n:[L;1L],o:"\\u00e9"}`);
    const m = (t as { value: Map<string, Tag> }).value;
    expect(m.get('a')).toEqual({ type: 1, value: 1 });
    expect(m.get('d')).toEqual({ type: 4, value: 4n });
    expect(m.get('f')).toEqual({ type: 6, value: 2.5 });
    expect(m.get('g')).toEqual({ type: 1, value: 1 });
    expect(m.get('h')).toEqual({ type: 3, value: 255 });
    expect(m.get('i')).toEqual({ type: 1, value: -1 });
    expect(m.get('j')).toEqual({ type: 3, value: 1000 });
    expect(m.get('k')).toEqual({ type: 8, value: "it's" });
    expect(m.get('o')).toEqual({ type: 8, value: 'é' });
  });

  it('wraps heterogeneous lists like Minecraft 1.21.5', () => {
    const t = parseSnbt('[1, "two", {x:3}]') as ListTag;
    expect(t.elementType).toBe(TagType.Compound);
    expect(t.value[0]).toEqual({ type: 10, value: new Map([['', { type: 3, value: 1 }]]) });
    expect(t.value[2]).toEqual(c({ x: int(3) }));
    expect(makeList([int(1), int(2)]).elementType).toBe(TagType.Int);
  });

  it('reports errors with position', () => {
    expect(() => parseSnbt('{a:1,')).toThrow(/position/);
  });
});

describe('helpers', () => {
  it('maps DataVersion to releases', () => {
    expect(describeDataVersion(3953)).toBe('1.21');
    expect(describeDataVersion(3954)).toBe('1.21+ (snapshot)');
    expect(describeDataVersion(1)).toBe('pre-1.9');
    expect(describeDataVersion(99999)).toMatch(/^newer than/);
  });
  it('validates primitive input', () => {
    expect(parsePrimitive(1, '128').ok).toBe(false);
    expect(parsePrimitive(1, 'true').value).toBe(1);
    expect(parsePrimitive(4, '9223372036854775807').value).toBe(9223372036854775807n);
    expect(parsePrimitive(5, 'abc').ok).toBe(false);
  });
  it('formats paths', () => {
    expect(formatPath(['Data', 'Player', 'Inventory', 3, 'id'])).toBe('Data.Player.Inventory[3].id');
    expect(formatPath(['a b'])).toBe('["a b"]');
  });
  it('clones deeply', () => {
    const r = sampleRoot().tag;
    const k = cloneTag(r);
    expect(tagEquals(r, k)).toBe(true);
    expect(k).not.toBe(r);
  });
});
