<script lang="ts">
  import Icon from './Icon.svelte';
  import TypeBadge from './TypeBadge.svelte';
  import { compoundHint, parsePrimitive, previewValue } from '../lib/nbt/format';
  import { describeFormat } from '../lib/nbt/nbtfile';
  import { describeDataVersion } from '../lib/nbt/dataversion';
  import { COMPRESSION_NAMES } from '../lib/nbt/region';
  import { TagType, type Tag } from '../lib/nbt/types';
  import type { Row } from '../lib/doc/rows';
  import type { SourceNode } from '../lib/doc/model';

  let {
    row, selected, focused, changed, inner, editing, onToggle, onCommit, onCancel,
  }: {
    row: Row;
    selected: boolean;
    focused: boolean;
    changed: boolean;
    inner: boolean;
    editing: 'name' | 'value' | null;
    onToggle: () => void;
    onCommit: (field: 'name' | 'value', text: string) => string | null;
    onCancel: () => void;
  } = $props();

  // NOTE: tags/nodes are mutated in place, so everything is derived from `row` (a fresh object on
  // every rebuild) rather than from row.tag / row.node, whose identity never changes.
  const v = $derived.by(() => {
    const node = row.node ?? null;
    const tag = row.tag ?? null;
    const isContainerTag = !!tag && (tag.type === TagType.Compound || tag.type === TagType.List);
    const isArrayTag = !!tag && (tag.type === TagType.ByteArray || tag.type === TagType.IntArray || tag.type === TagType.LongArray);
    const label = node ? node.name : typeof row.name === 'number' ? `[${row.name}]` : (row.name ?? '');
    return {
      node,
      tag,
      state: node?.state ?? null,
      error: node?.error ?? null,
      icon: node ? nodeIcon(node, row.expanded) : null,
      meta: node ? metaFor(node) : null,
      label,
      rootName: node && (node.kind === 'nbt' || node.kind === 'chunk') ? (node.root?.name ?? null) : null,
      valueText: tag && !node ? previewValue(tag) : null,
      hint: tag && !node ? compoundHint(tag) : null,
      isContainerTag,
      isArrayTag,
      color: !tag ? 'muted' : tag.type === TagType.String ? 'string' : tag.type <= TagType.Long ? 'int' : tag.type <= TagType.Double ? 'float' : 'muted',
    };
  });

  function nodeIcon(n: SourceNode, expanded: boolean): string {
    switch (n.kind) {
      case 'folder': return expanded ? 'folder_open' : 'folder';
      case 'nbt': return 'description';
      case 'region': return 'grid_view';
      case 'chunk': return 'deployed_code';
    }
  }

  function dataVersion(t: Tag | undefined): string | null {
    if (!t || t.type !== TagType.Compound) return null;
    let dv = t.value.get('DataVersion');
    if (!dv) {
      const data = t.value.get('Data');
      if (data?.type === TagType.Compound) dv = data.value.get('DataVersion');
    }
    return dv && dv.type === TagType.Int ? `MC ${describeDataVersion(dv.value)}` : null;
  }

  function metaFor(node: SourceNode): string | null {
    switch (node.kind) {
      case 'folder':
        return node.state === 'ready' ? `${node.children?.length ?? 0} items` : null;
      case 'nbt':
        if (node.state !== 'ready' || !node.root) return null;
        return [describeFormat(node.format), dataVersion(node.root.tag)].filter(Boolean).join(' · ');
      case 'region': {
        if (node.state !== 'ready') return null;
        const cat = node.category !== 'region' ? `${node.category} · ` : '';
        return `${cat}${node.chunks?.filter((c) => !c.deleted).length ?? 0} chunks${node.coords ? ` · region ${node.coords.rx}, ${node.coords.rz}` : ''}`;
      }
      case 'chunk': {
        const parts: string[] = [];
        if (node.worldX !== null) parts.push(`chunk ${node.worldX}, ${node.worldZ}`);
        if (node.state === 'ready') {
          parts.push(COMPRESSION_NAMES[node.compressionId] ?? `id ${node.compressionId}`);
          if (node.external) parts.push('external .mcc');
          const dv = dataVersion(node.root?.tag);
          if (dv) parts.push(dv);
        }
        return parts.join(' · ');
      }
    }
  }

  let draft = $state('');
  let error = $state<string | null>(null);
  let input = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (editing && input) {
      draft = editing === 'name' ? String(row.name ?? (v.rootName ?? '')) : v.tag ? editText(v.tag) : '';
      error = null;
      input.focus();
      input.select();
    }
  });

  function editText(t: Tag): string {
    return t.type === TagType.String ? t.value : previewValue(t);
  }

  function validate(): void {
    if (editing === 'value' && v.tag) {
      const r = parsePrimitive(v.tag.type, draft);
      error = r.ok ? null : (r.error ?? 'Invalid');
    } else error = null;
  }

  /** Clicking elsewhere commits a valid edit and drops an invalid one. */
  function blur(): void {
    if (!editing) return;
    if (onCommit(editing, draft)) onCancel();
  }

  function key(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      error = onCommit(editing!, draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }
</script>

<div
  class="row"
  class:selected
  class:focused
  class:changed
  class:source={!!v.node}
  style="--depth: {row.depth}"
  data-depth={row.depth}
>
  <span class="indent"></span>
  {#if row.expandable}
    <button class="chev" class:open={row.expanded} tabindex="-1" aria-label={row.expanded ? 'Collapse' : 'Expand'} onclick={(e) => { e.stopPropagation(); onToggle(); }}>
      <Icon name="chevron_right" size={16} />
    </button>
  {:else}
    <span class="chev-space"></span>
  {/if}

  {#if v.node}
    <span class="node-icon k-{v.node.kind}"><Icon name={v.icon!} size={17} fill={v.node.kind === 'folder'} /></span>
  {:else if v.tag}
    <TypeBadge type={v.tag.type} />
  {/if}

  {#if editing === 'name'}
    <input
      bind:this={input}
      bind:value={draft}
      class="edit name-edit"
      spellcheck="false"
      onkeydown={key}
      onblur={blur}
      onclick={(e) => e.stopPropagation()}
      ondblclick={(e) => e.stopPropagation()}
    />
  {:else}
    <span class="name" class:index={typeof row.name === 'number'} class:empty-name={row.name === ''}>{row.name === '' ? '(empty name)' : v.label}</span>
  {/if}

  {#if v.rootName}<span class="root-name mono">"{v.rootName}"</span>{/if}

  {#if inner && !changed}<span class="inner-dot" title="Contains unsaved changes"></span>{/if}

  {#if editing === 'value'}
    <span class="sep">:</span>
    <input
      bind:this={input}
      bind:value={draft}
      class="edit value-edit mono"
      class:invalid={!!error}
      title={error ?? ''}
      spellcheck="false"
      oninput={validate}
      onkeydown={key}
      onblur={blur}
      onclick={(e) => e.stopPropagation()}
      ondblclick={(e) => e.stopPropagation()}
    />
    {#if error}<span class="edit-error">{error}</span>{/if}
  {:else if v.valueText !== null}
    {#if !v.isContainerTag}<span class="sep">:</span>{/if}
    <span class="value mono" class:muted={v.isContainerTag || v.isArrayTag} style="--c: var(--t-{v.color})">{v.valueText}</span>
    {#if v.hint}<span class="hint-chip mono">{v.hint}</span>{/if}
  {/if}

  {#if v.node}
    {#if v.state === 'loading'}
      <span class="status"><Icon name="progress_activity" size={14} class="spin" /></span>
    {:else if v.state === 'error'}
      <span class="status err" title={v.error}><Icon name="error" size={15} fill /> {v.error}</span>
    {:else if v.meta}
      <span class="meta">{v.meta}</span>
    {/if}
  {/if}
</div>

<style>
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--row-h);
    padding-right: 12px;
    white-space: nowrap;
    cursor: default;
    user-select: none;
    border-left: 2px solid transparent;
  }
  .row:hover {
    background: var(--row-hover);
  }
  .row.selected {
    background: var(--row-select);
  }
  .row.selected.focused {
    background: var(--row-select-strong);
  }
  .row.changed {
    border-left-color: var(--accent);
  }
  .indent {
    flex: none;
    width: calc(var(--depth) * 16px + 4px);
    align-self: stretch;
    background: repeating-linear-gradient(to right, transparent 0 11px, var(--guide) 11px 12px, transparent 12px 16px);
    background-size: calc(var(--depth) * 16px) 100%;
    background-repeat: no-repeat;
  }
  .chev,
  .chev-space {
    flex: none;
    width: 18px;
    height: 18px;
    margin-right: -4px;
  }
  .chev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    padding: 0;
    background: none;
    color: var(--muted);
    border-radius: var(--radius-sm);
    transition: transform 0.12s;
  }
  .chev:hover {
    color: var(--text);
    background: var(--surface-3);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .node-icon {
    display: inline-flex;
    color: var(--muted);
  }
  .k-folder { color: var(--t-list); }
  .k-nbt { color: var(--accent); }
  .k-region { color: var(--t-int); }
  .k-chunk { color: var(--t-float); }
  .name {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
  }
  .source .name {
    font-weight: 500;
  }
  .name.index {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }
  .name.empty-name {
    color: var(--faint);
    font-style: italic;
  }
  .root-name {
    color: var(--muted);
  }
  .sep {
    color: var(--faint);
    margin: 0 -2px 0 -4px;
  }
  .value {
    color: var(--c);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .value.muted {
    color: var(--muted);
  }
  .hint-chip {
    flex: none;
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 6px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 11px;
    line-height: 17px;
  }
  .inner-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.8;
  }
  .meta {
    margin-left: 6px;
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status.err {
    color: var(--danger);
  }
  .edit {
    height: 21px;
    padding: 0 6px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--bg);
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-soft);
    min-width: 120px;
  }
  .value-edit {
    flex: 1;
    max-width: 520px;
  }
  .edit.invalid {
    border-color: var(--danger);
    box-shadow: 0 0 0 2px var(--danger-soft);
  }
  .edit-error {
    color: var(--danger);
    font-size: 12px;
  }
</style>
