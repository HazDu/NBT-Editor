/**
 * Search queries. Pure TS so it runs on the main thread (loaded data) and in the worker
 * (unloaded files/chunks). Queries are plain JSON so they can be posted to the worker.
 *
 * Compared to NBTExplorer (which expanded every node and string-matched its display text), the
 * query is compiled once and values are compared natively (numbers numerically, strings directly).
 */
import { formatDouble, formatFloat } from '../nbt/snbt';
import { TagType, type Tag } from '../nbt/types';

export type MatchMode = 'contains' | 'exact' | 'regex';

export interface QuickQuery {
  kind: 'quick';
  name: string;
  value: string;
  mode: MatchMode;
  caseSensitive: boolean;
}

export type RuleOp = 'exists' | '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | '!contains' | 'startsWith' | 'endsWith';

export interface TagRule {
  kind: 'rule';
  /** child key to test inside each compound */
  name: string;
  op: RuleOp;
  value: string;
}

export interface GroupRule {
  kind: 'group';
  match: 'all' | 'any';
  rules: (TagRule | GroupRule)[];
}

export interface RuleQuery {
  kind: 'rules';
  root: GroupRule;
}

export type Query = QuickQuery | RuleQuery;

export interface Hit {
  path: (string | number)[];
  tag: Tag;
}

export const RULE_OPS: { op: RuleOp; label: string }[] = [
  { op: 'exists', label: 'exists' },
  { op: '=', label: '=' },
  { op: '!=', label: '≠' },
  { op: '>', label: '>' },
  { op: '<', label: '<' },
  { op: '>=', label: '≥' },
  { op: '<=', label: '≤' },
  { op: 'contains', label: 'contains' },
  { op: '!contains', label: 'does not contain' },
  { op: 'startsWith', label: 'starts with' },
  { op: 'endsWith', label: 'ends with' },
];

export function valueText(tag: Tag): string | null {
  switch (tag.type) {
    case TagType.Byte:
    case TagType.Short:
    case TagType.Int:
    case TagType.Long:
    case TagType.String:
      return String(tag.value);
    case TagType.Float:
      return formatFloat(tag.value);
    case TagType.Double:
      return formatDouble(tag.value);
    default:
      return null;
  }
}

/** Text to put into the value field for "Find this value" (arrays as `[I;1,2,3]`). */
export function searchValueText(tag: Tag): string | null {
  switch (tag.type) {
    case TagType.ByteArray: return `[B;${tag.value.join(',')}]`;
    case TagType.IntArray: return `[I;${tag.value.join(',')}]`;
    case TagType.LongArray: return `[L;${tag.value.join(',')}]`;
    default: return valueText(tag);
  }
}

function numberOf(tag: Tag): number | bigint | null {
  switch (tag.type) {
    case TagType.Byte:
    case TagType.Short:
    case TagType.Int:
    case TagType.Float:
    case TagType.Double:
      return tag.value;
    case TagType.Long:
      return tag.value;
    default:
      return null;
  }
}

function cmpNum(a: number | bigint, b: number): number {
  const av = typeof a === 'bigint' ? Number(a) : a;
  return av < b ? -1 : av > b ? 1 : 0;
}

type StrTest = (s: string) => boolean;

function strMatcher(q: string, mode: MatchMode, cs: boolean): StrTest {
  if (mode === 'regex') {
    const re = new RegExp(q, cs ? 'u' : 'iu');
    return (s) => re.test(s);
  }
  const needle = cs ? q : q.toLowerCase();
  if (mode === 'exact') return cs ? (s) => s === needle : (s) => s.toLowerCase() === needle;
  return cs ? (s) => s.includes(needle) : (s) => s.toLowerCase().includes(needle);
}

/** A compiled matcher called for every (name, tag) pair during traversal. */
export type NodeMatcher = (name: string | number | null, tag: Tag) => boolean;

// ------------------------------------------------------------------ array & UUID values

/** Array value typed into the search box: `[I;1,2,3]`, `[B;…]`, `[L;…]`, `[1,2,3]` or a hyphenated UUID. */
export interface ArrayQuery {
  /** required array type, or null for "any array type" */
  type: typeof TagType.ByteArray | typeof TagType.IntArray | typeof TagType.LongArray | null;
  values: bigint[];
  /** set when the value is a UUID (4 ints); then UUID strings and Most/Least long pairs match too */
  uuid: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Int array [a,b,c,d] → "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (Minecraft 1.16+ UUID layout). */
export function uuidFromInts(ints: ArrayLike<number | bigint>): string {
  const hex = Array.from(ints, (v) => (Number(v) >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function intsFromUuid(uuid: string): bigint[] {
  const hex = uuid.replace(/-/g, '');
  return [0, 8, 16, 24].map((o) => BigInt.asIntN(32, BigInt('0x' + hex.slice(o, o + 8))));
}

export function parseArrayQuery(text: string): ArrayQuery | null {
  const s = text.trim();
  if (UUID_RE.test(s)) return { type: null, values: intsFromUuid(s), uuid: s.toLowerCase() };
  const m = /^\[\s*(?:([BIL])\s*;)?([\s\S]*)\]$/i.exec(s);
  if (!m) return null;
  const type = m[1] ? ({ B: TagType.ByteArray, I: TagType.IntArray, L: TagType.LongArray } as const)[m[1].toUpperCase() as 'B' | 'I' | 'L'] : null;
  const body = m[2].trim();
  const values: bigint[] = [];
  if (body !== '') {
    for (const part of body.split(',')) {
      const p = part.trim().replace(/[bBsSlL]$/, '');
      if (!/^[+-]?\d+$/.test(p)) return null;
      values.push(BigInt(p));
    }
  }
  if (values.length === 0) return null;
  const uuid = values.length === 4 && type !== TagType.ByteArray && type !== TagType.LongArray && values.every((v) => v >= -0x80000000n && v <= 0x7fffffffn)
    ? uuidFromInts(values)
    : null;
  return { type, values, uuid };
}

function arrayMatches(tag: Tag, q: ArrayQuery, exact: boolean): boolean {
  if (tag.type !== TagType.ByteArray && tag.type !== TagType.IntArray && tag.type !== TagType.LongArray) return false;
  if (q.type !== null && q.type !== tag.type) return false;
  const a = tag.value;
  const w = q.values;
  if (exact ? a.length !== w.length : a.length < w.length) return false;
  const big = tag.type === TagType.LongArray;
  const wn = big ? null : w.map(Number);
  const at = (i: number, j: number) => (big ? (a as BigInt64Array)[i] === w[j] : (a as Int8Array | Int32Array)[i] === wn![j]);
  // contiguous run (exact: the whole array)
  outer: for (let start = 0; start + w.length <= a.length; start++) {
    for (let j = 0; j < w.length; j++) if (!at(start + j, j)) continue outer;
    return true;
  }
  return false;
}

/** Pre-1.16 UUIDs: a compound with `<X>Most` + `<X>Least` longs. */
function mostLeastMatches(tag: Tag, uuid: string): boolean {
  if (tag.type !== TagType.Compound) return false;
  const hex = uuid.replace(/-/g, '');
  const most = BigInt.asIntN(64, BigInt('0x' + hex.slice(0, 16)));
  const least = BigInt.asIntN(64, BigInt('0x' + hex.slice(16)));
  for (const [k, v] of tag.value) {
    if (!k.endsWith('Most') || v.type !== TagType.Long || v.value !== most) continue;
    const l = tag.value.get(k.slice(0, -4) + 'Least');
    if (l?.type === TagType.Long && l.value === least) return true;
  }
  return false;
}

export function compileQuick(q: QuickQuery): NodeMatcher {
  const nameTest = q.name ? strMatcher(q.name, q.mode, q.caseSensitive) : null;
  let valueTest: ((tag: Tag) => boolean) | null = null;
  const arr = q.value && q.mode !== 'regex' ? parseArrayQuery(q.value) : null;
  if (arr) {
    const exact = q.mode === 'exact';
    const uuid = arr.uuid;
    valueTest = (tag) => {
      if (arrayMatches(tag, arr, exact)) return true;
      if (!uuid) return false;
      if (tag.type === TagType.String) return tag.value.length === 36 && tag.value.toLowerCase() === uuid;
      return mostLeastMatches(tag, uuid);
    };
  } else if (q.value) {
    const sTest = strMatcher(q.value, q.mode, q.caseSensitive);
    const asNum = q.mode === 'exact' && q.value.trim() !== '' ? Number(q.value) : NaN;
    valueTest = (tag) => {
      if (!Number.isNaN(asNum)) {
        const n = numberOf(tag);
        if (n !== null) return cmpNum(n, asNum) === 0;
      }
      const t = valueText(tag);
      return t !== null && sTest(t);
    };
  }
  return (name, tag) => {
    if (nameTest && (typeof name !== 'string' || !nameTest(name))) return false;
    if (valueTest && !valueTest(tag)) return false;
    return !!(nameTest || valueTest);
  };
}

function compileRule(r: TagRule | GroupRule): (map: Map<string, Tag>) => boolean {
  if (r.kind === 'group') {
    const subs = r.rules.map(compileRule);
    if (subs.length === 0) return () => false;
    return r.match === 'all' ? (m) => subs.every((f) => f(m)) : (m) => subs.some((f) => f(m));
  }
  const want = r.value;
  const wantNum = Number(want);
  const lc = want.toLowerCase();
  return (m) => {
    const t = m.get(r.name);
    if (!t) return false;
    if (r.op === 'exists') return true;
    const n = numberOf(t);
    if (n !== null && !Number.isNaN(wantNum) && want.trim() !== '' && ['=', '!=', '>', '<', '>=', '<='].includes(r.op)) {
      const c = cmpNum(n, wantNum);
      switch (r.op) {
        case '=': return c === 0;
        case '!=': return c !== 0;
        case '>': return c > 0;
        case '<': return c < 0;
        case '>=': return c >= 0;
        case '<=': return c <= 0;
      }
    }
    const s = valueText(t);
    if (s === null) return false;
    const sl = s.toLowerCase();
    switch (r.op) {
      case '=': return s === want;
      case '!=': return s !== want;
      case 'contains': return sl.includes(lc);
      case '!contains': return !sl.includes(lc);
      case 'startsWith': return sl.startsWith(lc);
      case 'endsWith': return sl.endsWith(lc);
      case '>': return s > want;
      case '<': return s < want;
      case '>=': return s >= want;
      case '<=': return s <= want;
      default: return false;
    }
  };
}

/** Returns a matcher; rule queries match compounds whose children satisfy the rules. */
export function compileQuery(q: Query): NodeMatcher {
  if (q.kind === 'quick') return compileQuick(q);
  const test = compileRule(q.root);
  return (_name, tag) => tag.type === TagType.Compound && test(tag.value);
}

/**
 * Iterative DFS over a tag tree, yielding matches. `budget` lets callers time-slice:
 * the generator yields `null` every ~2000 nodes so the caller can check the clock.
 */
export function* searchTree(root: Tag, match: NodeMatcher, rootName: string | null = null): Generator<Hit | null> {
  // Entries link to their parent; the path array is only materialized for hits.
  interface E { tag: Tag; name: string | number | null; parent: E | null }
  const stack: E[] = [{ tag: root, name: rootName, parent: null }];
  let n = 0;
  while (stack.length) {
    const e = stack.pop()!;
    const { tag } = e;
    if (++n % 2000 === 0) yield null;
    if (match(e.name, tag)) {
      const path: (string | number)[] = [];
      for (let p: E | null = e; p && p.parent; p = p.parent) path.push(p.name!);
      yield { path: path.reverse(), tag };
    }
    if (tag.type === TagType.Compound) {
      const keys = [...tag.value.keys()];
      for (let i = keys.length - 1; i >= 0; i--) stack.push({ tag: tag.value.get(keys[i])!, name: keys[i], parent: e });
    } else if (tag.type === TagType.List) {
      for (let i = tag.value.length - 1; i >= 0; i--) stack.push({ tag: tag.value[i], name: i, parent: e });
    }
  }
}

export function validateQuery(q: Query): string | null {
  if (q.kind === 'quick') {
    if (!q.name && !q.value) return 'Enter a key or a value to search for';
    if (q.mode === 'regex') {
      try {
        if (q.name) new RegExp(q.name);
        if (q.value) new RegExp(q.value);
      } catch (e) {
        return `Invalid regular expression: ${(e as Error).message}`;
      }
    }
    return null;
  }
  const count = (g: GroupRule): number => g.rules.reduce((n, r) => n + (r.kind === 'group' ? count(r) : r.name ? 1 : 0), 0);
  return count(q.root) === 0 ? 'Add at least one rule with a key name' : null;
}
