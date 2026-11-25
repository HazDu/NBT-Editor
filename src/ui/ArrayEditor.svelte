<script lang="ts">
  import Icon from './Icon.svelte';
  import { app, type Tab } from './state.svelte';
  import * as actions from '../lib/doc/actions';
  import { TagType, type ArrayTag } from '../lib/nbt/types';
  import type { Row } from '../lib/doc/rows';
  import { uuidFromInts } from '../lib/search/query';
  import { copyText } from './commands';

  let { tab, row }: { tab: Tab; row: Row } = $props();

  const tag = $derived(row.tag as ArrayTag);
  const ROW_H = 24;
  const IDX_W = 48;
  let hex = $state(false);
  let gridWidth = $state(300);
  let scrollTop = $state(0);
  let height = $state(240);
  let editing = $state<number | null>(null);
  let draft = $state('');
  let lengthDraft = $state('');

  const values = $derived.by(() => {
    void tab.version;
    return tag.value;
  });
  const bits = $derived(tag.type === TagType.ByteArray ? 8 : tag.type === TagType.IntArray ? 32 : 64);
  /** widest value of this type: 4 / 11 / 20 chars in decimal, 2 / 8 / 16 in hex (7 px per mono char + padding) */
  const cellW = $derived((hex ? bits / 4 : bits === 8 ? 4 : bits === 32 ? 11 : 20) * 7 + 12);
  const COLS = $derived(Math.max(1, Math.min(16, Math.floor((gridWidth - IDX_W - 14) / cellW))));
  const lines = $derived(Math.ceil(values.length / COLS));
  const uuid = $derived(tag.type === TagType.IntArray && values.length === 4 ? uuidFromInts(values as Int32Array) : null);
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - 4));
  const last = $derived(Math.min(lines, Math.ceil((scrollTop + height) / ROW_H) + 4));

  $effect(() => {
    lengthDraft = String(values.length);
  });

  function fmt(v: number | bigint): string {
    if (!hex) return v.toString();
    const big = BigInt.asUintN(bits, BigInt(v));
    return big.toString(16).padStart(bits / 4, '0').toUpperCase();
  }

  function parse(s: string): bigint | null {
    const t = s.trim();
    try {
      const v = hex || /^0x/i.test(t) ? BigInt('0x' + t.replace(/^0x/i, '')) : BigInt(t);
      return BigInt.asIntN(bits, v);
    } catch {
      return null;
    }
  }

  function apply(next: ArrayTag['value']): void {
    const res = actions.setValue(tab.ws, row, next);
    if (!res.ok) app.toast('warn', res.error);
    else app.lastEntry = res.entry;
  }

  function commitCell(i: number): void {
    const v = parse(draft);
    editing = null;
    if (v === null) { app.toast('warn', `Not a valid ${bits}-bit number`); return; }
    if (BigInt(values[i]) === v) return;
    const next = values.slice() as ArrayTag['value'];
    if (next instanceof BigInt64Array) next[i] = v;
    else next[i] = Number(v);
    apply(next);
  }

  function resize(): void {
    const n = Number(lengthDraft);
    if (!Number.isInteger(n) || n < 0 || n > 16_000_000) { app.toast('warn', 'Enter a length between 0 and 16,000,000'); return; }
    if (n === values.length) return;
    const Ctor = values.constructor as { new (n: number): ArrayTag['value'] };
    const next = new Ctor(n);
    (next as Int32Array).set((values as Int32Array).subarray(0, Math.min(n, values.length)));
    apply(next);
  }

  function startEdit(i: number): void {
    editing = i;
    draft = fmt(values[i]);
  }
</script>

<div class="arr" data-array-editor tabindex="-1">
  <div class="bar">
    <div class="seg" role="group" aria-label="Number format">
      <button class:on={!hex} onclick={() => (hex = false)}>Dec</button>
      <button class:on={hex} onclick={() => (hex = true)}>Hex</button>
    </div>
    <label class="len">
      <span class="hint">Length</span>
      <input class="field mono" bind:value={lengthDraft} onkeydown={(e) => e.key === 'Enter' && resize()} onblur={resize} />
    </label>
  </div>
  {#if values.length === 0}
    <p class="hint empty">Empty array. Set a length to add elements.</p>
  {:else}
    <div class="grid" bind:clientHeight={height} bind:clientWidth={gridWidth} onscroll={(e) => (scrollTop = (e.currentTarget as HTMLElement).scrollTop)}>
      <div style="height: {lines * ROW_H}px; position: relative">
        {#each { length: last - first } as _, k (first + k)}
          {@const line = first + k}
          <div class="line" style="transform: translateY({line * ROW_H}px); grid-template-columns: {IDX_W}px repeat({COLS}, minmax({cellW}px, 1fr))">
            <span class="idx mono">{line * COLS}</span>
            {#each { length: Math.min(COLS, values.length - line * COLS) } as _, c (c)}
              {@const i = line * COLS + c}
              {#if editing === i}
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="cell-edit mono"
                  bind:value={draft}
                  autofocus
                  onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitCell(i); if (e.key === 'Escape') editing = null; }}
                  onblur={() => commitCell(i)}
                />
              {:else}
                <button class="cell mono" title="[{i}]" ondblclick={() => startEdit(i)} onkeydown={(e) => e.key === 'Enter' && startEdit(i)}>{fmt(values[i])}</button>
              {/if}
            {/each}
          </div>
        {/each}
      </div>
    </div>
    {#if uuid}
      <div class="uuid">
        <Icon name="fingerprint" size={15} />
        <span class="mono" title="The same 4 ints written as a UUID (Minecraft 1.16+ layout)">{uuid}</span>
        <button class="btn ghost icon-only" title="Copy UUID" onclick={() => void copyText(uuid, 'UUID')}><Icon name="content_copy" size={15} /></button>
      </div>
    {/if}
    <p class="hint foot"><Icon name="info" size={14} /> Double-click a cell to edit. {values.length.toLocaleString()} elements.</p>
  {/if}
</div>

<style>
  .arr {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    outline: none;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .seg button {
    border: 0;
    background: transparent;
    padding: 3px 10px;
    color: var(--muted);
    font-size: 12px;
  }
  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .len {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .len .field {
    width: 96px;
    height: 26px;
  }
  .uuid {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 12px;
  }
  .uuid .mono {
    color: var(--text);
    user-select: all;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .grid {
    max-height: 260px;
    min-height: 60px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
  }
  .line {
    position: absolute;
    left: 0;
    right: 0;
    display: grid;
    height: 24px;
    align-items: center;
  }
  .idx {
    color: var(--faint);
    font-size: 11px;
    padding-left: 6px;
  }
  .cell,
  .cell-edit {
    height: 22px;
    margin: 0 1px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--t-array);
    font-size: 11.5px;
    text-align: right;
    padding: 0 4px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell:hover {
    background: var(--surface-2);
    border-color: var(--border);
  }
  .cell-edit {
    border-color: var(--accent);
    background: var(--surface);
    outline: none;
    width: 100%;
  }
  .empty,
  .foot {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 4px;
  }
</style>
