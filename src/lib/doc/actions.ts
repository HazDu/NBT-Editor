/**
 * High-level editing actions. Each one validates, builds Journal ops and commits them as one entry.
 * UI code calls these; it never mutates tags directly.
 */
import { formatPath, previewValue } from '../nbt/format';
import { cloneTag, TAG_META, TagType, type CompoundTag, type ContainerTag, type ListTag, type Tag } from '../nbt/types';
import type { Entry, Op } from './journal';
import { mapIndexOf } from './journal';
import { holderLabel, type ChunkNode, type Holder, type Workspace } from './model';
import { rowChain, rowPath, type Row } from './rows';

export type ActionResult = { ok: true; entry: Entry; select?: Tag } | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });

function where(holder: Holder, path: (string | number)[]): string {
  return `${holderLabel(holder)} › ${formatPath(path)}`;
}

function shortValue(tag: Tag): string {
  return previewValue(tag, 40);
}

/** Set a new value on a primitive or array tag. */
export function setValue(ws: Workspace, row: Row, value: Tag['value']): ActionResult {
  const { tag, holder } = row;
  if (!tag || !holder) return fail('Nothing selected');
  if (tag.type === TagType.Compound || tag.type === TagType.List) return fail('Containers have no single value');
  if (tag.value === value) return fail('Value unchanged');
  const before = tag.value;
  const beforePreview = shortValue(tag);
  const after = { type: tag.type, value } as Tag;
  const entry = ws.journal.commit({
    label: `Edit ${TAG_META[tag.type].name}`,
    icon: 'edit',
    ops: [{ kind: 'set', holder, tag, before, after: value }],
    where: where(holder, rowPath(row)),
    detail: `${beforePreview} → ${shortValue(after)}`,
    touched: rowChain(row),
    targets: [tag],
  });
  return { ok: true, entry };
}

/** Replace a whole tag (e.g. after editing it as SNBT). */
export function replaceTag(ws: Workspace, row: Row, next: Tag): ActionResult {
  const { tag, holder, parentTag, name } = row;
  if (!tag || !holder) return fail('Nothing selected');
  if (!parentTag || name === null) {
    if (next.type !== TagType.Compound && next.type !== TagType.List) return fail('The root must be a compound or list');
    // Replace root: swap contents in place to keep the root identity.
    const ops: Op[] = [];
    if (tag.type === TagType.Compound && next.type === TagType.Compound) {
      for (const [k, v] of tag.value) ops.push({ kind: 'remove', holder, parent: tag, key: k, position: 0, tag: v });
      for (const [k, v] of next.value) ops.push({ kind: 'insert', holder, parent: tag, key: k, tag: v });
    } else return fail('Root type cannot change');
    return {
      ok: true,
      entry: ws.journal.commit({ label: 'Replace root', icon: 'code', ops, where: where(holder, []), touched: [tag], targets: [tag] }),
      select: tag,
    };
  }
  if (parentTag.type === TagType.List && parentTag.value.length > 1 && next.type !== parentTag.elementType) {
    return fail(`This list holds ${TAG_META[parentTag.elementType].name} tags`);
  }
  const entry = ws.journal.commit({
    label: `Replace ${TAG_META[tag.type].name}`,
    icon: 'code',
    ops: [{ kind: 'replace', holder, parent: parentTag, key: name, before: tag, after: next }],
    where: where(holder, rowPath(row)),
    touched: rowChain(row).slice(0, -1),
    targets: [next],
  });
  return { ok: true, entry, select: next };
}

export function renameTag(ws: Workspace, row: Row, newName: string): ActionResult {
  const { tag, holder, parentTag, name } = row;
  if (!tag || !holder) return fail('Nothing selected');
  if (name === null) {
    // root name
    const root = holder.root!;
    if (root.name === newName) return fail('Name unchanged');
    const entry = ws.journal.commit({
      label: 'Rename root', icon: 'edit_note',
      ops: [{ kind: 'rootName', holder, before: root.name, after: newName }],
      where: holderLabel(holder), detail: `"${root.name}" → "${newName}"`, touched: [tag], targets: [tag],
    });
    return { ok: true, entry };
  }
  if (!parentTag || parentTag.type !== TagType.Compound || typeof name !== 'string') return fail('List entries have no name');
  if (newName === name) return fail('Name unchanged');
  if (parentTag.value.has(newName)) return fail(`"${newName}" already exists here`);
  const entry = ws.journal.commit({
    label: 'Rename', icon: 'edit_note',
    ops: [{ kind: 'rename', holder, parent: parentTag, from: name, to: newName }],
    where: where(holder, rowPath(row).slice(0, -1).concat(newName)),
    detail: `"${name}" → "${newName}"`,
    touched: rowChain(row), targets: [tag],
  });
  return { ok: true, entry };
}

/** True if `a` is a strict ancestor of `b` in the row tree. */
function isAncestor(a: Row, b: Row): boolean {
  for (let r = b.parent; r; r = r.parent) if (r === a) return true;
  return false;
}

export function deleteRows(ws: Workspace, rows: Row[]): ActionResult {
  const selected = rows.filter((r) => !rows.some((o) => o !== r && isAncestor(o, r)));
  const ops: Op[] = [];
  const targets: Tag[] = [];
  const touched: Tag[] = [];
  const names: string[] = [];
  // Delete list items from the highest index down so indices stay valid.
  const sorted = [...selected].sort((a, b) => (typeof b.name === 'number' && typeof a.name === 'number' ? b.name - a.name : 0));
  for (const row of sorted) {
    if (row.node?.kind === 'chunk') {
      ops.push({ kind: 'deleteChunk', holder: row.node as ChunkNode });
      names.push(row.node.name);
      continue;
    }
    const { tag, holder, parentTag, name } = row;
    if (!tag || !holder || !parentTag || name === null) continue;
    const position = parentTag.type === TagType.Compound ? mapIndexOf(parentTag.value, name as string) : (name as number);
    ops.push({ kind: 'remove', holder, parent: parentTag, key: name, position, tag, prevElemType: parentTag.type === TagType.List ? parentTag.elementType : undefined });
    touched.push(...rowChain(row).slice(0, -1));
    targets.push(parentTag);
    names.push(typeof name === 'number' ? `[${name}]` : name);
  }
  if (ops.length === 0) return fail('Select a tag or chunk to delete');
  const first = sorted[0];
  const holder = ops[0].holder;
  const entry = ws.journal.commit({
    label: ops.length === 1 ? `Delete ${names[0]}` : `Delete ${ops.length} items`,
    icon: 'delete',
    ops,
    where: first.holder ? where(first.holder, rowPath(first).slice(0, -1)) : holderLabel(holder as Holder),
    detail: names.length > 1 ? names.slice(0, 5).join(', ') + (names.length > 5 ? '…' : '') : undefined,
    touched,
    targets,
  });
  return { ok: true, entry };
}

/** Where new/pasted tags go: into a selected container, or next to a selected leaf. */
export function insertionPoint(row: Row): { container: ContainerTag; index: number | null; holder: Holder; chainRow: Row } | null {
  if (!row.tag || !row.holder) return null;
  if (row.tag.type === TagType.Compound || row.tag.type === TagType.List) {
    return { container: row.tag, index: null, holder: row.holder, chainRow: row };
  }
  if (row.parentTag && row.parent) {
    const idx = typeof row.name === 'number' ? row.name + 1 : null;
    return { container: row.parentTag, index: idx, holder: row.holder, chainRow: row.parent };
  }
  return null;
}

export function uniqueName(map: Map<string, Tag>, base: string): string {
  if (!map.has(base)) return base;
  let n = 1;
  let candidate = `${base} (copy)`;
  while (map.has(candidate)) candidate = `${base} (copy ${++n})`;
  return candidate;
}

export interface NewItem {
  name: string | null;
  tag: Tag;
}

/** Inserts one or more tags (add / paste / duplicate). Names are made unique in compounds. */
export function insertTags(
  ws: Workspace, row: Row, items: NewItem[], label: string, icon = 'add',
  at?: ReturnType<typeof insertionPoint>,
): ActionResult {
  const point = at ?? insertionPoint(row);
  if (!point) return fail('Select a compound, list or tag to insert next to');
  const { container, holder, chainRow } = point;
  const ops: Op[] = [];
  const pending = new Set<string>();
  let index = point.index ?? (container.type === TagType.List ? container.value.length : 0);
  let elemType = container.type === TagType.List ? (container.value.length ? container.elementType : TagType.End) : TagType.End;
  for (const item of items) {
    if (container.type === TagType.List) {
      if (elemType !== TagType.End && item.tag.type !== elemType) {
        return fail(`This list holds ${TAG_META[elemType].name} tags; cannot insert a ${TAG_META[item.tag.type].name}`);
      }
      ops.push({ kind: 'insert', holder, parent: container, key: index, tag: item.tag, prevElemType: (container as ListTag).elementType });
      elemType = item.tag.type;
      index++;
    } else {
      const map = new Map((container as CompoundTag).value);
      for (const p of pending) map.set(p, item.tag);
      const name = uniqueName(map, item.name ?? 'new');
      pending.add(name);
      ops.push({ kind: 'insert', holder, parent: container, key: name, tag: item.tag });
    }
  }
  if (ops.length === 0) return fail('Nothing to insert');
  const entry = ws.journal.commit({
    label, icon, ops,
    where: where(holder, rowPath(chainRow)),
    detail: items.length === 1 ? `${TAG_META[items[0].tag.type].name}${items[0].name ? ` "${items[0].name}"` : ''}` : `${items.length} tags`,
    touched: rowChain(chainRow),
    targets: items.map((i) => i.tag),
  });
  return { ok: true, entry, select: items[items.length - 1].tag };
}

export function duplicateRow(ws: Workspace, row: Row): ActionResult {
  if (!row.tag || !row.parentTag || row.name === null || !row.parent || !row.holder) return fail('Select a tag inside a compound or list');
  const index = typeof row.name === 'number' ? row.name + 1 : null;
  return insertTags(ws, row, [{ name: typeof row.name === 'string' ? row.name : null, tag: cloneTag(row.tag) }], 'Duplicate', 'content_copy',
    { container: row.parentTag, index, holder: row.holder, chainRow: row.parent });
}

export function moveRow(ws: Workspace, row: Row, delta: -1 | 1): ActionResult {
  const { parentTag, name, holder } = row;
  if (!parentTag || parentTag.type !== TagType.List || typeof name !== 'number' || !holder) return fail('Only list entries can be reordered');
  const to = name + delta;
  if (to < 0 || to >= parentTag.value.length) return fail('Already at the edge');
  const entry = ws.journal.commit({
    label: delta < 0 ? 'Move up' : 'Move down',
    icon: delta < 0 ? 'arrow_upward' : 'arrow_downward',
    ops: [{ kind: 'move', holder, parent: parentTag, from: name, to }],
    where: where(holder, rowPath(row)),
    detail: `[${name}] → [${to}]`,
    touched: rowChain(row).slice(0, -1),
    targets: [row.tag!],
  });
  return { ok: true, entry, select: row.tag };
}
