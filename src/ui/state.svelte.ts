/**
 * Reactive UI state. Documents are NOT deep-reactive: each Tab mirrors its Workspace's `version`
 * counter into a $state field, and rows are $derived from it.
 */
import { buildRows, type Row, type SortMode } from '../lib/doc/rows';
import { isHolder, loadNode, type Holder, type SourceNode, type Workspace } from '../lib/doc/model';
import { TagType, type Tag } from '../lib/nbt/types';
import type { Entry } from '../lib/doc/journal';

export class Tab {
  readonly ws: Workspace;
  version = $state(0);
  expandTick = $state(0);
  readonly expanded = new WeakSet<object>();
  selection = $state.raw<Set<object>>(new Set());
  focusKey = $state.raw<object | null>(null);
  anchorKey: object | null = null;
  sort = $state<SortMode>('file');
  editing = $state.raw<{ key: object; field: 'name' | 'value' } | null>(null);
  /** incremented to ask the tree to scroll the focused row into view */
  scrollRequest = $state(0);

  rows = $derived.by<Row[]>(() => {
    void this.version;
    void this.expandTick;
    return buildRows(this.ws.root, { expanded: this.expanded, sort: this.sort });
  });

  rowIndex = $derived.by(() => {
    const m = new Map<object, number>();
    const rows = this.rows;
    for (let i = 0; i < rows.length; i++) m.set(rows[i].key, i);
    return m;
  });

  constructor(ws: Workspace) {
    this.ws = ws;
    ws.subscribe(() => {
      this.version = ws.version;
    });
  }

  get title(): string {
    return this.ws.title;
  }

  get focusedRow(): Row | null {
    if (!this.focusKey) return null;
    const i = this.rowIndex.get(this.focusKey);
    return i === undefined ? null : this.rows[i];
  }

  get selectedRows(): Row[] {
    const out: Row[] = [];
    for (const k of this.selection) {
      const i = this.rowIndex.get(k);
      if (i !== undefined) out.push(this.rows[i]);
    }
    return out.sort((a, b) => this.rowIndex.get(a.key)! - this.rowIndex.get(b.key)!);
  }

  // ------------------------------------------------------------------ expansion

  async expand(row: Row): Promise<void> {
    if (row.node && row.node.state !== 'ready') {
      this.expanded.add(row.key);
      this.expandTick++;
      await this.ws.load(row.node);
      this.afterLoad(row.node);
      return;
    }
    if (!row.expandable) return;
    this.expanded.add(row.key);
    this.expandTick++;
  }

  /** Auto-expand a freshly loaded holder's root compound if it is small, so content is visible. */
  private afterLoad(node: SourceNode): void {
    if (node.state === 'ready') this.expandTick++;
  }

  collapse(row: Row): void {
    this.expanded.delete(row.key);
    this.expandTick++;
  }

  toggle(row: Row): void {
    if (this.expanded.has(row.key)) this.collapse(row);
    else void this.expand(row);
  }

  /** Expands every container below a row (bounded, to stay responsive). */
  expandAll(row: Row, limit = 20000): void {
    let budget = limit;
    const walk = (t: Tag) => {
      if (budget-- <= 0) return;
      if (t.type === TagType.Compound) { this.expanded.add(t); for (const c of t.value.values()) walk(c); }
      else if (t.type === TagType.List) { this.expanded.add(t); for (const c of t.value) walk(c); }
    };
    if (row.node) this.expanded.add(row.node);
    if (row.tag) walk(row.tag);
    this.expandTick++;
  }

  collapseAll(row: Row | null): void {
    const target = row ?? this.rows[0];
    if (!target) return;
    const walk = (t: Tag) => {
      if (t.type === TagType.Compound) { this.expanded.delete(t); for (const c of t.value.values()) walk(c); }
      else if (t.type === TagType.List) { this.expanded.delete(t); for (const c of t.value) walk(c); }
    };
    if (target.tag) walk(target.tag);
    if (target.node && target.node.kind !== 'folder') this.expanded.delete(target.node);
    if (!row) {
      // whole tab: keep the root open
      for (const r of this.rows) if (r.depth > 0) this.expanded.delete(r.key);
    }
    this.expandTick++;
  }

  // ------------------------------------------------------------------ selection

  select(key: object, mode: 'single' | 'toggle' | 'range' = 'single'): void {
    if (mode === 'single' || !this.anchorKey) {
      this.selection = new Set([key]);
      this.anchorKey = key;
    } else if (mode === 'toggle') {
      const s = new Set(this.selection);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      this.selection = s;
      this.anchorKey = key;
    } else {
      const a = this.rowIndex.get(this.anchorKey) ?? 0;
      const b = this.rowIndex.get(key) ?? 0;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      this.selection = new Set(this.rows.slice(lo, hi + 1).map((r) => r.key));
    }
    this.focusKey = key;
  }

  focusIndex(i: number, mode: 'single' | 'range' = 'single'): void {
    const rows = this.rows;
    if (rows.length === 0) return;
    const idx = Math.max(0, Math.min(rows.length - 1, i));
    this.select(rows[idx].key, mode);
    this.scrollRequest++;
  }

  /** Expands everything needed to show `target` (a tag inside `holder`) and selects it. */
  async reveal(holder: Holder, chain: Tag[]): Promise<void> {
    const nodes: SourceNode[] = [];
    for (let n: SourceNode | null = holder; n; n = n.parent) nodes.unshift(n);
    for (const n of nodes) {
      if (n.state !== 'ready') await this.ws.load(n);
      this.expanded.add(n);
    }
    // chain[0] is the holder's root tag (represented by the holder row)
    for (let i = 1; i < chain.length - 1; i++) this.expanded.add(chain[i]);
    this.expandTick++;
    const key = chain.length > 1 ? chain[chain.length - 1] : holder;
    this.select(key);
    this.scrollRequest++;
  }

  async revealNode(node: SourceNode): Promise<void> {
    for (let n: SourceNode | null = node.parent; n; n = n.parent) {
      if (n.state !== 'ready') await this.ws.load(n);
      this.expanded.add(n);
    }
    this.expandTick++;
    this.select(node);
    this.scrollRequest++;
  }
}

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'error' | 'warn';
  text: string;
  action?: { label: string; run: () => void };
}

export type Dialog =
  | { kind: 'export'; tab: Tab }
  | { kind: 'addTag'; tab: Tab; row: Row; type: TagType }
  | { kind: 'confirmClose'; tab: Tab }
  | { kind: 'about' }
  | { kind: 'shortcuts' }
  | { kind: 'snbt'; tab: Tab; row: Row; mode: 'edit' | 'insert' };

export type Theme = 'system' | 'light' | 'dark';

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode etc. */
  }
}

let toastId = 1;

class AppState {
  tabs = $state<Tab[]>([]);
  active = $state.raw<Tab | null>(null);
  toasts = $state<Toast[]>([]);
  dialog = $state.raw<Dialog | null>(null);
  menu = $state.raw<{ x: number; y: number; tab: Tab; row: Row | null } | null>(null);
  panel = $state<'search' | 'changes' | null>(stored('nbt.panel', null));
  theme = $state<Theme>(stored('nbt.theme', 'system'));
  backupOnSave = $state<boolean>(stored('nbt.backup', true));
  inspectorWidth = $state<number>(stored('nbt.inspectorWidth', 340));
  clipboardTick = $state(0);
  /** set by "Find this value"; the search panel picks it up, fills the form and runs it */
  searchRequest = $state.raw<{ value: string } | null>(null);
  /** entry highlighted in the Changes panel */
  lastEntry = $state.raw<Entry | null>(null);

  setTheme(t: Theme): void {
    this.theme = t;
    persist('nbt.theme', t);
    applyTheme(t);
  }

  setBackup(v: boolean): void {
    this.backupOnSave = v;
    persist('nbt.backup', v);
  }

  setPanel(p: 'search' | 'changes' | null): void {
    this.panel = p;
    persist('nbt.panel', p);
  }

  setInspectorWidth(w: number): void {
    this.inspectorWidth = w;
    persist('nbt.inspectorWidth', w);
  }

  toast(kind: Toast['kind'], text: string, action?: Toast['action']): void {
    const t: Toast = { id: toastId++, kind, text, action };
    this.toasts = [...this.toasts.slice(-3), t];
    setTimeout(() => this.dismiss(t.id), kind === 'error' ? 8000 : 4000);
  }

  dismiss(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  addTab(ws: Workspace): Tab {
    const tab = new Tab(ws);
    tab.expanded.add(ws.root);
    this.tabs = [...this.tabs, tab];
    this.active = tab;
    tab.select(ws.root);
    void ws.load(ws.root).then(() => {
      // Open the first level of a single file automatically.
      const root = ws.root;
      if (isHolder(root) && root.root) tab.expandTick++;
      if (root.state === 'error') this.toast('error', `${root.name}: ${root.error}`);
    });
    return tab;
  }

  closeTab(tab: Tab): void {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs = this.tabs.filter((t) => t !== tab);
    if (this.active === tab) this.active = this.tabs[Math.min(i, this.tabs.length - 1)] ?? null;
  }
}

export function applyTheme(t: Theme): void {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', t);
}

export const app = new AppState();

export { loadNode };
