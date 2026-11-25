/**
 * Git-like change journal. Every mutation of NBT data is an Op with enough information to apply
 * and revert it — only the changed part is stored (a removed subtree, an old value), never a copy
 * of the file. Entries group ops into one undo step ("commit").
 *
 * Ops reference tag objects directly (not paths), so they stay valid across renames/moves; a path
 * snapshot is kept for display in the Changes panel.
 */
import { TagType, type CompoundTag, type ContainerTag, type ListTag, type Tag } from '../nbt/types';
import type { ChunkNode, Holder } from './model';

export type Op =
  | { kind: 'set'; holder: Holder; tag: Tag; before: Tag['value']; after: Tag['value'] }
  | { kind: 'rename'; holder: Holder; parent: CompoundTag; from: string; to: string }
  | { kind: 'insert'; holder: Holder; parent: ContainerTag; key: string | number; tag: Tag; prevElemType?: TagType; position?: number }
  | { kind: 'remove'; holder: Holder; parent: ContainerTag; key: string | number; position: number; tag: Tag; prevElemType?: TagType }
  | { kind: 'replace'; holder: Holder; parent: ContainerTag; key: string | number; before: Tag; after: Tag }
  | { kind: 'move'; holder: Holder; parent: ListTag; from: number; to: number }
  | { kind: 'rootName'; holder: Holder; before: string; after: string }
  | { kind: 'deleteChunk'; holder: ChunkNode; restore?: boolean };

export interface Entry {
  id: number;
  label: string;
  /** icon name for the Changes panel */
  icon: string;
  time: number;
  ops: Op[];
  /** human readable location, e.g. "level.dat › Data.Player.Health" */
  where: string;
  /** detail like "20 → 5" */
  detail?: string;
  /** tags along the path to each changed tag (root…target), for change markers */
  touched: Tag[];
  /** the directly changed tags */
  targets: Tag[];
}

let entryId = 1;

// ------------------------------------------------------------------- positional Map helpers

/** Rebuilds a Map with `key` inserted at `position` (Maps only append natively). */
export function mapInsertAt(map: Map<string, Tag>, key: string, value: Tag, position: number): void {
  if (position >= map.size) { map.set(key, value); return; }
  const entries = [...map.entries()];
  entries.splice(position, 0, [key, value]);
  map.clear();
  for (const [k, v] of entries) map.set(k, v);
}

export function mapRenameKey(map: Map<string, Tag>, from: string, to: string): void {
  const entries = [...map.entries()];
  map.clear();
  for (const [k, v] of entries) map.set(k === from ? to : k, v);
}

export function mapIndexOf(map: Map<string, Tag>, key: string): number {
  let i = 0;
  for (const k of map.keys()) {
    if (k === key) return i;
    i++;
  }
  return -1;
}

// ------------------------------------------------------------------------------- apply/revert

function applyOp(op: Op): void {
  switch (op.kind) {
    case 'set':
      (op.tag as { value: unknown }).value = op.after;
      break;
    case 'rename':
      mapRenameKey(op.parent.value, op.from, op.to);
      break;
    case 'insert':
      if (op.parent.type === TagType.Compound) {
        if (op.position !== undefined) mapInsertAt(op.parent.value, op.key as string, op.tag, op.position);
        else op.parent.value.set(op.key as string, op.tag);
      } else {
        op.parent.value.splice(op.key as number, 0, op.tag);
        op.parent.elementType = op.tag.type;
      }
      break;
    case 'remove':
      if (op.parent.type === TagType.Compound) op.parent.value.delete(op.key as string);
      else {
        op.parent.value.splice(op.key as number, 1);
        if (op.parent.value.length === 0) op.parent.elementType = TagType.End;
      }
      break;
    case 'replace':
      if (op.parent.type === TagType.Compound) op.parent.value.set(op.key as string, op.after);
      else op.parent.value[op.key as number] = op.after;
      break;
    case 'move': {
      const [t] = op.parent.value.splice(op.from, 1);
      op.parent.value.splice(op.to, 0, t);
      break;
    }
    case 'rootName':
      op.holder.root!.name = op.after;
      break;
    case 'deleteChunk':
      op.holder.deleted = !op.restore;
      break;
  }
  if (op.holder.kind === 'chunk') op.holder.modified = true;
}

function revertOp(op: Op): void {
  switch (op.kind) {
    case 'set':
      (op.tag as { value: unknown }).value = op.before;
      break;
    case 'rename':
      mapRenameKey(op.parent.value, op.to, op.from);
      break;
    case 'insert':
      if (op.parent.type === TagType.Compound) op.parent.value.delete(op.key as string);
      else {
        op.parent.value.splice(op.key as number, 1);
        op.parent.elementType = op.prevElemType ?? op.parent.elementType;
      }
      break;
    case 'remove':
      if (op.parent.type === TagType.Compound) mapInsertAt(op.parent.value, op.key as string, op.tag, op.position);
      else {
        op.parent.value.splice(op.key as number, 0, op.tag);
        op.parent.elementType = op.tag.type;
      }
      break;
    case 'replace':
      if (op.parent.type === TagType.Compound) op.parent.value.set(op.key as string, op.before);
      else op.parent.value[op.key as number] = op.before;
      break;
    case 'move': {
      const [t] = op.parent.value.splice(op.to, 1);
      op.parent.value.splice(op.from, 0, t);
      break;
    }
    case 'rootName':
      op.holder.root!.name = op.before;
      break;
    case 'deleteChunk':
      op.holder.deleted = !!op.restore;
      break;
  }
}

// ------------------------------------------------------------------------------------ journal

export class Journal {
  entries: Entry[] = [];
  /** number of entries currently applied */
  index = 0;
  /** value of `index` at the last save (-1 = the save point was discarded by a new branch) */
  savedIndex = 0;
  onChange: (() => void) | null = null;
  private markerCache: { direct: Map<Tag, number>; ancestor: Set<Tag>; key: string } | null = null;

  commit(e: Omit<Entry, 'id' | 'time'>): Entry {
    if (e.ops.length === 0) throw new Error('Empty journal entry');
    for (const op of e.ops) applyOp(op);
    // Committing after undo discards the redo branch (like a new commit on a rewound branch).
    if (this.index < this.entries.length) {
      if (this.savedIndex > this.index) this.savedIndex = -1;
      this.entries.length = this.index;
    }
    const entry: Entry = { ...e, id: entryId++, time: Date.now() };
    this.entries.push(entry);
    this.index++;
    this.changed();
    return entry;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length;
  }

  undo(): Entry | null {
    if (!this.canUndo) return null;
    const e = this.entries[--this.index];
    for (let i = e.ops.length - 1; i >= 0; i--) revertOp(e.ops[i]);
    this.changed();
    return e;
  }

  redo(): Entry | null {
    if (!this.canRedo) return null;
    const e = this.entries[this.index++];
    for (const op of e.ops) applyOp(op);
    this.changed();
    return e;
  }

  /** Reverts one specific applied entry (git revert) by committing its inverse. */
  revertEntry(entry: Entry): void {
    const pos = this.entries.indexOf(entry);
    if (pos < 0 || pos >= this.index) return;
    if (pos === this.index - 1) { this.undo(); return; }
    // Build inverse ops; only valid when the target objects are still in place, which holds for
    // independent edits. Inverse of a sequence is reversed inverses.
    const inv: Op[] = [];
    for (let i = entry.ops.length - 1; i >= 0; i--) inv.push(invert(entry.ops[i]));
    this.commit({ ...entry, label: `Revert: ${entry.label}`, icon: 'history', ops: inv });
  }

  get hasUnsaved(): boolean {
    return this.index !== this.savedIndex;
  }

  /** Called after a download: the current state becomes the "saved" state (clears dirty markers). */
  markSaved(): void {
    this.savedIndex = this.index;
    this.changed();
  }

  /** Entries that differ between the save point and the current state. */
  unsavedEntries(): Entry[] {
    if (this.savedIndex < 0) return this.entries.slice(0, Math.max(this.index, 0)).concat();
    const lo = Math.min(this.index, this.savedIndex);
    const hi = Math.max(this.index, this.savedIndex);
    return this.entries.slice(lo, hi);
  }

  unsavedHolders(): Set<Holder> {
    const set = new Set<Holder>();
    if (this.savedIndex < 0) {
      // Save point lost: everything ever touched is considered dirty.
      for (const e of this.entries) for (const op of e.ops) set.add(op.holder);
      return set;
    }
    for (const e of this.unsavedEntries()) for (const op of e.ops) set.add(op.holder);
    return set;
  }

  /**
   * Temporarily rewinds to the original as opened (files on disk are never overwritten), runs `fn`
   * synchronously, then restores the current state. Used to rebuild a `.backup` when the original
   * File can no longer be read.
   */
  atOriginal<T>(fn: () => T): T {
    const cur = this.index;
    const quiet = this.onChange;
    this.onChange = null;
    try {
      while (this.index > 0) this.undo();
      return fn();
    } finally {
      while (this.index < cur) this.redo();
      this.onChange = quiet;
    }
  }

  /** Change markers: tags directly changed, and their ancestors (for "something inside changed"). */
  markers(): { direct: Map<Tag, number>; ancestor: Set<Tag> } {
    const key = `${this.index}:${this.savedIndex}:${this.entries.length}`;
    if (this.markerCache?.key === key) return this.markerCache;
    const direct = new Map<Tag, number>();
    const ancestor = new Set<Tag>();
    for (const e of this.unsavedEntries()) {
      for (const t of e.targets) direct.set(t, (direct.get(t) ?? 0) + 1);
      for (const t of e.touched) ancestor.add(t);
    }
    this.markerCache = { direct, ancestor, key };
    return this.markerCache;
  }

  private changed(): void {
    this.markerCache = null;
    this.onChange?.();
  }
}

function invert(op: Op): Op {
  switch (op.kind) {
    case 'set': return { ...op, before: op.after, after: op.before };
    case 'rename': return { ...op, from: op.to, to: op.from };
    case 'insert': {
      const position = op.parent.type === TagType.Compound ? mapIndexOf(op.parent.value, op.key as string) : (op.key as number);
      return { kind: 'remove', holder: op.holder, parent: op.parent, key: op.key, position, tag: op.tag, prevElemType: op.prevElemType };
    }
    case 'remove': return { kind: 'insert', holder: op.holder, parent: op.parent, key: op.key, tag: op.tag, prevElemType: op.prevElemType, position: op.position };
    case 'replace': return { ...op, before: op.after, after: op.before };
    case 'move': return { ...op, from: op.to, to: op.from };
    case 'rootName': return { ...op, before: op.after, after: op.before };
    case 'deleteChunk': return { ...op, restore: !op.restore };
  }
}
