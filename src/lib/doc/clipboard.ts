/**
 * App clipboard shared by all tabs (exact tags + names), mirrored to the system clipboard as SNBT
 * so values can be pasted into /data commands, chat, or another NBT-Editor window.
 */
import { parseSnbt, toSnbt } from '../nbt/snbt';
import { cloneTag, TagType, type Tag } from '../nbt/types';
import type { NewItem } from './actions';

let items: NewItem[] = [];
let mirroredText: string | null = null;
const listeners = new Set<() => void>();

export function onClipboardChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clipboardItems(): NewItem[] {
  return items.map((i) => ({ name: i.name, tag: cloneTag(i.tag) }));
}

export function hasClipboard(): boolean {
  return items.length > 0;
}

export function clipboardSummary(): string {
  if (items.length === 0) return 'Clipboard is empty';
  if (items.length === 1) return items[0].name ? `"${items[0].name}"` : '1 tag';
  return `${items.length} tags`;
}

export function snbtFor(list: NewItem[]): string {
  if (list.length === 1) return toSnbt(list[0].tag);
  // Several named tags → a compound; several unnamed → a list.
  if (list.every((i) => i.name !== null)) {
    return toSnbt({ type: TagType.Compound, value: new Map(list.map((i) => [i.name!, i.tag])) });
  }
  return '[' + list.map((i) => toSnbt(i.tag)).join(',') + ']';
}

export async function copyItems(list: NewItem[]): Promise<void> {
  items = list.map((i) => ({ name: i.name, tag: cloneTag(i.tag) }));
  mirroredText = snbtFor(items);
  for (const l of listeners) l();
  try {
    await navigator.clipboard?.writeText(mirroredText);
  } catch {
    /* system clipboard is optional (permissions / insecure context) */
  }
}

/**
 * Resolves what to paste for a system paste event. If the text is what we put there, use the
 * exact internal items (keeps names and exact types); otherwise try to parse it as SNBT.
 */
export function itemsForPastedText(text: string | null): NewItem[] | { error: string } {
  if (text === null || text === '' || text === mirroredText) {
    if (items.length) return clipboardItems();
    return { error: 'Clipboard is empty' };
  }
  try {
    const tag: Tag = parseSnbt(text.trim());
    return [{ name: null, tag }];
  } catch (e) {
    if (items.length) return clipboardItems();
    return { error: `Clipboard text is not valid SNBT: ${(e as Error).message}` };
  }
}
