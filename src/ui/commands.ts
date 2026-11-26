/**
 * Every user action, defined once. The toolbar, context menu, keyboard shortcuts and the
 * shortcut help all read from this registry so labels/icons/shortcuts never drift apart.
 */
import * as actions from '../lib/doc/actions';
import { copyItems, hasClipboard, itemsForPastedText, snbtFor } from '../lib/doc/clipboard';
import { FolderNode, newEmptyFile, nodeForFile, OPEN_EXTENSIONS, Workspace } from '../lib/doc/model';
import { rowPath, type Row } from '../lib/doc/rows';
import { pickDirectory, pickFiles, type DirLike, type PickedFile } from '../lib/fs/access';
import { searchValueText } from '../lib/search/query';
import { formatPath } from '../lib/nbt/format';
import { toSnbt } from '../lib/nbt/snbt';
import { defaultTag, TAG_META, TagType } from '../lib/nbt/types';
import { app, type Tab } from './state.svelte';

export interface Command {
  id: string;
  label: string;
  icon: string;
  /** display form, e.g. "Ctrl+S" */
  keys?: string;
  group: 'File' | 'Edit' | 'Tree' | 'Search' | 'View' | 'Help';
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

const tab = () => app.active;
const row = () => app.active?.focusedRow ?? null;
const sel = () => {
  const t = app.active;
  if (!t) return [];
  const rows = t.selectedRows;
  return rows.length ? rows : t.focusedRow ? [t.focusedRow] : [];
};

function report(r: actions.ActionResult, t: Tab): void {
  if (!r.ok) {
    if (r.error !== 'Value unchanged' && r.error !== 'Name unchanged') app.toast('warn', r.error);
    return;
  }
  app.lastEntry = r.entry;
  if (r.select) {
    const target = r.select;
    // Open the containers the new tag was inserted into, so it is visible.
    for (const tag of r.entry.touched) t.expanded.add(tag);
    t.expandTick++;
    // Rows rebuild synchronously from the version bump; select after the parent is expanded.
    queueMicrotask(() => {
      const holder = t.rows.find((x) => x.tag === target)?.holder;
      if (holder || t.rowIndex.has(target)) {
        t.select(target);
        t.scrollRequest++;
      }
    });
  }
}

const isTagRow = (r: Row | null): r is Row => !!r && !!r.tag && !!r.holder;
const isEditableValue = (r: Row | null) =>
  isTagRow(r) && r.tag!.type !== TagType.Compound && r.tag!.type !== TagType.List;

// ------------------------------------------------------------------------------------- opening

function sameFile(a: PickedFile, ws: Workspace): boolean {
  const n = ws.root;
  if (n.kind !== 'nbt' && n.kind !== 'region') return false;
  const f = n.source.file as File | null;
  return !!f && f.name === a.file.name && f.size === a.file.size && f.lastModified === a.file.lastModified;
}

export function openPicked(files: PickedFile[]): void {
  for (const p of files) {
    const existing = app.tabs.find((t) => sameFile(p, t.ws));
    if (existing) {
      app.active = existing;
      continue;
    }
    const node = nodeForFile(p.file.name, { file: p.file, handle: p.handle });
    app.addTab(new Workspace(node));
  }
}

export function openDirectory(dir: DirLike): void {
  app.addTab(new Workspace(new FolderNode(dir)));
}

async function openFiles(): Promise<void> {
  try {
    openPicked(await pickFiles({ description: 'Minecraft NBT files', extensions: OPEN_EXTENSIONS }));
  } catch (e) {
    app.toast('error', `Could not open: ${(e as Error).message}`);
  }
}

async function openFolder(): Promise<void> {
  try {
    const dir = await pickDirectory();
    if (dir) openDirectory(dir);
  } catch (e) {
    app.toast('error', `Could not open folder: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------------------------ clipboard

export async function copySelection(cut = false): Promise<void> {
  const t = tab();
  const rows = sel().filter(isTagRow);
  if (!t || rows.length === 0) return;
  await copyItems(rows.map((r) => ({ name: typeof r.name === 'string' ? r.name : r.holder!.root?.name || null, tag: r.tag! })));
  app.clipboardTick++;
  if (cut) {
    const deletable = rows.filter((r) => r.parentTag);
    if (deletable.length) report(actions.deleteRows(t.ws, deletable), t);
    app.toast('info', `Cut ${rows.length === 1 ? '1 tag' : `${rows.length} tags`}`);
  } else {
    app.toast('info', `Copied ${rows.length === 1 ? '1 tag' : `${rows.length} tags`} · also on your system clipboard as SNBT`);
  }
}

export function pasteText(text: string | null): void {
  const t = tab();
  const r = row();
  if (!t || !isTagRow(r)) {
    app.toast('warn', 'Select where to paste first');
    return;
  }
  const items = itemsForPastedText(text);
  if ('error' in items) {
    app.toast('warn', items.error);
    return;
  }
  report(actions.insertTags(t.ws, r, items, items.length === 1 ? 'Paste' : `Paste ${items.length} tags`, 'content_paste'), t);
}

// ------------------------------------------------------------------------------------- editing

export function startEdit(field: 'name' | 'value'): void {
  const t = tab();
  const r = row();
  if (!t || !r) return;
  if (field === 'value' && !isEditableValue(r)) {
    if (r.expandable || r.node) t.toggle(r);
    return;
  }
  if (field === 'value' && (r.tag!.type === TagType.ByteArray || r.tag!.type === TagType.IntArray || r.tag!.type === TagType.LongArray)) {
    document.querySelector<HTMLElement>('[data-array-editor]')?.focus();
    return;
  }
  if (field === 'name' && (!isTagRow(r) || typeof r.name === 'number')) {
    app.toast('warn', 'List entries have no name');
    return;
  }
  t.editing = { key: r.key, field };
}

export function addTag(type: TagType): void {
  const t = tab();
  const r = row();
  if (!t || !isTagRow(r)) {
    app.toast('warn', 'Select a compound, list or tag first');
    return;
  }
  const point = actions.insertionPoint(r);
  if (!point) return;
  if (point.container.type === TagType.List) {
    // Lists need no name: insert a default value directly.
    t.expanded.add(point.container);
    report(actions.insertTags(t.ws, r, [{ name: null, tag: defaultTag(type) }], `Add ${TAG_META[type].name}`, 'add'), t);
    return;
  }
  app.dialog = { kind: 'addTag', tab: t, row: r, type };
}

export function undo(): void {
  const t = tab();
  const e = t?.ws.journal.undo();
  if (e) app.toast('info', `Undid: ${e.label}`);
}

export function redo(): void {
  const t = tab();
  const e = t?.ws.journal.redo();
  if (e) app.toast('info', `Redid: ${e.label}`);
}

function holderPathLabel(r: Row): string {
  return formatPath(rowPath(r));
}

export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    app.toast('info', `Copied ${what}`);
  } catch {
    app.toast('warn', 'The browser blocked clipboard access');
  }
}

export function requestClose(t: Tab): void {
  if (t.ws.isDirty) app.dialog = { kind: 'confirmClose', tab: t };
  else app.closeTab(t);
}

// -------------------------------------------------------------------------------------- registry

export const commands: Record<string, Command> = {};
function def(c: Command): Command {
  commands[c.id] = c;
  return c;
}

const hasTab = () => !!app.active;
const hasTagSel = () => isTagRow(row());

def({ id: 'open', label: 'Open files', icon: 'file_open', keys: 'Ctrl+O', group: 'File', run: openFiles });
def({ id: 'openFolder', label: 'Open world folder', icon: 'folder_open', keys: 'Ctrl+Shift+O', group: 'File', run: openFolder });
def({
  id: 'newFile', label: 'New NBT file', icon: 'note_add', keys: 'Alt+N', group: 'File',
  run: () => { app.addTab(new Workspace(newEmptyFile())); },
});
def({
  id: 'download', label: 'Download…', icon: 'download', keys: 'Ctrl+S', group: 'File', enabled: hasTab,
  run: () => { if (app.active) app.dialog = { kind: 'export', tab: app.active }; },
});
def({
  id: 'closeTab', label: 'Close tab', icon: 'close', keys: 'Alt+W', group: 'File', enabled: hasTab,
  run: () => { if (app.active) requestClose(app.active); },
});

def({ id: 'undo', label: 'Undo', icon: 'undo', keys: 'Ctrl+Z', group: 'Edit', enabled: () => !!app.active?.ws.journal.canUndo, run: undo });
def({ id: 'redo', label: 'Redo', icon: 'redo', keys: 'Ctrl+Y', group: 'Edit', enabled: () => !!app.active?.ws.journal.canRedo, run: redo });
def({ id: 'cut', label: 'Cut', icon: 'content_cut', keys: 'Ctrl+X', group: 'Edit', enabled: () => sel().some((r) => isTagRow(r) && !!r.parentTag), run: () => copySelection(true) });
def({ id: 'copy', label: 'Copy', icon: 'content_copy', keys: 'Ctrl+C', group: 'Edit', enabled: () => sel().some(isTagRow), run: () => copySelection(false) });
def({
  id: 'paste', label: 'Paste', icon: 'content_paste', keys: 'Ctrl+V', group: 'Edit',
  enabled: () => (void app.clipboardTick, hasClipboard() && hasTagSel()),
  run: () => pasteText(null),
});
def({
  id: 'pasteSnbt', label: 'Insert from SNBT…', icon: 'code', group: 'Edit', enabled: hasTagSel,
  run: () => { const t = tab(), r = row(); if (t && r) app.dialog = { kind: 'snbt', tab: t, row: r, mode: 'insert' }; },
});
def({
  id: 'delete', label: 'Delete', icon: 'delete', keys: 'Del', group: 'Edit',
  enabled: () => sel().some((r) => (isTagRow(r) && !!r.parentTag) || r.node?.kind === 'chunk'),
  run: () => { const t = tab(); if (t) report(actions.deleteRows(t.ws, sel()), t); },
});
def({ id: 'rename', label: 'Rename', icon: 'edit_note', keys: 'F2', group: 'Edit', enabled: () => isTagRow(row()) && typeof row()!.name !== 'number', run: () => startEdit('name') });
def({ id: 'editValue', label: 'Edit value', icon: 'edit', keys: 'Enter', group: 'Edit', enabled: () => isEditableValue(row()), run: () => startEdit('value') });
def({
  id: 'editSnbt', label: 'Edit as SNBT…', icon: 'code', keys: 'Shift+Enter', group: 'Edit', enabled: hasTagSel,
  run: () => { const t = tab(), r = row(); if (t && isTagRow(r)) app.dialog = { kind: 'snbt', tab: t, row: r, mode: 'edit' }; },
});
def({
  id: 'duplicate', label: 'Duplicate', icon: 'library_add', keys: 'Ctrl+D', group: 'Edit',
  enabled: () => isTagRow(row()) && !!row()!.parentTag,
  run: () => { const t = tab(), r = row(); if (t && r) report(actions.duplicateRow(t.ws, r), t); },
});
def({
  id: 'moveUp', label: 'Move up', icon: 'arrow_upward', keys: 'Alt+↑', group: 'Edit',
  enabled: () => typeof row()?.name === 'number' && (row()!.name as number) > 0,
  run: () => { const t = tab(), r = row(); if (t && r) report(actions.moveRow(t.ws, r, -1), t); },
});
def({
  id: 'moveDown', label: 'Move down', icon: 'arrow_downward', keys: 'Alt+↓', group: 'Edit',
  enabled: () => {
    const r = row();
    return typeof r?.name === 'number' && r.parentTag?.type === TagType.List && r.name < r.parentTag.value.length - 1;
  },
  run: () => { const t = tab(), r = row(); if (t && r) report(actions.moveRow(t.ws, r, 1), t); },
});
def({
  id: 'copyPath', label: 'Copy path', icon: 'conversion_path', group: 'Edit', enabled: hasTagSel,
  run: () => { const r = row(); if (r) void copyText(holderPathLabel(r), 'path'); },
});
def({
  id: 'copySnbt', label: 'Copy as SNBT', icon: 'code', group: 'Edit', enabled: hasTagSel,
  run: () => {
    const r = row();
    if (r?.tag) void copyText(snbtFor([{ name: null, tag: r.tag }]) || toSnbt(r.tag), 'SNBT');
  },
});

def({
  id: 'expandAll', label: 'Expand all below', icon: 'unfold_more', keys: '*', group: 'Tree', enabled: () => !!row(),
  run: () => { const t = tab(), r = row(); if (t && r) t.expandAll(r); },
});
def({
  id: 'collapseAll', label: 'Collapse all', icon: 'unfold_less', keys: '-', group: 'Tree', enabled: hasTab,
  run: () => tab()?.collapseAll(null),
});
def({
  id: 'sort', label: 'Sort keys A–Z', icon: 'sort_by_alpha', group: 'Tree', enabled: hasTab,
  run: () => { const t = tab(); if (t) t.sort = t.sort === 'name' ? 'file' : 'name'; },
});

def({ id: 'find', label: 'Search', icon: 'search', keys: 'Ctrl+F', group: 'Search', run: () => { app.setPanel('search'); queueMicrotask(() => document.querySelector<HTMLInputElement>('[data-search-input]')?.focus()); } });
def({
  id: 'findValue', label: 'Find this value everywhere', icon: 'manage_search', keys: 'Ctrl+Shift+F', group: 'Search',
  enabled: () => { const r = row(); return isTagRow(r) && searchValueText(r.tag!) !== null; },
  run: () => {
    const r = row();
    const value = r?.tag ? searchValueText(r.tag) : null;
    if (value === null) return;
    app.searchRequest = { value };
    app.setPanel('search');
  },
});
def({ id: 'changes', label: 'Changes', icon: 'history', keys: 'Alt+H', group: 'Search', run: () => app.setPanel(app.panel === 'changes' ? null : 'changes') });
def({
  id: 'theme', label: 'Switch theme', icon: 'contrast', group: 'View',
  run: () => app.setTheme(app.theme === 'system' ? 'dark' : app.theme === 'dark' ? 'light' : 'system'),
});
def({ id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', keys: '?', group: 'Help', run: () => { app.dialog = { kind: 'shortcuts' }; } });
def({ id: 'about', label: 'About NBT-Editor', icon: 'info', group: 'Help', run: () => { app.dialog = { kind: 'about' }; } });

