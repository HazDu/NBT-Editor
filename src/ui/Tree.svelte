<script lang="ts">
  import TreeRow from './TreeRow.svelte';
  import { app, type Tab } from './state.svelte';
  import { commands } from './commands';
  import * as actions from '../lib/doc/actions';
  import { parsePrimitive } from '../lib/nbt/format';
  import { TagType } from '../lib/nbt/types';

  let { tab }: { tab: Tab } = $props();

  const ROW_H = 26;
  const OVERSCAN = 12;

  let viewport = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let height = $state(400);

  const rows = $derived(tab.rows);
  const markers = $derived.by(() => {
    void tab.version;
    return tab.ws.journal.markers();
  });
  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
  const end = $derived(Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN));
  const visible = $derived(rows.slice(start, end));

  // Keep the focused row in view when something asks for it (keyboard nav, reveal, search).
  $effect(() => {
    void tab.scrollRequest;
    const key = tab.focusKey;
    if (!viewport || !key) return;
    const i = tab.rowIndex.get(key);
    if (i === undefined) return;
    const top = i * ROW_H;
    if (top < viewport.scrollTop) viewport.scrollTop = Math.max(0, top - ROW_H * 2);
    else if (top + ROW_H > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top - viewport.clientHeight + ROW_H * 3;
  });

  // Restore the per-tab scroll position when switching tabs.
  const scrollMemory = new WeakMap<Tab, number>();
  $effect(() => {
    const t = tab;
    if (viewport) viewport.scrollTop = scrollMemory.get(t) ?? 0;
    return () => {
      if (viewport) scrollMemory.set(t, viewport.scrollTop);
    };
  });

  function onRowClick(e: MouseEvent, key: object): void {
    tab.select(key, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'single');
    viewport?.focus({ preventScroll: true });
  }

  function onRowDbl(i: number): void {
    const r = rows[i];
    if (!r) return;
    if (r.tag && !r.node && r.tag.type !== TagType.Compound && r.tag.type !== TagType.List) commands.editValue.run();
    else tab.toggle(r);
  }

  function onContext(e: MouseEvent, key: object | null): void {
    e.preventDefault();
    if (key && !tab.selection.has(key)) tab.select(key);
    app.menu = { x: e.clientX, y: e.clientY, tab, row: tab.focusedRow };
  }

  function commit(i: number, field: 'name' | 'value', text: string): string | null {
    const r = rows[i];
    if (!r) return null;
    let res: actions.ActionResult;
    if (field === 'name') {
      res = actions.renameTag(tab.ws, r, text);
    } else {
      const p = parsePrimitive(r.tag!.type, text);
      if (!p.ok) return p.error ?? 'Invalid value';
      res = actions.setValue(tab.ws, r, p.value!);
    }
    if (!res.ok) {
      if (res.error === 'Value unchanged' || res.error === 'Name unchanged') {
        tab.editing = null;
        return res.error;
      }
      app.toast('warn', res.error);
      return res.error;
    }
    app.lastEntry = res.entry;
    tab.editing = null;
    viewport?.focus({ preventScroll: true });
    return null;
  }

  function onKey(e: KeyboardEvent): void {
    if (tab.editing) return;
    const rowsNow = rows;
    const cur = tab.focusKey ? (tab.rowIndex.get(tab.focusKey) ?? -1) : -1;
    const r = cur >= 0 ? rowsNow[cur] : null;
    const page = Math.max(1, Math.floor(height / ROW_H) - 1);
    const mode = e.shiftKey ? 'range' : 'single';
    switch (e.key) {
      case 'ArrowDown': tab.focusIndex(cur + 1, mode); break;
      case 'ArrowUp':
        if (e.altKey) { commands.moveUp.run(); break; }
        tab.focusIndex(cur - 1, mode);
        break;
      case 'PageDown': tab.focusIndex(cur + page, mode); break;
      case 'PageUp': tab.focusIndex(cur - page, mode); break;
      case 'Home': tab.focusIndex(0, mode); break;
      case 'End': tab.focusIndex(rowsNow.length - 1, mode); break;
      case 'ArrowRight':
        if (!r) break;
        if (!r.expanded && (r.expandable || r.node)) void tab.expand(r);
        else tab.focusIndex(cur + 1);
        break;
      case 'ArrowLeft':
        if (!r) break;
        if (r.expanded) tab.collapse(r);
        else if (r.parent) { tab.select(r.parent.key); tab.scrollRequest++; }
        break;
      case 'Enter':
        if (e.shiftKey) commands.editSnbt.run();
        else commands.editValue.run();
        break;
      case 'F2': commands.rename.run(); break;
      case 'Delete': commands.delete.run(); break;
      case '*': commands.expandAll.run(); break;
      case '-': if (r) { if (r.expanded) tab.collapse(r); } break;
      case ' ': if (r) tab.toggle(r); break;
      case 'ContextMenu': {
        if (!viewport) break;
        const rect = viewport.getBoundingClientRect();
        const y = rect.top + (cur * ROW_H - viewport.scrollTop) + ROW_H;
        app.menu = { x: rect.left + 80, y, tab, row: r };
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  // Alt+Down must win over plain ArrowDown navigation.
  function onKeyCapture(e: KeyboardEvent): void {
    if (e.altKey && e.key === 'ArrowDown' && !tab.editing) {
      e.preventDefault();
      e.stopPropagation();
      commands.moveDown.run();
    }
  }
</script>

<div
  class="tree"
  bind:this={viewport}
  bind:clientHeight={height}
  onscroll={(e) => (scrollTop = (e.currentTarget as HTMLDivElement).scrollTop)}
  onkeydowncapture={onKeyCapture}
  onkeydown={onKey}
  oncontextmenu={(e) => onContext(e, null)}
  tabindex="0"
  role="tree"
  aria-label="NBT tree"
  aria-multiselectable="true"
>
  <div class="spacer" style="height: {rows.length * ROW_H}px">
    {#each visible as row, j (row.key)}
      {@const i = start + j}
      <div
        class="slot"
        style="transform: translateY({i * ROW_H}px)"
        role="treeitem"
        aria-selected={tab.selection.has(row.key)}
        aria-expanded={row.expandable ? row.expanded : undefined}
        tabindex="-1"
        onmousedown={(e) => { if (e.button === 0) onRowClick(e, row.key); }}
        ondblclick={() => onRowDbl(i)}
        oncontextmenu={(e) => { e.stopPropagation(); onContext(e, row.key); }}
      >
        <TreeRow
          {row}
          selected={tab.selection.has(row.key)}
          focused={tab.focusKey === row.key}
          changed={!!row.tag && markers.direct.has(row.tag)}
          inner={!!row.tag && markers.ancestor.has(row.tag)}
          editing={tab.editing?.key === row.key ? tab.editing.field : null}
          onToggle={() => tab.toggle(row)}
          onCommit={(f, t) => commit(i, f, t)}
          onCancel={() => { tab.editing = null; viewport?.focus({ preventScroll: true }); }}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .tree {
    position: relative;
    height: 100%;
    overflow: auto;
    outline: none;
    contain: strict;
  }
  .tree:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .spacer {
    position: relative;
    min-width: 100%;
    width: max-content;
  }
  .slot {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    min-width: 100%;
    outline: none;
  }
</style>
