<script lang="ts">
  import Icon from './Icon.svelte';
  import TypeBadge from './TypeBadge.svelte';
  import { app } from './state.svelte';
  import { commands, addTag } from './commands';
  import { isEnabled } from './reactive.svelte';
  import { CREATABLE_TYPES, TAG_META } from '../lib/nbt/types';

  const groups: { id: string; label?: boolean; primary?: boolean }[][] = [
    [{ id: 'open', label: true }, { id: 'openFolder', label: true }, { id: 'newFile' }],
    [{ id: 'download', label: true, primary: true }],
    [{ id: 'undo' }, { id: 'redo' }],
    [{ id: 'cut' }, { id: 'copy' }, { id: 'paste' }, { id: 'delete' }],
    [{ id: 'rename' }, { id: 'editValue' }, { id: 'duplicate' }],
  ];

  let addOpen = $state(false);
  const tip = (id: string) => `${commands[id].label}${commands[id].keys ? `  (${commands[id].keys})` : ''}`;
  const dirty = $derived.by(() => {
    const t = app.active;
    void t?.version;
    return !!t?.ws.isDirty;
  });
</script>

<header class="top">
  <div class="brand">
    <img src="./icon.png" alt="" width="24" height="24" />
    <span class="word"><b>NBT</b><span>-Editor</span></span>
  </div>

  <nav class="tools" aria-label="Toolbar">
    {#each groups as group, gi (gi)}
      <div class="group">
        {#each group as item (item.id)}
          {@const c = commands[item.id]}
          <button
            class="btn {item.label ? '' : 'icon-only'} {item.primary && dirty ? 'primary' : 'ghost'}"
            title={tip(item.id)}
            aria-label={c.label}
            disabled={!isEnabled(c)}
            onclick={() => c.run()}
          >
            <Icon name={c.icon} size={18} />
            {#if item.label}<span class="lbl">{c.label.replace('…', '')}</span>{/if}
          </button>
        {/each}
      </div>
    {/each}
    <div class="group">
      <button class="btn ghost" title="Add a tag to the selected compound or list" disabled={!isEnabled(commands.editSnbt)} onclick={() => (addOpen = !addOpen)} aria-expanded={addOpen}>
        <Icon name="add" size={18} /><span class="lbl">Add tag</span>
      </button>
    </div>
  </nav>

  {#if addOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="scrim" onclick={() => (addOpen = false)}></div>
    <div class="add-menu" role="menu">
      {#each CREATABLE_TYPES as t (t)}
        <button role="menuitem" onclick={() => { addOpen = false; addTag(t); }}>
          <TypeBadge type={t} /> {TAG_META[t].name}
        </button>
      {/each}
    </div>
  {/if}

  <div class="right">
    <button class="btn ghost" class:on={app.panel === 'search'} title={tip('find')} onclick={() => app.setPanel(app.panel === 'search' ? null : 'search')}>
      <Icon name="search" size={18} /><span class="lbl">Search</span>
    </button>
    <button class="btn ghost" class:on={app.panel === 'changes'} title={tip('changes')} onclick={() => commands.changes.run()}>
      <Icon name="history" size={18} /><span class="lbl">Changes</span>
    </button>
    <button class="btn ghost icon-only" title="Theme: {app.theme} (click to switch)" onclick={() => commands.theme.run()}>
      <Icon name={app.theme === 'light' ? 'light_mode' : app.theme === 'dark' ? 'dark_mode' : 'contrast'} size={18} />
    </button>
    <button class="btn ghost icon-only" title={tip('shortcuts')} onclick={() => commands.shortcuts.run()}><Icon name="keyboard" size={18} /></button>
    <button class="btn ghost icon-only" title="About NBT-Editor" onclick={() => commands.about.run()}><Icon name="help" size={18} /></button>
  </div>
</header>

<style>
  .top {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 46px;
    padding: 0 8px 0 12px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 12px;
    margin-right: 2px;
    border-right: 1px solid var(--border);
    height: 28px;
  }
  .word {
    font-size: 15px;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }
  .word b {
    font-weight: 600;
    color: var(--accent);
  }
  .word span {
    color: var(--text);
    font-weight: 500;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 0 4px;
    border-right: 1px solid var(--border);
  }
  .group:last-child {
    border-right: 0;
  }
  .add-menu {
    position: absolute;
    z-index: 50;
    top: 44px;
    left: 50%;
    transform: translateX(-20%);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    padding: 6px;
    min-width: 320px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .add-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border: 0;
    background: none;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .add-menu button:hover {
    background: var(--accent-soft);
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 49;
  }
  .right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 1px;
  }
  .btn.on {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: transparent;
  }
  @media (max-width: 1280px) {
    .tools .lbl {
      display: none;
    }
    .tools .btn:not(.icon-only) {
      width: 28px;
      padding: 0;
      justify-content: center;
    }
  }
  @media (max-width: 900px) {
    .right .lbl,
    .word {
      display: none;
    }
  }
</style>
