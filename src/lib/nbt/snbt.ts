/**
 * SNBT (stringified NBT), the text form used by /data, /give, /summon.
 * stringify: emits classic syntax that every Minecraft version since 1.13 understands.
 * parse: lenient; also accepts the 1.21.5+ additions (true/false, hex/binary literals, underscores,
 * signed/unsigned suffixes, \x \u \N escapes, heterogeneous lists).
 */
import { TagType, type CompoundTag, type ListTag, type Tag } from './types';

const BARE_KEY = /^[A-Za-z0-9._+-]+$/;

export function quoteString(s: string): string {
  const q = s.includes('"') && !s.includes("'") ? "'" : '"';
  let out = q;
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + q;
}

function key(k: string): string {
  return BARE_KEY.test(k) ? k : quoteString(k);
}

/** Shortest decimal string that round-trips through float32. */
export function formatFloat(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return normalizeNum(String(Number(s)));
  }
  return normalizeNum(String(v));
}

export function formatDouble(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return normalizeNum(String(v));
}

function normalizeNum(s: string): string {
  if (/^-?\d+$/.test(s)) return s + '.0';
  return s;
}

export interface StringifyOptions {
  /** indent string; empty = single line */
  indent?: string;
  /** max array/list entries before eliding (only for previews) */
  maxItems?: number;
}

export function toSnbt(tag: Tag, opts: StringifyOptions = {}): string {
  const indent = opts.indent ?? '';
  const max = opts.maxItems ?? Infinity;
  const nl = indent ? '\n' : '';
  const sep = indent ? ', ' : ',';

  const walk = (t: Tag, depth: number): string => {
    switch (t.type) {
      case TagType.Byte: return `${t.value}b`;
      case TagType.Short: return `${t.value}s`;
      case TagType.Int: return `${t.value}`;
      case TagType.Long: return `${t.value}L`;
      case TagType.Float: return `${formatFloat(t.value)}f`;
      case TagType.Double: return `${formatDouble(t.value)}d`;
      case TagType.String: return quoteString(t.value);
      case TagType.ByteArray: return arr('B', Array.from(t.value, (v) => `${v}b`));
      case TagType.IntArray: return arr('I', Array.from(t.value, (v) => `${v}`));
      case TagType.LongArray: return arr('L', Array.from(t.value, (v) => `${v}L`));
      case TagType.List: {
        if (t.value.length === 0) return '[]';
        const items = elide(t.value.map((c) => walk(c, depth + 1)));
        if (!indent) return `[${items.join(',')}]`;
        const pad = indent.repeat(depth + 1);
        return `[${nl}${items.map((s) => pad + s).join(',' + nl)}${nl}${indent.repeat(depth)}]`;
      }
      case TagType.Compound: {
        if (t.value.size === 0) return '{}';
        const items: string[] = [];
        for (const [k, v] of t.value) items.push(`${key(k)}:${indent ? ' ' : ''}${walk(v, depth + 1)}`);
        if (!indent) return `{${items.join(',')}}`;
        const pad = indent.repeat(depth + 1);
        return `{${nl}${items.map((s) => pad + s).join(',' + nl)}${nl}${indent.repeat(depth)}}`;
      }
    }
  };
  const elide = (items: string[]) => (items.length > max ? [...items.slice(0, max), `… ${items.length - max} more`] : items);
  const arr = (p: string, items: string[]) => `[${p};${elide(items).join(sep)}]`;
  return walk(tag, 0);
}

// ------------------------------------------------------------------------------------------ parser

export class SnbtError extends Error {
  constructor(message: string, public pos: number) {
    super(`${message} at position ${pos}`);
    this.name = 'SnbtError';
  }
}

const NUM_RE = /^([+-]?)(0x[0-9a-f_]+|0b[01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d[\d_]*)?)([su]?[bslifd])?$/i;

const INT_BITS: Record<string, [TagType, number]> = { b: [1, 8], s: [2, 16], i: [3, 32], l: [4, 64] };

function parseNumber(tok: string): Tag | null {
  const m = NUM_RE.exec(tok);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const body = m[2].replace(/_/g, '');
  let suffix = (m[3] ?? '').toLowerCase();
  let unsigned = false;
  if (suffix.length === 2) {
    unsigned = suffix[0] === 'u';
    suffix = suffix[1];
  }
  const isHexBin = /^0[xb]/i.test(body);
  const isFloatSyntax = !isHexBin && /[.e]/i.test(body);
  if (suffix === 'f' || suffix === 'd' || (isFloatSyntax && !suffix)) {
    if (isHexBin) return null;
    const v = sign * Number(body);
    if (Number.isNaN(v)) return null;
    return suffix === 'f' ? { type: TagType.Float, value: Math.fround(v) } : { type: TagType.Double, value: v };
  }
  if (isFloatSyntax) return null;
  let big: bigint;
  try {
    big = BigInt(body);
  } catch {
    return null;
  }
  if (sign < 0) big = -big;
  const [type, bits] = INT_BITS[suffix || 'i'];
  // Hex/binary/unsigned literals may use the full unsigned range and wrap like Java casts.
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (big > max || big < min) {
    if ((isHexBin || unsigned) && big >= 0n && big < 1n << BigInt(bits)) big = BigInt.asIntN(bits, big);
    else if (!suffix && !isHexBin) {
      // Bare integer that overflows int: classic SNBT treats it as a string, be helpful and use a double.
      return { type: TagType.Double, value: Number(big) };
    } else return null;
  }
  if (type === TagType.Long) return { type, value: big };
  return { type, value: Number(big) } as Tag;
}

export function parseSnbt(text: string): Tag {
  let i = 0;
  const s = text;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = () => s[i];
  const expect = (c: string) => {
    ws();
    if (s[i] !== c) throw new SnbtError(`Expected '${c}'`, i);
    i++;
  };

  const quoted = (): string => {
    const q = s[i++];
    let out = '';
    while (i < s.length) {
      const c = s[i++];
      if (c === q) return out;
      if (c === '\\') {
        const e = s[i++];
        switch (e) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 's': out += ' '; break;
          case 'x': out += String.fromCharCode(parseInt(s.substr(i, 2), 16)); i += 2; break;
          case 'u': out += String.fromCharCode(parseInt(s.substr(i, 4), 16)); i += 4; break;
          case 'U': out += String.fromCodePoint(parseInt(s.substr(i, 8), 16)); i += 8; break;
          default: out += e;
        }
      } else out += c;
    }
    throw new SnbtError('Unterminated string', i);
  };

  const bare = (): string => {
    const start = i;
    while (i < s.length && /[A-Za-z0-9._+\-]/.test(s[i])) i++;
    if (start === i) throw new SnbtError(`Unexpected '${s[i] ?? 'end of input'}'`, i);
    return s.slice(start, i);
  };

  const value = (): Tag => {
    ws();
    const c = peek();
    if (c === '{') return compound();
    if (c === '[') return list();
    if (c === '"' || c === "'") return { type: TagType.String, value: quoted() };
    const tok = bare();
    if (tok === 'true') return { type: TagType.Byte, value: 1 };
    if (tok === 'false') return { type: TagType.Byte, value: 0 };
    return parseNumber(tok) ?? { type: TagType.String, value: tok };
  };

  const compound = (): CompoundTag => {
    expect('{');
    const map = new Map<string, Tag>();
    ws();
    if (peek() === '}') { i++; return { type: TagType.Compound, value: map }; }
    for (;;) {
      ws();
      const k = peek() === '"' || peek() === "'" ? quoted() : bare();
      expect(':');
      map.set(k, value());
      ws();
      if (peek() === ',') { i++; ws(); if (peek() === '}') { i++; break; } continue; }
      if (peek() === '}') { i++; break; }
      throw new SnbtError("Expected ',' or '}'", i);
    }
    return { type: TagType.Compound, value: map };
  };

  const list = (): Tag => {
    expect('[');
    ws();
    // typed arrays [B; ...] [I; ...] [L; ...]
    if (/[BIL]/.test(s[i] ?? '') && s[i + 1] === ';') {
      const kind = s[i];
      i += 2;
      const items: Tag[] = [];
      ws();
      while (peek() !== ']') {
        items.push(value());
        ws();
        if (peek() === ',') { i++; ws(); }
        else if (peek() !== ']') throw new SnbtError("Expected ',' or ']'", i);
      }
      i++;
      const nums = items.map((t) => {
        if (t.type === TagType.String || t.type > TagType.Double) throw new SnbtError('Array elements must be numbers', i);
        return t.value;
      });
      if (kind === 'B') return { type: TagType.ByteArray, value: Int8Array.from(nums, (n) => Number(n)) };
      if (kind === 'I') return { type: TagType.IntArray, value: Int32Array.from(nums, (n) => Number(n)) };
      return { type: TagType.LongArray, value: BigInt64Array.from(nums, (n) => BigInt(n as number | bigint)) };
    }
    const items: Tag[] = [];
    while (peek() !== ']') {
      if (i >= s.length) throw new SnbtError('Unterminated list', i);
      items.push(value());
      ws();
      if (peek() === ',') { i++; ws(); }
      else if (peek() !== ']') throw new SnbtError("Expected ',' or ']'", i);
    }
    i++;
    return makeList(items);
  };

  const result = value();
  ws();
  if (i < s.length) throw new SnbtError('Unexpected trailing characters', i);
  return result;
}

/**
 * Builds a list tag. Mixed element types are stored the way Minecraft 1.21.5+ does:
 * every non-compound element is wrapped as {"": value}.
 */
export function makeList(items: Tag[]): ListTag {
  if (items.length === 0) return { type: TagType.List, value: [], elementType: TagType.End };
  const t0 = items[0].type;
  if (items.every((t) => t.type === t0)) return { type: TagType.List, value: items, elementType: t0 };
  const wrapped: Tag[] = items.map((t) =>
    t.type === TagType.Compound ? t : ({ type: TagType.Compound, value: new Map([['', t]]) } as CompoundTag),
  );
  return { type: TagType.List, value: wrapped, elementType: TagType.Compound };
}

/** True for a compound that is a 1.21.5 heterogeneous-list wrapper ({"": value}). */
export function isListWrapper(tag: Tag): boolean {
  return tag.type === TagType.Compound && tag.value.size === 1 && tag.value.has('');
}
