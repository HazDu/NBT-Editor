import { describe, expect, it } from 'vitest';
import * as actions from '../../src/lib/doc/actions';
import { buildOutput } from '../../src/lib/doc/export';
import { FolderNode, loadNode, NbtFileNode, RegionFileNode, Workspace, type ChunkNode } from '../../src/lib/doc/model';
import { buildRows, type Row } from '../../src/lib/doc/rows';
import { dirFromFileList } from '../../src/lib/fs/access';
import { parseNbtFile, serializeNbtFile } from '../../src/lib/nbt/nbtfile';
import { buildRegion, encodeChunk, parseRegionHeader, SECTOR, ChunkCompression, type RegionEntry } from '../../src/lib/nbt/region';
import { cloneTag, tagEquals, TagType, type CompoundTag, type ListTag } from '../../src/lib/nbt/types';
import { compileQuery, parseArrayQuery, searchTree, searchValueText, uuidFromInts } from '../../src/lib/search/query';
import { parseSnbt } from '../../src/lib/nbt/snbt';
import { c, int, sampleRoot, str } from './helpers';

async function openSample(): Promise<{ ws: Workspace; node: NbtFileNode; original: Uint8Array }> {
  const original = await serializeNbtFile(sampleRoot(), { compression: 'gzip', endian: 'big', bedrockHeader: null });
  const node = new NbtFileNode('level.dat', { file: new Blob([original as BlobPart]) });
  const ws = new Workspace(node);
  await ws.load(node);
  return { ws, node, original };
}

/** All rows with everything expanded. */
function rowsOf(ws: Workspace): Row[] {
  const expanded = new WeakSet<object>();
  const walk = (t: { type: number; value: unknown }) => {
    expanded.add(t);
    if (t.type === TagType.Compound) for (const v of (t.value as Map<string, never>).values()) walk(v);
    if (t.type === TagType.List) for (const v of t.value as never[]) walk(v);
  };
  expanded.add(ws.root);
  const root = ws.root as NbtFileNode;
  if (root.root) walk(root.root.tag);
  return buildRows(ws.root, { expanded, sort: 'file' });
}

const find = (ws: Workspace, name: string | number, parent?: string) =>
  rowsOf(ws).find((r) => r.name === name && (parent === undefined || r.parent?.name === parent))!;

describe('journal & actions', () => {
  it('edits, undoes and redoes; markers follow', async () => {
    const { ws, node } = await openSample();
    const before = cloneTag(node.root!.tag);
    const r1 = actions.setValue(ws, find(ws, 'int'), 42);
    expect(r1.ok).toBe(true);
    expect(actions.renameTag(ws, find(ws, 'short'), 'shorty').ok).toBe(true);
    expect(actions.deleteRows(ws, [find(ws, 'ascii'), find(ws, 1, 'list')]).ok).toBe(true);
    expect(actions.insertTags(ws, find(ws, 'nested'), [{ name: null, tag: c({ id: str('minecraft:pig') }) }], 'Paste').ok).toBe(true);
    expect(actions.moveRow(ws, find(ws, 0, 'list'), 1).ok).toBe(true);

    const m = node.root!.tag as CompoundTag;
    expect(m.value.get('int')).toEqual(int(42));
    expect([...m.value.keys()][1]).toBe('shorty'); // rename keeps key order
    expect(m.value.has('ascii')).toBe(false);
    expect((m.value.get('list') as ListTag).value.map((t) => t.value)).toEqual([3, 1]);
    expect((m.value.get('nested') as ListTag).value).toHaveLength(3);
    expect(ws.isDirty).toBe(true);
    expect(ws.journal.markers().direct.size).toBeGreaterThan(0);

    while (ws.journal.canUndo) ws.journal.undo();
    expect(tagEquals(node.root!.tag, before)).toBe(true);
    expect([...m.value.keys()]).toEqual([...(before as CompoundTag).value.keys()]); // positions restored
    expect(ws.isDirty).toBe(false);
    expect(ws.journal.markers().direct.size).toBe(0);

    while (ws.journal.canRedo) ws.journal.redo();
    expect(m.value.get('int')).toEqual(int(42));
  });

  it('rejects invalid edits', async () => {
    const { ws } = await openSample();
    expect(actions.renameTag(ws, find(ws, 'short'), 'int')).toMatchObject({ ok: false });
    const res = actions.insertTags(ws, find(ws, 'list'), [{ name: null, tag: str('x') }], 'Paste');
    expect(res).toMatchObject({ ok: false });
  });

  it('reverts a single older change (git revert)', async () => {
    const { ws, node } = await openSample();
    actions.setValue(ws, find(ws, 'int'), 1);
    actions.setValue(ws, find(ws, 'byte'), 5);
    const first = ws.journal.entries[0];
    ws.journal.revertEntry(first);
    const m = (node.root!.tag as CompoundTag).value;
    expect(m.get('int')).toEqual(int(-2147483648));
    expect(m.get('byte')).toEqual({ type: 1, value: 5 });
    expect(ws.journal.entries).toHaveLength(3);
  });

  it('rewinds to the original to rebuild a backup', async () => {
    const { ws, node } = await openSample();
    actions.setValue(ws, find(ws, 'int'), 7);
    const raw = ws.journal.atOriginal(() => cloneTag(node.root!.tag));
    expect(tagEquals(raw, sampleRoot().tag)).toBe(true);
    expect((node.root!.tag as CompoundTag).value.get('int')).toEqual(int(7));
  });
});

describe('export', () => {
  it('writes edited NBT files with the original format', async () => {
    const { ws, node } = await openSample();
    actions.setValue(ws, find(ws, 'ascii'), 'changed');
    const out = await buildOutput(node);
    const parsed = await parseNbtFile(new Uint8Array(await out.main.arrayBuffer()));
    expect(parsed.format.compression).toBe('gzip');
    expect((parsed.root.tag as CompoundTag).value.get('ascii')).toEqual(str('changed'));
  });

  it('region: re-encodes only edited chunks, drops deleted ones', async () => {
    const entries: RegionEntry[] = [];
    for (let x = 0; x < 3; x++) {
      const enc = await encodeChunk({ name: '', tag: c({ xPos: int(x), Status: str('full') }) }, ChunkCompression.Zlib);
      entries.push({ index: x, timestamp: 100 + x, data: enc.record, size: enc.record.length });
    }
    const original = new Uint8Array(await buildRegion(entries).arrayBuffer());
    const region = new RegionFileNode('r.0.0.mca', { file: new Blob([original]) });
    const ws = new Workspace(region);
    await ws.load(region);
    const [c0, c1, c2] = region.chunks as ChunkNode[];
    await ws.load(c1);
    await ws.load(c2);
    const expanded = new WeakSet<object>([region, c1, c2]);
    const rows = buildRows(region, { expanded, sort: 'file' });
    const status = rows.find((r) => r.holder === c1 && r.name === 'Status')!;
    actions.setValue(ws, status, 'edited');
    actions.deleteRows(ws, [rows.find((r) => r.node === c2)!]);
    expect(c1.modified).toBe(true);

    const out = new Uint8Array(await (await buildOutput(region)).main.arrayBuffer());
    const slots = parseRegionHeader(out.subarray(0, 2 * SECTOR), out.length);
    expect(slots.map((s) => s.index)).toEqual([0, 1]);
    const orig0 = c0.slot;
    expect(out.subarray(slots[0].sectorOffset * SECTOR, (slots[0].sectorOffset + 1) * SECTOR)).toEqual(
      original.subarray(orig0.sectorOffset * SECTOR, (orig0.sectorOffset + 1) * SECTOR),
    );
    expect(slots[0].timestamp).toBe(100);
  });
});

describe('folders & search', () => {
  it('lists supported files from a webkitdirectory selection and searches them', async () => {
    const level = await serializeNbtFile(sampleRoot(), { compression: 'gzip', endian: 'big', bedrockHeader: null });
    const mk = (path: string, data: Uint8Array) => {
      const f = new File([data as BlobPart], path.split('/').pop()!);
      Object.defineProperty(f, 'webkitRelativePath', { value: path });
      return f;
    };
    const dir = dirFromFileList([
      mk('World/level.dat', level),
      mk('World/session.lock', new Uint8Array([1])),
      mk('World/playerdata/abc.dat', level),
    ]);
    const folder = new FolderNode(dir);
    await loadNode(folder);
    expect(folder.name).toBe('World');
    expect(folder.children!.map((n) => n.name)).toEqual(['playerdata', 'level.dat']);

    const file = folder.children![1] as NbtFileNode;
    await loadNode(file);
    const hits = [...searchTree(file.root!.tag, compileQuery({ kind: 'quick', name: '', value: 'zombie', mode: 'contains', caseSensitive: false }))].filter(Boolean);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toEqual(['nested', 0, 'id']);

    const rules = [...searchTree(file.root!.tag, compileQuery({
      kind: 'rules',
      root: { kind: 'group', match: 'all', rules: [{ kind: 'rule', name: 'id', op: 'contains', value: 'zombie' }, { kind: 'rule', name: 'Health', op: '>=', value: '20' }] },
    }))].filter(Boolean);
    expect(rules.map((h) => h!.path)).toEqual([['nested', 0]]);
  });
});

describe('array & UUID search', () => {
  const uuidInts = [-2028501662, 896618238, -1451723461, -1580375395];
  const uuidStr = uuidFromInts(uuidInts);
  const hex = uuidStr.replace(/-/g, '');
  const root = parseSnbt(`{
    UUID: [I;${uuidInts.join(',')}],
    Brain: {memories: {}},
    Leash: {UUID: [I; ${uuidInts.join(', ')}]},
    Owner: "${uuidStr.toUpperCase()}",
    Old: {OwnerUUIDMost: ${BigInt.asIntN(64, BigInt('0x' + hex.slice(0, 16)))}L, OwnerUUIDLeast: ${BigInt.asIntN(64, BigInt('0x' + hex.slice(16)))}L},
    Other: [I;1,2,3,4],
    Heights: [L;5L,6L,7L,8L],
    Bytes: [B;1b,2b,3b]
  }`);
  const find = (value: string, mode: 'exact' | 'contains' = 'exact') =>
    [...searchTree(root, compileQuery({ kind: 'quick', name: '', value, mode, caseSensitive: false }))]
      .filter(Boolean)
      .map((h) => h!.path.join('.'));

  it('matches int arrays typed as SNBT, also as UUID string and Most/Least pair', () => {
    const all = ['UUID', 'Leash.UUID', 'Owner', 'Old'];
    expect(find(`[I;${uuidInts.join(',')}]`)).toEqual(all);
    expect(find(`[I; ${uuidInts.join(', ')} ]`, 'contains')).toEqual(all);
    expect(find(uuidStr)).toEqual(all);
  });

  it('matches other arrays by type and as contiguous runs in contains mode', () => {
    expect(find('[I;1,2,3,4]')).toEqual(['Other']);
    expect(find('[L;6,7]')).toEqual([]);
    expect(find('[L;6,7]', 'contains')).toEqual(['Heights']);
    expect(find('[2,3]', 'contains')).toEqual(['Other', 'Bytes']);
    expect(find('[B;1b,2b,3b]')).toEqual(['Bytes']);
  });

  it('builds the "Find this value" text from a tag', () => {
    const t = (root as CompoundTag).value.get('UUID')!;
    expect(searchValueText(t)).toBe(`[I;${uuidInts.join(',')}]`);
    expect(parseArrayQuery(searchValueText(t)!)!.uuid).toBe(uuidStr);
  });
});
