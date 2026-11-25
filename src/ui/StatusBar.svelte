<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from './state.svelte';
  import { describeFormat } from '../lib/nbt/nbtfile';
  import { describeDataVersion } from '../lib/nbt/dataversion';
  import { TagType } from '../lib/nbt/types';
  import type { Holder } from '../lib/doc/model';

  const info = $derived.by(() => {
    const t = app.active;
    if (!t) return null;
    void t.version;
    const row = t.focusedRow;
    const n = row?.node ?? t.ws.root;
    const holder: Holder | null = row?.holder ?? (n.kind === 'nbt' || n.kind === 'chunk' ? n : null);
    const parts: string[] = [];
    if (holder?.kind === 'nbt' && holder.state === 'ready') parts.push(describeFormat(holder.format));
    if (holder?.kind === 'chunk') parts.push('Java · Anvil chunk');
    const root = holder?.root?.tag;
    if (root?.type === TagType.Compound) {
      let dv = root.value.get('DataVersion');
      const data = root.value.get('Data');
      if (!dv && data?.type === TagType.Compound) dv = data.value.get('DataVersion');
      if (dv?.type === TagType.Int) parts.push(`Minecraft ${describeDataVersion(dv.value)} (DataVersion ${dv.value})`);
    }
    return { parts, rows: t.rows.length, sel: t.selection.size };
  });
</script>

<footer class="status">
  {#if info}
    {#each info.parts as p (p)}<span>{p}</span>{/each}
    <span class="muted">{info.rows.toLocaleString()} rows shown{info.sel > 1 ? ` · ${info.sel} selected` : ''}</span>
  {:else}
    <span class="muted">No file open</span>
  {/if}
  <span class="local" title="All parsing, editing and saving happens in this browser tab. No file data is sent to any server.">
    <Icon name="lock" size={13} fill /> Processed locally · nothing uploaded
  </span>
</footer>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 24px;
    padding: 0 12px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
  }
  .muted {
    color: var(--muted);
  }
  .local {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ok);
  }
</style>
