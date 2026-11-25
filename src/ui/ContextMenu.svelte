<script lang="ts">
  import Icon from './Icon.svelte';
  import TypeBadge from './TypeBadge.svelte';
  import { app } from './state.svelte';
  import { commands, addTag } from './commands';
  import { isEnabled } from './reactive.svelte';
  import { CREATABLE_TYPES, TAG_META, TagType } from '../lib/nbt/types';

  const m = $derived(app.menu);
  let sub = $state(false);
  let el = $state<HTMLDivElement | null>(null);
  let pos = $state<{ x: number; y: number } | null>(null);

  const sections: string[][] = [
    ['editValue', 'rename', 'editSnbt'],
    ['cut', 'copy', 'paste', 'pasteSnbt', 'duplicate'],
    ['moveUp', 'moveDown'],
    ['copyPath', 'copySnbt', 'findValue'],
    ['expandAll', 'collapseAll'],
    ['delete'],
  ];

  const canAdd = $derived(!!m?.row?.tag && !!m.row.holder);
  /** If the insertion target is a non-empty list, only its element type can be added. */
  const listType = $derived.by(() => {
    const r = m?.row;
    if (!r?.tag) return null;
    const isC = r.tag.type === TagType.List || r.tag.type === TagType.Compound;
    const target = isC ? r.tag : r.parentTag;
    return target?.type === TagType.List && target.value.length ? target.elementType : null;
  });

  $effect(() => {
    if (!m || !el) { pos = null; return; }
    sub = false;
    const r = el.getBoundingClientRect();
    pos = { x: Math.max(4, Math.min(m.x, innerWidth - r.width - 8)), y: Math.max(4, Math.min(m.y, innerHeight - r.height - 8)) };
  });

  function run(id: string): void {
    app.menu = null;
    void commands[id].run();
  }
</script>

<svelte:window onkeydown={(e) => { if (m && e.key === 'Escape') app.menu = null; }} />

{#if m}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={() => (app.menu = null)} oncontextmenu={(e) => { e.preventDefault(); app.menu = null; }}></div>
  <div class="menu" role="menu" bind:this={el} style="left: {pos?.x ?? m.x}px; top: {pos?.y ?? m.y}px; visibility: {pos ? 'visible' : 'hidden'}">
    {#if canAdd}
      <div class="item has-sub" role="menuitem" tabindex="-1" onmouseenter={() => (sub = true)} onmouseleave={() => (sub = false)}>
        <Icon name="add" size={17} /><span>Add tag</span><Icon name="chevron_right" size={16} />
        {#if sub}
          <div class="submenu" role="menu">
            {#each CREATABLE_TYPES as t (t)}
              <button role="menuitem" disabled={listType !== null && listType !== t} onclick={() => { app.menu = null; addTag(t); }}>
                <TypeBadge type={t} size="sm" /> {TAG_META[t].name}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="sep"></div>
    {/if}
    {#each sections as sec, i (i)}
      {@const items = sec.filter((id) => isEnabled(commands[id]))}
      {#if items.length}
        {#each items as id (id)}
          {@const c = commands[id]}
          <button class="item" class:danger={id === 'delete'} role="menuitem" onclick={() => run(id)}>
            <Icon name={c.icon} size={17} /><span>{c.label}</span>{#if c.keys}<kbd>{c.keys}</kbd>{/if}
          </button>
        {/each}
        {#if i < sections.length - 1}<div class="sep"></div>{/if}
      {/if}
    {/each}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
  }
  .menu {
    position: fixed;
    z-index: 81;
    min-width: 236px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 0;
    background: none;
    border-radius: var(--radius-sm);
    text-align: left;
    cursor: default;
  }
  .item span {
    flex: 1;
  }
  .item:hover {
    background: var(--accent-soft);
  }
  .item.danger {
    color: var(--danger);
  }
  .item.danger:hover {
    background: var(--danger-soft);
  }
  .item kbd {
    font-size: 10.5px;
  }
  .sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--border);
  }
  .submenu {
    position: absolute;
    left: 100%;
    top: -4px;
    margin-left: 2px;
    min-width: 190px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .submenu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 27px;
    padding: 0 8px;
    border: 0;
    background: none;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .submenu button:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .submenu button:disabled {
    opacity: 0.35;
  }
</style>
