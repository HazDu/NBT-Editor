/**
 * NBT tag model. Plain objects with a stable shape ({ type, value }) so V8 keeps them monomorphic.
 * Tag objects double as identities for the UI (selection, expansion, change markers), so
 * primitive edits must mutate `tag.value` in place instead of replacing the tag object.
 */

export const TagType = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;
export type TagType = (typeof TagType)[keyof typeof TagType];

export interface ByteTag { type: 1; value: number }
export interface ShortTag { type: 2; value: number }
export interface IntTag { type: 3; value: number }
export interface LongTag { type: 4; value: bigint }
export interface FloatTag { type: 5; value: number }
export interface DoubleTag { type: 6; value: number }
export interface ByteArrayTag { type: 7; value: Int8Array }
export interface StringTag { type: 8; value: string }
export interface ListTag { type: 9; value: Tag[]; elementType: TagType }
export interface CompoundTag { type: 10; value: Map<string, Tag> }
export interface IntArrayTag { type: 11; value: Int32Array }
export interface LongArrayTag { type: 12; value: BigInt64Array }

export type Tag =
  | ByteTag | ShortTag | IntTag | LongTag | FloatTag | DoubleTag
  | ByteArrayTag | StringTag | ListTag | CompoundTag | IntArrayTag | LongArrayTag;

export type NumericTag = ByteTag | ShortTag | IntTag | FloatTag | DoubleTag;
export type ArrayTag = ByteArrayTag | IntArrayTag | LongArrayTag;
export type ContainerTag = ListTag | CompoundTag;
export type PrimitiveTag = Exclude<Tag, ContainerTag | ArrayTag>;

export type Endian = 'big' | 'little';
export type Compression = 'none' | 'gzip' | 'zlib';

/** A parsed standalone NBT document (one root tag). */
export interface NbtRoot {
  name: string;
  tag: Tag;
}

export interface TagMeta {
  name: string;
  short: string;
  /** Material Symbols icon name (see src/ui/icons.ts) */
  icon: string;
  /** CSS custom property suffix for the type color */
  color: string;
}

export const TAG_META: Record<TagType, TagMeta> = {
  0: { name: 'End', short: '∅', icon: 'block', color: 'muted' },
  1: { name: 'Byte', short: 'B', icon: 'counter_1', color: 'int' },
  2: { name: 'Short', short: 'S', icon: 'counter_2', color: 'int' },
  3: { name: 'Int', short: 'I', icon: 'counter_3', color: 'int' },
  4: { name: 'Long', short: 'L', icon: 'counter_4', color: 'int' },
  5: { name: 'Float', short: 'F', icon: 'decimal_increase', color: 'float' },
  6: { name: 'Double', short: 'D', icon: 'decimal_increase', color: 'float' },
  7: { name: 'Byte Array', short: '[B]', icon: 'data_array', color: 'array' },
  8: { name: 'String', short: 'abc', icon: 'text_fields', color: 'string' },
  9: { name: 'List', short: '[ ]', icon: 'format_list_bulleted', color: 'list' },
  10: { name: 'Compound', short: '{ }', icon: 'data_object', color: 'compound' },
  11: { name: 'Int Array', short: '[I]', icon: 'data_array', color: 'array' },
  12: { name: 'Long Array', short: '[L]', icon: 'data_array', color: 'array' },
};

/** All creatable tag types, in the order shown in "Add tag" menus. */
export const CREATABLE_TYPES: TagType[] = [1, 2, 3, 4, 5, 6, 8, 9, 10, 7, 11, 12];

export function isContainer(tag: Tag): tag is ContainerTag {
  return tag.type === TagType.List || tag.type === TagType.Compound;
}

export function isArray(tag: Tag): tag is ArrayTag {
  return tag.type === TagType.ByteArray || tag.type === TagType.IntArray || tag.type === TagType.LongArray;
}

export function isIntegral(type: TagType): boolean {
  return type >= TagType.Byte && type <= TagType.Long;
}

export const INT_RANGES: Partial<Record<TagType, [number, number]>> = {
  1: [-128, 127],
  2: [-32768, 32767],
  3: [-2147483648, 2147483647],
};

export function defaultTag(type: TagType): Tag {
  switch (type) {
    case TagType.Byte: return { type, value: 0 };
    case TagType.Short: return { type, value: 0 };
    case TagType.Int: return { type, value: 0 };
    case TagType.Long: return { type, value: 0n };
    case TagType.Float: return { type, value: 0 };
    case TagType.Double: return { type, value: 0 };
    case TagType.ByteArray: return { type, value: new Int8Array(0) };
    case TagType.String: return { type, value: '' };
    case TagType.List: return { type, value: [], elementType: TagType.End };
    case TagType.Compound: return { type, value: new Map() };
    case TagType.IntArray: return { type, value: new Int32Array(0) };
    case TagType.LongArray: return { type, value: new BigInt64Array(0) };
    default: throw new Error(`Cannot create tag of type ${type}`);
  }
}

/** Deep clone (used for clipboard, duplicate, journal snapshots of removed subtrees). */
export function cloneTag<T extends Tag>(tag: T): T {
  switch (tag.type) {
    case TagType.ByteArray: return { type: tag.type, value: tag.value.slice() } as T;
    case TagType.IntArray: return { type: tag.type, value: tag.value.slice() } as T;
    case TagType.LongArray: return { type: tag.type, value: tag.value.slice() } as T;
    case TagType.List:
      return { type: tag.type, value: tag.value.map((t) => cloneTag(t)), elementType: tag.elementType } as T;
    case TagType.Compound: {
      const m = new Map<string, Tag>();
      for (const [k, v] of tag.value) m.set(k, cloneTag(v));
      return { type: tag.type, value: m } as T;
    }
    default:
      return { type: tag.type, value: tag.value } as T;
  }
}

/** Structural equality (used by tests and "is this change a no-op" checks). */
export function tagEquals(a: Tag, b: Tag): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case TagType.ByteArray:
    case TagType.IntArray:
    case TagType.LongArray: {
      const av = a.value, bv = (b as typeof a).value;
      if (av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
      return true;
    }
    case TagType.List: {
      const bl = b as typeof a;
      if (a.value.length !== bl.value.length) return false;
      if (a.value.length > 0 && a.elementType !== bl.elementType) return false;
      for (let i = 0; i < a.value.length; i++) if (!tagEquals(a.value[i], bl.value[i])) return false;
      return true;
    }
    case TagType.Compound: {
      const bm = (b as typeof a).value;
      if (a.value.size !== bm.size) return false;
      for (const [k, v] of a.value) {
        const o = bm.get(k);
        if (!o || !tagEquals(v, o)) return false;
      }
      return true;
    }
    case TagType.Float:
    case TagType.Double:
      return Object.is(a.value, (b as typeof a).value) || a.value === (b as typeof a).value;
    default:
      return a.value === (b as typeof a).value;
  }
}

/** Count all tags in a subtree (iterative). */
export function countTags(root: Tag): number {
  let n = 0;
  const stack: Tag[] = [root];
  while (stack.length) {
    const t = stack.pop()!;
    n++;
    if (t.type === TagType.Compound) for (const c of t.value.values()) stack.push(c);
    else if (t.type === TagType.List) for (const c of t.value) stack.push(c);
  }
  return n;
}
