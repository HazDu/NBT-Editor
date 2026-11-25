<script lang="ts">
  import Icon from './Icon.svelte';
  import { app, type Tab } from './state.svelte';
  import { commands, requestClose } from './commands';

  function icon(t: Tab): string {
    switch (t.ws.root.kind) {
      case 'folder': return 'folder';
      case 'region': return 'grid_view';
      default: return 'description';
    }
  }

  function isDirty(t: Tab): boolean {
    void t.version;
    return t.ws.isDirty;
  }
</script>

<div class="tabs" role="tablist" aria-label="Open files">
  {#each app.tabs as t (t.ws.id)}
    <div
      class="tab"
      class:active={app.active === t}
      role="tab"
      tabindex="0"
      aria-selected={app.active === t}
      title={t.title}
      onclick={() => (app.active = t)}
      onkeydown={(e) => e.key === 'Enter' && (app.active = t)}
      onauxclick={(e) => { if (e.button === 1) requestClose(t); }}
    >
      <Icon name={icon(t)} size={16} fill={t.ws.root.kind === 'folder'} />
      <span class="name">{t.title}</span>
      {#if isDirty(t)}<span class="dot" title="Unsaved changes"></span>{/if}
      <button class="close" title="Close (Alt+W)" aria-label="Close {t.title}" onclick={(e) => { e.stopPropagation(); requestClose(t); }}>
        <Icon name="close" size={14} />
      </button>
    </div>
  {/each}
  <button class="new" title="Open files (Ctrl+O)" aria-label="Open files" onclick={() => commands.open.run()}><Icon name="add" size={18} /></button>
</div>

<style>
  .tabs {
    display: flex;
    align-items: stretch;
    height: 34px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: 240px;
    padding: 0 6px 0 12px;
    border-right: 1px solid var(--border);
    color: var(--muted);
    cursor: pointer;
    border-top: 2px solid transparent;
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--text);
    background: var(--surface);
  }
  .tab.active {
    color: var(--text);
    background: var(--surface);
    border-top-color: var(--accent);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .close {
    display: inline-flex;
    padding: 2px;
    border: 0;
    background: none;
    color: var(--muted);
    border-radius: var(--radius-sm);
    opacity: 0;
  }
  .tab:hover .close,
  .tab.active .close {
    opacity: 1;
  }
  .close:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .new {
    border: 0;
    background: none;
    color: var(--muted);
    padding: 0 10px;
  }
  .new:hover {
    color: var(--accent);
  }
</style>
