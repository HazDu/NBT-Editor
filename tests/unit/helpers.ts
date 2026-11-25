import { TagType, type CompoundTag, type NbtRoot, type Tag } from '../../src/lib/nbt/types';

export const c = (entries: Record<string, Tag>): CompoundTag => ({ type: TagType.Compound, value: new Map(Object.entries(entries)) });
export const str = (value: string): Tag => ({ type: TagType.String, value });
export const int = (value: number): Tag => ({ type: TagType.Int, value });
export const byte = (value: number): Tag => ({ type: TagType.Byte, value });

/** A tag tree that exercises every type and the tricky string cases. */
export function sampleRoot(): NbtRoot {
  return {
    name: 'Data',
    tag: c({
      byte: { type: 1, value: -128 },
      short: { type: 2, value: 32767 },
      int: { type: 3, value: -2147483648 },
      long: { type: 4, value: -(1n << 63n) },
      float: { type: 5, value: Math.fround(3.14159) },
      double: { type: 6, value: Math.PI },
      bytes: { type: 7, value: Int8Array.from([1, -2, 127, -128]) },
      ints: { type: 11, value: Int32Array.from([1, -1, 0x7fffffff, -0x80000000]) },
      longs: { type: 12, value: BigInt64Array.from([1n, -1n, (1n << 63n) - 1n]) },
      ascii: str('minecraft:diamond_sword'),
      unicode: str('Grüße ✓ 日本'),
      nul: str('a\u0000b'),
      emoji: str('magma 🔥 cube'),
      empty: str(''),
      list: { type: 9, elementType: 3, value: [int(1), int(2), int(3)] },
      emptyList: { type: 9, elementType: 0, value: [] },
      nested: { type: 9, elementType: 10, value: [c({ id: str('minecraft:zombie'), Health: { type: 5, value: 20 } }), c({})] },
      'key with spaces': byte(1),
    }),
  };
}
