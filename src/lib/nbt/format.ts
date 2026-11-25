/**
 * Human-readable value previews and value parsing/validation for editing.
 */
import { formatDouble, formatFloat, isListWrapper } from './snbt';
import { INT_RANGES, TAG_META, TagType, type Tag } from './types';

export function previewValue(tag: Tag, maxLen = 120): string {
  switch (tag.type) {
    case TagType.Byte:
    case TagType.Short:
    case TagType.Int:
      return String(tag.value);
    case TagType.Long:
      return tag.value.toString();
    case TagType.Float:
      return formatFloat(tag.value);
    case TagType.Double:
      return formatDouble(tag.value);
    case TagType.String: {
      const v = tag.value.replace(/\n/g, '⏎');
      return v.length > maxLen ? v.slice(0, maxLen) + '…' : v;
    }
    case TagType.ByteArray:
    case TagType.IntArray:
    case TagType.LongArray: {
      const n = tag.value.length;
      const unit = tag.type === TagType.ByteArray ? 'byte' : tag.type === TagType.IntArray ? 'int' : 'long';
      return `${n.toLocaleString()} ${unit}${n === 1 ? '' : 's'}`;
    }
    case TagType.List: {
      const n = tag.value.length;
      const et = n > 0 ? TAG_META[tag.value[0].type].name : null;
      return `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}${et ? ` · ${et}` : ''}`;
    }
    case TagType.Compound: {
      const n = tag.value.size;
      return `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`;
    }
  }
}

/**
 * Short semantic hint for well-known compound shapes (items, entities, block states, list wrappers).
 * Item stacks: 1.20.5+ uses id + count (+ components); older versions id + Count (+ tag).
 */
export function compoundHint(tag: Tag): string | null {
  if (tag.type !== TagType.Compound) return null;
  const m = tag.value;
  if (isListWrapper(tag)) {
    const inner = m.get('')!;
    return `mixed-list entry · ${TAG_META[inner.type].name}: ${previewValue(inner, 40)}`;
  }
  const id = m.get('id') ?? m.get('Name');
  if (id && id.type === TagType.String) {
    const count = m.get('count') ?? m.get('Count');
    const c = count && (count.type === TagType.Byte || count.type === TagType.Int) ? ` ×${count.value}` : '';
    return `${id.value}${c}`;
  }
  return null;
}

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** Parses user input for a primitive tag type, with range validation. */
export function parsePrimitive(type: TagType, input: string): ParseResult<number | bigint | string> {
  const s = input.trim();
  switch (type) {
    case TagType.String:
      return { ok: true, value: input };
    case TagType.Byte:
    case TagType.Short:
    case TagType.Int: {
      if (type === TagType.Byte && /^(true|false)$/i.test(s)) return { ok: true, value: /^true$/i.test(s) ? 1 : 0 };
      if (!/^[+-]?\d+$/.test(s)) return { ok: false, error: 'Enter a whole number' };
      const v = Number(s);
      const [lo, hi] = INT_RANGES[type]!;
      if (v < lo || v > hi) return { ok: false, error: `Must be between ${lo} and ${hi}` };
      return { ok: true, value: v };
    }
    case TagType.Long: {
      if (!/^[+-]?\d+$/.test(s)) return { ok: false, error: 'Enter a whole number' };
      const v = BigInt(s);
      if (v < -(1n << 63n) || v > (1n << 63n) - 1n) return { ok: false, error: 'Out of range for a 64-bit long' };
      return { ok: true, value: v };
    }
    case TagType.Float:
    case TagType.Double: {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) && !/^[+-]?(Infinity|NaN)$/.test(s)) {
        return { ok: false, error: 'Enter a number (e.g. 1.5 or -3e2)' };
      }
      const v = Number(s);
      if (type === TagType.Float) {
        const f = Math.fround(v);
        if (Number.isFinite(v) && !Number.isFinite(f)) return { ok: false, error: 'Out of range for a 32-bit float' };
        return { ok: true, value: f };
      }
      return { ok: true, value: v };
    }
    default:
      return { ok: false, error: 'Not a primitive type' };
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Renders a path array as Data.Player.Inventory[3].id */
export function formatPath(path: (string | number)[]): string {
  let s = '';
  for (const seg of path) {
    if (typeof seg === 'number') s += `[${seg}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) s += (s ? '.' : '') + seg;
    else s += `[${JSON.stringify(seg)}]`;
  }
  return s || '(root)';
}
