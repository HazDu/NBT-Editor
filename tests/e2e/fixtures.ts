/**
 * Synthetic Minecraft-like fixture files built with the app's own core library.
 * (Real files from your game can be dropped into tests/fixtures/private/ for manual testing.)
 */
import { serializeNbtFile } from '../../src/lib/nbt/nbtfile';
import { buildRegion, encodeChunk, ChunkCompression, type RegionEntry } from '../../src/lib/nbt/region';
import { TagType, type CompoundTag, type Tag } from '../../src/lib/nbt/types';

const c = (o: Record<string, Tag>): CompoundTag => ({ type: TagType.Compound, value: new Map(Object.entries(o)) });
const s = (value: string): Tag => ({ type: TagType.String, value });
const i = (value: number): Tag => ({ type: TagType.Int, value });
const b = (value: number): Tag => ({ type: TagType.Byte, value });
const f = (value: number): Tag => ({ type: TagType.Float, value: Math.fround(value) });
const uuid = (): Tag => ({ type: TagType.IntArray, value: Int32Array.from([-2028501662, 896618238, -1451723461, -1580375395]) });
const list = (elementType: number, value: Tag[]): Tag => ({ type: TagType.List, elementType: elementType as never, value } as Tag);

export async function levelDat(): Promise<Uint8Array> {
  const item = (id: string, count: number, slot: number) => c({ id: s(id), count: i(count), Slot: b(slot) });
  const root = c({
    Data: c({
      DataVersion: i(3953),
      LevelName: s('Magma Test World'),
      GameType: i(0),
      hardcore: b(0),
      Player: c({
        Health: f(20),
        UUID: uuid(),
        XpLevel: i(7),
        Inventory: list(TagType.Compound, [item('minecraft:diamond_sword', 1, 0), item('minecraft:torch', 64, 1), item('minecraft:magma_block', 12, 2)]),
        Pos: list(TagType.Double, [{ type: 6, value: 12.5 }, { type: 6, value: 64 }, { type: 6, value: -3.25 }]),
      }),
      LastOwner: c({ UUID: uuid() }),
      RandomSeed: { type: TagType.Long, value: -4172144997902289642n },
    }),
  });
  return serializeNbtFile({ name: '', tag: root }, { compression: 'gzip', endian: 'big', bedrockHeader: null });
}

export async function regionFile(): Promise<Uint8Array> {
  const chunk = (x: number, z: number, status: string) =>
    ({ name: '', tag: c({ DataVersion: i(3953), xPos: i(x), zPos: i(z), yPos: i(-4), Status: s(status), block_entities: list(0, []) }) });
  const schemes = [ChunkCompression.Zlib, ChunkCompression.Lz4, ChunkCompression.None];
  const entries: RegionEntry[] = [];
  for (let x = 0; x < 3; x++) {
    const enc = await encodeChunk(chunk(x, 0, `minecraft:full-${x}`), schemes[x]);
    entries.push({ index: x, timestamp: 1_700_000_000 + x, data: enc.record, size: enc.record.length });
  }
  return new Uint8Array(await buildRegion(entries).arrayBuffer());
}

export async function bedrockLevelDat(): Promise<Uint8Array> {
  const root = c({ LevelName: s('Bedrock World'), StorageVersion: i(10), lastOpenedWithVersion: list(TagType.Int, [i(1), i(21), i(0)]) });
  return serializeNbtFile({ name: '', tag: root }, { compression: 'none', endian: 'little', bedrockHeader: { version: 10 } });
}
