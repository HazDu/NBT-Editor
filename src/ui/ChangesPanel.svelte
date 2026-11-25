<script lang="ts">
  import Icon from './Icon.svelte';
  import { app, type Tab } from './state.svelte';
  import { findTagPath } from '../lib/doc/rows';
  import type { Entry } from '../lib/doc/journal';

  let { tab }: { tab: Tab } = $props();

  const journal = $derived(tab.ws.journal);
  const view = $derived.by(() => {
    void tab.version;
    return {
      entries: [...journal.entries].reverse(),
      index: journal.index,
      saved: journal.savedIndex,
      canUndo: journal.canUndo,
      canRedo: journal.canRedo,
      unsaved: journal.hasUnsaved,
    };
  });

  function time(t: number): string {
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function jump(e: Entry): Promise<void> {
    const op = e.ops[0];
    if (op.kind === 'deleteChunk') {
      if (!op.holder.deleted) await tab.revealNode(op.holder);
      return;
    }
    const holder = op.holder;
    if (!holder.root) return;
    for (const t of e.targets) {
      const found = findTagPath(holder.root.tag, t);
      if (found) {
        await tab.reveal(holder, found.chain);
        return;
      }
    }
    app.toast('info', 'That tag is not in the file any more (deleted or undone)');
  }

  function goTo(pos: number): void {
    // pos = number of entries that should be applied
    while (journal.index > pos) journal.undo();
    while (journal.index < pos) journal.redo();
  }
</script>

<div class="changes">
  <div class="head">
    <span class="hint">
      {#if view.entries.length === 0}
        No changes yet.
      {:else}
        {view.index} applied · {view.entries.length - view.index} undone{view.unsaved ? ' · unsaved' : ' · saved'}
      {/if}
    </span>
    <span class="grow"></span>
    <button class="btn ghost" disabled={!view.canUndo} onclick={() => journal.undo()}><Icon name="undo" size={16} /> Undo</button>
    <button class="btn ghost" disabled={!view.canRedo} onclick={() => journal.redo()}><Icon name="redo" size={16} /> Redo</button>
  </div>
  <ol class="list">
    {#each view.entries as e, k (e.id)}
      {@const pos = view.entries.length - k}
      {@const applied = pos <= view.index}
      {#if pos === view.saved && view.saved !== view.entries.length}
        <li class="savepoint"><Icon name="save" size={14} /> Saved state</li>
      {/if}
      {#if pos === view.index && view.index < view.entries.length}
        <li class="head-marker"><Icon name="chevron_right" size={14} /> You are here</li>
      {/if}
      <li class="entry" class:undone={!applied} class:latest={app.lastEntry === e}>
        <span class="ic"><Icon name={e.icon} size={17} /></span>
        <div class="txt">
          <div class="l1"><b>{e.label}</b>{#if e.detail}<span class="detail mono">{e.detail}</span>{/if}</div>
          <div class="l2 mono">{e.where}</div>
        </div>
        <span class="time">{time(e.time)}</span>
        <div class="acts">
          {#if applied}
            <button class="btn ghost icon-only" title="Show in tree" onclick={() => jump(e)}><Icon name="my_location" size={16} /></button>
            <button class="btn ghost icon-only" title="Revert this change" onclick={() => journal.revertEntry(e)}><Icon name="history" size={16} /></button>
          {:else}
            <button class="btn ghost icon-only" title="Redo up to here" onclick={() => goTo(pos)}><Icon name="redo" size={16} /></button>
          {/if}
        </div>
      </li>
    {/each}
    {#if view.entries.length > 0 && view.saved === 0}
      <li class="savepoint"><Icon name="description" size={14} /> Opened file (original)</li>
    {/if}
    {#if view.entries.length === 0}
      <li class="empty hint">
        <Icon name="history" size={22} />
        Every edit is recorded here like a commit: you can jump to it, revert it, or step back and forth. Only the
        changed values are stored, not copies of the file, so this works for big region files too.
      </li>
    {/if}
  </ol>
</div>

<style>
  .changes {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }
  .grow {
    flex: 1;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 10px 4px 14px;
    border-left: 2px solid transparent;
  }
  .entry:hover {
    background: var(--row-hover);
  }
  .entry.latest {
    border-left-color: var(--accent);
  }
  .entry.undone {
    opacity: 0.45;
  }
  .entry.undone b {
    text-decoration: line-through;
  }
  .ic {
    color: var(--accent);
    display: inline-flex;
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .l1 {
    display: flex;
    gap: 8px;
    align-items: baseline;
    white-space: nowrap;
  }
  .detail {
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .l2 {
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    color: var(--faint);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .acts {
    display: flex;
    gap: 2px;
  }
  .savepoint,
  .head-marker {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 14px;
    padding: 2px 0;
    font-size: 11px;
    color: var(--ok);
    border-top: 1px dashed currentColor;
  }
  .head-marker {
    color: var(--accent);
  }
  .empty {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 14px;
    max-width: 680px;
  }
</style>
