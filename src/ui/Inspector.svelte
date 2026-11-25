<script lang="ts">
  import Icon from './Icon.svelte';
  import TypeBadge from './TypeBadge.svelte';
  import ArrayEditor from './ArrayEditor.svelte';
  import { app, type Tab } from './state.svelte';
  import { commands, addTag, copyText } from './commands';
  import * as actions from '../lib/doc/actions';
  import { compoundHint, formatBytes, formatPath, parsePrimitive, previewValue } from '../lib/nbt/format';
  import { describeFormat } from '../lib/nbt/nbtfile';
  import { describeDataVersion } from '../lib/nbt/dataversion';
  import { COMPRESSION_NAMES } from '../lib/nbt/region';
  import { toSnbt } from '../lib/nbt/snbt';
  import { CREATABLE_TYPES, INT_RANGES, TAG_META, TagType, countTags, type Tag } from '../lib/nbt/types';
  import { rowPath } from '../lib/doc/rows';
  import { holderLabel } from '../lib/doc/model';

  let { tab }: { tab: Tab } = $props();

  // Tags/nodes are mutated in place: wrap them in a fresh object per version so everything that
  // reads `s.tag` / `s.node` re-evaluates after edits and loads.
  const s = $derived.by(() => {
    void tab.version;
    const r = tab.focusedRow;
    return { row: r, tag: r?.tag ?? null, node: r?.node ?? null };
  });
  const row = $derived(s.row);
  const multi = $derived(tab.selection.size > 1);
  const path = $derived(row && row.holder ? rowPath(row) : []);
  const isPrimitive = $derived(!!s.tag && (s.tag.type <= TagType.Double || s.tag.type === TagType.String));
  const isArray = $derived(!!s.tag && (s.tag.type === TagType.ByteArray || s.tag.type === TagType.IntArray || s.tag.type === TagType.LongArray));
  const isContainer = $derived(!!s.tag && (s.tag.type === TagType.Compound || s.tag.type === TagType.List));

  let draft = $state('');
  let error = $state<string | null>(null);
  let nameDraft = $state('');

  // Reset drafts when the selection or the data changes.
  $effect(() => {
    void tab.version;
    const t = s.tag;
    if (t && isPrimitive) draft = t.type === TagType.String ? t.value : previewValue(t);
    error = null;
    nameDraft = row && typeof row.name === 'string' ? row.name : '';
  });

  function applyValue(): void {
    if (!row || !s.tag) return;
    const p = parsePrimitive(s.tag!.type, draft);
    if (!p.ok) { error = p.error ?? 'Invalid'; return; }
    const r = actions.setValue(tab.ws, row, p.value!);
    if (r.ok) { app.lastEntry = r.entry; error = null; }
    else if (r.error !== 'Value unchanged') app.toast('warn', r.error);
  }

  function applyName(): void {
    if (!row || typeof row.name !== 'string') return;
    if (nameDraft === row.name) return;
    const r = actions.renameTag(tab.ws, row, nameDraft);
    if (r.ok) app.lastEntry = r.entry;
    else { app.toast('warn', r.error); nameDraft = row.name; }
  }

  function setBool(v: 0 | 1): void {
    draft = String(v);
    applyValue();
  }

  function snbtPreview(t: Tag): string {
    if (countTags(t) > 4000) return '(too large to preview, use "Copy as SNBT")';
    const s = toSnbt(t, { indent: '  ', maxItems: 64 });
    return s.length > 6000 ? s.slice(0, 6000) + '\n…' : s;
  }

  const range = $derived(s.tag ? INT_RANGES[s.tag.type] : undefined);
  const dataVersion = $derived.by(() => {
    if (!s.tag || s.tag.type !== TagType.Compound) return null;
    const dv = s.tag.value.get('DataVersion');
    return dv?.type === TagType.Int ? dv.value : null;
  });
  const hint = $derived(s.tag ? compoundHint(s.tag) : null);
  const entryCount = $derived.by(() => {
    void tab.version;
    return s.tag?.type === TagType.Compound ? s.tag.value.size : s.tag?.type === TagType.List ? s.tag.value.length : 0;
  });
</script>

<aside class="inspector" aria-label="Inspector">
  {#if !row}
    <div class="empty">
      <Icon name="tune" size={28} />
      <p>Select a tag to see and edit its details here.</p>
    </div>
  {:else}
    <header>
      {#if s.node}
        <span class="big-icon"><Icon name={s.node.kind === 'folder' ? 'folder' : s.node.kind === 'region' ? 'grid_view' : s.node.kind === 'chunk' ? 'deployed_code' : 'description'} size={22} fill={s.node.kind === 'folder'} /></span>
      {:else if s.tag}
        <TypeBadge type={s.tag.type} size="lg" />
      {/if}
      <div class="title">
        <div class="kind">
          {#if s.node}{s.node.kind === 'nbt' ? 'NBT file' : s.node.kind === 'region' ? 'Region file' : s.node.kind === 'chunk' ? 'Chunk' : 'Folder'}{:else if s.tag}{TAG_META[s.tag.type].name}{/if}
          {#if multi}<span class="multi">· {tab.selection.size} selected</span>{/if}
        </div>
        <div class="name">{s.node ? s.node.name : typeof row.name === 'number' ? `Entry [${row.name}]` : row.name === '' ? '(empty name)' : row.name}</div>
      </div>
    </header>

    {#if row.holder && !s.node}
      <div class="path">
        <code title={formatPath(path)}>{formatPath(path)}</code>
        <button class="btn ghost icon-only" title="Copy path" onclick={() => copyText(formatPath(path), 'path')}><Icon name="content_copy" size={15} /></button>
      </div>
    {/if}

    <div class="body">
      {#if typeof row.name === 'string' && row.holder && !s.node}
        <label class="fieldset">
          <span class="label">Name</span>
          <input class="field" bind:value={nameDraft} spellcheck="false" onkeydown={(e) => e.key === 'Enter' && applyName()} onblur={applyName} />
        </label>
      {/if}

      {#if s.tag && isPrimitive && !s.node}
        <div class="fieldset">
          <span class="label">Value</span>
          {#if s.tag.type === TagType.String}
            <textarea class="field" rows={Math.min(10, Math.max(2, draft.split('\n').length))} bind:value={draft} spellcheck="false"
              onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) applyValue(); }} onblur={applyValue}></textarea>
            <span class="hint">{draft.length.toLocaleString()} characters · Ctrl+Enter to apply</span>
          {:else}
            <input class="field mono" class:invalid={!!error} bind:value={draft}
              oninput={() => { const p = parsePrimitive(s.tag!.type, draft); error = p.ok ? null : (p.error ?? null); }}
              onkeydown={(e) => e.key === 'Enter' && applyValue()} onblur={applyValue} />
            {#if error}<span class="error-text">{error}</span>
            {:else if range}<span class="hint">Range {range[0].toLocaleString()} … {range[1].toLocaleString()}</span>{/if}
            {#if s.tag.type === TagType.Byte && (s.tag.value === 0 || s.tag.value === 1)}
              <div class="bool">
                <span class="hint">Looks like a flag:</span>
                <button class="btn" class:primary={s.tag.value === 0} onclick={() => setBool(0)}>false (0)</button>
                <button class="btn" class:primary={s.tag.value === 1} onclick={() => setBool(1)}>true (1)</button>
              </div>
            {/if}
          {/if}
        </div>
      {/if}

      {#if s.tag && isArray && !s.node}
        <div class="fieldset"><span class="label">Elements</span><ArrayEditor {tab} {row} /></div>
      {/if}

      {#if s.tag && isContainer}
        <div class="stats">
          <div><span class="label">Entries</span><b>{entryCount.toLocaleString()}</b></div>
          {#if s.tag.type === TagType.List}
            <div><span class="label">Element type</span><b>{s.tag.value.length ? TAG_META[s.tag.elementType].name : 'any (empty)'}</b></div>
          {/if}
          {#if dataVersion !== null}
            <div><span class="label">Minecraft</span><b>{describeDataVersion(dataVersion)}</b><span class="hint">DataVersion {dataVersion}</span></div>
          {/if}
          {#if hint}<div><span class="label">Looks like</span><b class="mono">{hint}</b></div>{/if}
        </div>
        <div class="fieldset">
          <span class="label">Add a tag {s.tag.type === TagType.List && s.tag.value.length ? `(${TAG_META[s.tag.elementType].name} only)` : ''}</span>
          <div class="add-grid">
            {#each CREATABLE_TYPES as t (t)}
              <button
                class="add-type"
                title="Add {TAG_META[t].name}"
                disabled={s.tag.type === TagType.List && (s.tag.value as Tag[]).length > 0 && s.tag.elementType !== t}
                onclick={() => addTag(t)}
              >
                <TypeBadge type={t} size="sm" />
                <span>{TAG_META[t].name}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if s.node && s.node.kind !== 'folder'}
        <dl class="facts">
          {#if s.node.kind === 'nbt'}
            {#if s.node.source.file}<dt>Size</dt><dd>{formatBytes(s.node.source.file.size)}</dd>{/if}
            {#if s.node.state === 'ready'}<dt>Format</dt><dd>{describeFormat(s.node.format)}</dd>{/if}
            {#if s.node.root}<dt>Root name</dt><dd class="mono">"{s.node.root.name}"</dd>{/if}
          {:else if s.node.kind === 'region'}
            {#if s.node.source.file}<dt>Size</dt><dd>{formatBytes(s.node.source.file.size)}</dd>{/if}
            {#if s.node.coords}<dt>Region</dt><dd>{s.node.coords.rx}, {s.node.coords.rz}</dd>
              <dt>Chunks</dt><dd>{s.node.coords.rx * 32}…{s.node.coords.rx * 32 + 31}, {s.node.coords.rz * 32}…{s.node.coords.rz * 32 + 31}</dd>
              <dt>Blocks</dt><dd>X {s.node.coords.rx * 512}…{s.node.coords.rx * 512 + 511}, Z {s.node.coords.rz * 512}…{s.node.coords.rz * 512 + 511}</dd>{/if}
            <dt>Type</dt><dd>{s.node.category}</dd>
          {:else if s.node.kind === 'chunk'}
            <dt>Local</dt><dd>{s.node.slot.x}, {s.node.slot.z}</dd>
            {#if s.node.worldX !== null}<dt>Chunk</dt><dd>{s.node.worldX}, {s.node.worldZ}</dd>
              <dt>Blocks</dt><dd>X {s.node.worldX * 16}…{s.node.worldX * 16 + 15}, Z {s.node.worldZ! * 16}…{s.node.worldZ! * 16 + 15}</dd>{/if}
            <dt>Sectors</dt><dd>{s.node.slot.sectorCount} × 4 KiB</dd>
            {#if s.node.slot.timestamp}<dt>Saved</dt><dd>{new Date(s.node.slot.timestamp * 1000).toLocaleString()}</dd>{/if}
            {#if s.node.state === 'ready'}<dt>Compression</dt><dd>{COMPRESSION_NAMES[s.node.compressionId] ?? s.node.compressionId}{s.node.external ? ' · external .mcc' : ''}</dd>{/if}
          {/if}
          {#if s.node.state === 'error'}<dt>Error</dt><dd class="error-text">{s.node.error}</dd>{/if}
        </dl>
        {#if s.node.state !== 'ready' && s.node.state !== 'error'}
          <button class="btn" onclick={() => tab.expand(row)}><Icon name="open_in_new" size={16} /> Load contents</button>
        {/if}
        {#if row.holder}<p class="hint">{holderLabel(row.holder)}</p>{/if}
      {/if}

      {#if s.tag && isContainer}
        <details class="snbt">
          <summary><Icon name="code" size={15} /> SNBT preview</summary>
          <pre class="mono">{snbtPreview(s.tag)}</pre>
        </details>
      {/if}
    </div>

    {#if row.holder}
      <footer>
        {#each ['copy', 'cut', 'paste', 'duplicate', 'editSnbt', 'findValue', 'delete'] as id (id)}
          {@const c = commands[id]}
          {@const _t = app.clipboardTick + tab.version}
          <button class="btn ghost icon-only" class:danger={id === 'delete'} title="{c.label}{c.keys ? ` (${c.keys})` : ''}" disabled={c.enabled ? !(_t >= 0 && c.enabled()) : false} onclick={() => c.run()}>
            <Icon name={c.icon} size={18} />
          </button>
        {/each}
      </footer>
    {/if}
  {/if}
</aside>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--surface);
  }
  .empty {
    margin: auto;
    padding: 24px;
    text-align: center;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--border);
  }
  .big-icon {
    color: var(--accent);
    display: inline-flex;
  }
  .title {
    min-width: 0;
  }
  .kind {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .multi {
    color: var(--accent);
    text-transform: none;
    letter-spacing: 0;
  }
  .name {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px 6px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }
  .path code {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }
  .body {
    flex: 1;
    overflow: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .fieldset {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bool {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .stats > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-width: 0;
  }
  .stats b {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
  }
  .add-type {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    font-size: 12px;
    text-align: left;
  }
  .add-type:hover:not(:disabled) {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }
  .add-type:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 14px;
    margin: 0;
  }
  .facts dt {
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .snbt summary {
    cursor: pointer;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .snbt pre {
    margin: 8px 0 0;
    padding: 8px 10px;
    max-height: 320px;
    overflow: auto;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 11.5px;
    white-space: pre;
  }
  footer {
    display: flex;
    gap: 2px;
    padding: 6px 8px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
  }
</style>
