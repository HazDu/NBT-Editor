/**
 * Flattens the expanded part of a workspace into rows for the virtualized tree.
 * Only expanded containers are visited, so cost is proportional to what is visible-ish,
 * not to the file size.
 */
import { TagType, type ContainerTag, type Tag } from '../nbt/types';
import { isHolder, type Holder, type SourceNode } from './model';

export interface Row {
  /** identity: source node or tag object */
  key: object;
  depth: number;
  parent: Row | null;
  /** source-node rows */
  node?: SourceNode;
  /** tag rows */
  tag?: Tag;
  holder?: Holder;
  /** compound key (string), list index (number) or null for a holder root */
  name: string | number | null;
  parentTag?: ContainerTag;
  expandable: boolean;
  expanded: boolean;
}

export type SortMode = 'file' | 'name';

export interface RowOptions {
  expanded: WeakSet<object>;
  sort: SortMode;
}

const TYPE_ORDER: Record<number, number> = { 10: 0, 9: 1, 7: 2, 11: 2, 12: 2 };

function sortedEntries(map: Map<string, Tag>, sort: SortMode): [string, Tag][] {
  const entries = [...map.entries()];
  if (sort === 'name') {
    entries.sort(([ak, av], [bk, bv]) => {
      const ta = TYPE_ORDER[av.type] ?? 3, tb = TYPE_ORDER[bv.type] ?? 3;
      return ta - tb || ak.localeCompare(bk, undefined, { numeric: true, sensitivity: 'base' });
    });
  }
  return entries;
}

export function buildRows(root: SourceNode, opts: RowOptions): Row[] {
  const rows: Row[] = [];

  const pushTagChildren = (container: ContainerTag, holder: Holder, depth: number, parent: Row) => {
    if (container.type === TagType.Compound) {
      for (const [k, t] of sortedEntries(container.value, opts.sort)) pushTag(t, k, container, holder, depth, parent);
    } else {
      const items = container.value;
      for (let i = 0; i < items.length; i++) pushTag(items[i], i, container, holder, depth, parent);
    }
  };

  const pushTag = (tag: Tag, name: string | number, parentTag: ContainerTag, holder: Holder, depth: number, parent: Row) => {
    const isC = tag.type === TagType.Compound || tag.type === TagType.List;
    const size = tag.type === TagType.Compound ? tag.value.size : tag.type === TagType.List ? tag.value.length : 0;
    const expanded = isC && opts.expanded.has(tag);
    const row: Row = { key: tag, depth, parent, tag, holder, name, parentTag, expandable: isC && size > 0, expanded };
    rows.push(row);
    if (expanded) pushTagChildren(tag as ContainerTag, holder, depth + 1, row);
  };

  const pushNode = (node: SourceNode, depth: number, parent: Row | null) => {
    if (node.kind === 'chunk' && node.deleted) return;
    const expanded = opts.expanded.has(node);
    const row: Row = { key: node, depth, parent, node, name: null, expandable: true, expanded };
    if (isHolder(node) && node.root) {
      row.tag = node.root.tag;
      row.holder = node;
    }
    rows.push(row);
    if (!expanded || node.state !== 'ready') return;
    if (node.kind === 'folder') for (const c of node.children ?? []) pushNode(c, depth + 1, row);
    else if (node.kind === 'region') for (const c of node.chunks ?? []) pushNode(c, depth + 1, row);
    else if (node.root) {
      const t = node.root.tag;
      if (t.type === TagType.Compound || t.type === TagType.List) pushTagChildren(t, node, depth + 1, row);
    }
  };

  pushNode(root, 0, null);
  return rows;
}

/** Path from the holder root to this row's tag, e.g. ['Data', 'Player', 'Inventory', 3]. */
export function rowPath(row: Row): (string | number)[] {
  const path: (string | number)[] = [];
  let r: Row | null = row;
  while (r && r.name !== null) {
    path.push(r.name);
    r = r.parent;
  }
  return path.reverse();
}

/** Tags from the holder root down to this row's tag. */
export function rowChain(row: Row): Tag[] {
  const chain: Tag[] = [];
  let r: Row | null = row;
  while (r && r.tag) {
    chain.push(r.tag);
    if (r.name === null) break;
    r = r.parent;
  }
  return chain.reverse();
}

/**
 * Finds the chain of tags to `target` inside `root` (DFS). Used to reveal a tag in the tree
 * (search results, Changes panel "jump to").
 */
export function findTagPath(root: Tag, target: Tag): { path: (string | number)[]; chain: Tag[] } | null {
  if (root === target) return { path: [], chain: [root] };
  const stack: { tag: Tag; path: (string | number)[]; chain: Tag[] }[] = [{ tag: root, path: [], chain: [root] }];
  while (stack.length) {
    const { tag, path, chain } = stack.pop()!;
    if (tag.type === TagType.Compound) {
      for (const [k, v] of tag.value) {
        if (v === target) return { path: [...path, k], chain: [...chain, v] };
        if (v.type === TagType.Compound || v.type === TagType.List) stack.push({ tag: v, path: [...path, k], chain: [...chain, v] });
      }
    } else if (tag.type === TagType.List) {
      for (let i = 0; i < tag.value.length; i++) {
        const v = tag.value[i];
        if (v === target) return { path: [...path, i], chain: [...chain, v] };
        if (v.type === TagType.Compound || v.type === TagType.List) stack.push({ tag: v, path: [...path, i], chain: [...chain, v] });
      }
    }
  }
  return null;
}

/** Resolves a path to tags (root…target); null if the path no longer exists. */
export function resolvePath(root: Tag, path: (string | number)[]): Tag[] | null {
  const chain: Tag[] = [root];
  let t: Tag = root;
  for (const seg of path) {
    let next: Tag | undefined;
    if (t.type === TagType.Compound && typeof seg === 'string') next = t.value.get(seg);
    else if (t.type === TagType.List && typeof seg === 'number') next = t.value[seg];
    if (!next) return null;
    chain.push(next);
    t = next;
  }
  return chain;
}
