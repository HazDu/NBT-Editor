<script lang="ts">
  import Icon from './Icon.svelte';
  import TypeBadge from './TypeBadge.svelte';
  import { app, type Tab } from './state.svelte';
  import { runSearch, MAX_RESULTS, type SearchResult, type SearchRun } from '../lib/search/runner';
  import { replaceInResults } from '../lib/search/replace';
  import { RULE_OPS, validateQuery, type MatchMode, type Query, type TagRule } from '../lib/search/query';
  import { formatPath } from '../lib/nbt/format';
  import { findTagPath, resolvePath } from '../lib/doc/rows';
  import { loadNode, type RegionFileNode, type SourceNode } from '../lib/doc/model';

  let { tab }: { tab: Tab } = $props();

  type Mode = 'quick' | 'rules' | 'chunk';
  let mode = $state<Mode>('quick');
  let name = $state('');
  let value = $state('');
  let match = $state<MatchMode>('contains');
  let caseSensitive = $state(false);
  let scopeSel = $state(false);
  let rules = $state<TagRule[]>([{ kind: 'rule', name: 'id', op: '=', value: 'minecraft:' }]);
  let ruleMatch = $state<'all' | 'any'>('all');
  let replaceWith = $state('');
  let showReplace = $state(false);

  let results = $state.raw<SearchResult[]>([]);
  let running = $state<SearchRun | null>(null);
  let progress = $state<{ done: number; total: number } | null>(null);
  let message = $state<string | null>(null);
  let activeId = $state<number | null>(null);
  let shown = $state(300);

  // chunk finder
  let cx = $state('');
  let cz = $state('');
  let coordKind = $state<'block' | 'chunk'>('block');
  let chunkHits = $state.raw<RegionFileNode[]>([]);

  function query(): Query {
    if (mode === 'rules') return { kind: 'rules', root: { kind: 'group', match: ruleMatch, rules: rules.filter((r) => r.name) } };
    return { kind: 'quick', name: name.trim(), value, mode: match, caseSensitive };
  }

  function start(): void {
    const q = query();
    const err = validateQuery(q);
    if (err) { message = err; return; }
    running?.cancel();
    results = [];
    shown = 300;
    message = null;
    activeId = null;
    const scope: SourceNode = scopeSel && tab.focusedRow?.node ? tab.focusedRow.node : scopeSel && tab.focusedRow?.holder ? tab.focusedRow.holder : tab.ws.root;
    const buffer: SearchResult[] = [];
    let flush = 0;
    const doFlush = () => { flush = 0; results = results.concat(buffer.splice(0)); };
    running = runSearch(q, scope, {
      onResult(r) {
        buffer.push(r);
        if (!flush) flush = requestAnimationFrame(doFlush);
      },
      onProgress(done, total) { progress = { done, total }; },
      onDone({ cancelled, errors }) {
        if (flush) cancelAnimationFrame(flush);
        doFlush();
        running = null;
        progress = null;
        const n = results.length;
        message = cancelled ? `Cancelled · ${n.toLocaleString()} found so far` : `${n.toLocaleString()} result${n === 1 ? '' : 's'}${errors.length ? ` · ${errors.join('; ')}` : ''}`;
      },
    });
  }

  async function open(r: SearchResult): Promise<void> {
    activeId = r.id;
    const holder = r.chunk ?? (r.file.kind === 'nbt' ? r.file : null);
    if (!holder) return;
    if (holder.state !== 'ready') await tab.ws.load(holder);
    if (!holder.root) { app.toast('error', holder.error ?? 'Could not load'); return; }
    let chain = r.tag ? findTagPath(holder.root.tag, r.tag)?.chain : null;
    chain ??= resolvePath(holder.root.tag, r.path);
    if (!chain) { app.toast('warn', 'This result no longer exists (it was edited or deleted)'); return; }
    await tab.reveal(holder, chain);
  }

  export function next(): void {
    if (results.length === 0) { start(); return; }
    const i = results.findIndex((r) => r.id === activeId);
    void open(results[(i + 1) % results.length]);
  }

  async function replaceAll(): Promise<void> {
    const q = query();
    if (q.kind !== 'quick' || !q.value) { app.toast('warn', 'Replace works on value searches'); return; }
    const rep = await replaceInResults(tab.ws, results, q, replaceWith);
    app.toast(rep.replaced ? 'ok' : 'warn', `Replaced ${rep.replaced} value(s)${rep.skipped ? `, skipped ${rep.skipped}` : ''}${rep.errors.length ? ` · ${rep.errors[0]}` : ''}. Undo with Ctrl+Z.`);
    if (rep.replaced) start();
  }

  // ------------------------------------------------------------------ chunk finder
  async function findChunk(): Promise<void> {
    const x = Number(cx), z = Number(cz);
    if (!Number.isFinite(x) || !Number.isFinite(z) || cx.trim() === '' || cz.trim() === '') { message = 'Enter X and Z'; return; }
    const chunkX = coordKind === 'block' ? Math.floor(x / 16) : Math.floor(x);
    const chunkZ = coordKind === 'block' ? Math.floor(z / 16) : Math.floor(z);
    const rx = Math.floor(chunkX / 32), rz = Math.floor(chunkZ / 32);
    const found: RegionFileNode[] = [];
    const walk = async (n: SourceNode) => {
      if (n.kind === 'folder') {
        await loadNode(n);
        for (const c of n.children ?? []) await walk(c);
      } else if (n.kind === 'region' && n.coords && n.coords.rx === rx && n.coords.rz === rz) found.push(n);
    };
    await walk(tab.ws.root);
    tab.ws.bump();
    chunkHits = found;
    message = found.length
      ? `Chunk ${chunkX}, ${chunkZ} is in r.${rx}.${rz}.mca (local ${chunkX - rx * 32}, ${chunkZ - rz * 32})`
      : `Chunk ${chunkX}, ${chunkZ} would be in r.${rx}.${rz}.mca, which is not open in this tab`;
    if (found.length === 1) await goChunk(found[0], chunkX - rx * 32, chunkZ - rz * 32);
  }

  async function goChunk(region: RegionFileNode, lx: number, lz: number): Promise<void> {
    await tab.ws.load(region);
    const c = region.chunks?.find((k) => k.slot.x === lx && k.slot.z === lz && !k.deleted);
    if (!c) { app.toast('warn', 'That chunk has not been generated (not in the region file)'); return; }
    await tab.revealNode(c);
  }

  // "Find this value" from the tree / inspector / context menu
  $effect(() => {
    const req = app.searchRequest;
    if (!req) return;
    app.searchRequest = null;
    mode = 'quick';
    name = '';
    value = req.value;
    match = 'exact';
    scopeSel = false;
    showReplace = false;
    start();
  });

  const pct = $derived(progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0);
</script>

<div class="search">
  <div class="modes" role="tablist">
    <button role="tab" aria-selected={mode === 'quick'} class:on={mode === 'quick'} onclick={() => (mode = 'quick')}><Icon name="search" size={16} /> Find</button>
    <button role="tab" aria-selected={mode === 'rules'} class:on={mode === 'rules'} onclick={() => (mode = 'rules')}><Icon name="manage_search" size={16} /> Rules</button>
    <button role="tab" aria-selected={mode === 'chunk'} class:on={mode === 'chunk'} onclick={() => (mode = 'chunk')}><Icon name="my_location" size={16} /> Go to chunk</button>
  </div>

  {#if mode === 'quick'}
    <form class="form" onsubmit={(e) => { e.preventDefault(); start(); }}>
      <label class="in"><Icon name="data_object" size={16} /><input data-search-input class="field" placeholder="Key name, e.g. Health" bind:value={name} spellcheck="false" /></label>
      <label class="in"><Icon name="text_fields" size={16} /><input class="field" placeholder="Value, e.g. minecraft:diamond or [I;1,2,3,4]" title="Text, number, array like [I;1,2,3,4] or a UUID like 0f3a…-…" bind:value={value} spellcheck="false" /></label>
      <select class="field" bind:value={match} title="How to match">
        <option value="contains">contains</option>
        <option value="exact">is exactly</option>
        <option value="regex">regex</option>
      </select>
      <button type="button" class="btn icon-only" class:primary={caseSensitive} title="Match case" onclick={() => (caseSensitive = !caseSensitive)}><span class="mono">Aa</span></button>
      <button type="button" class="btn icon-only" class:primary={showReplace} title="Find & replace" onclick={() => (showReplace = !showReplace)}><Icon name="find_replace" size={17} /></button>
      {#if running}
        <button type="button" class="btn" onclick={() => running?.cancel()}><Icon name="close" size={16} /> Cancel</button>
      {:else}
        <button class="btn primary" type="submit"><Icon name="search" size={16} /> Search</button>
      {/if}
    </form>
    {#if showReplace}
      <div class="form">
        <label class="in grow"><Icon name="swap_horiz" size={16} /><input class="field" placeholder="Replace value with…" bind:value={replaceWith} spellcheck="false" /></label>
        <button class="btn" disabled={!results.length || !!running} onclick={replaceAll}><Icon name="find_replace" size={16} /> Replace in {results.length.toLocaleString()} result{results.length === 1 ? '' : 's'}</button>
      </div>
    {/if}
  {:else if mode === 'rules'}
    <div class="rules">
      <div class="rule-head">
        <span class="hint">Find compounds (entities, items, block entities…) where</span>
        <select class="field" bind:value={ruleMatch}><option value="all">all rules match</option><option value="any">any rule matches</option></select>
      </div>
      {#each rules as rule, i (i)}
        <div class="rule">
          <input class="field mono" placeholder="key" bind:value={rule.name} spellcheck="false" />
          <select class="field" bind:value={rule.op}>{#each RULE_OPS as o (o.op)}<option value={o.op}>{o.label}</option>{/each}</select>
          <input class="field mono" placeholder="value" bind:value={rule.value} disabled={rule.op === 'exists'} spellcheck="false" />
          <button class="btn ghost icon-only" title="Remove rule" onclick={() => (rules = rules.filter((_, k) => k !== i))}><Icon name="close" size={16} /></button>
        </div>
      {/each}
      <div class="form">
        <button class="btn" onclick={() => (rules = [...rules, { kind: 'rule', name: '', op: '=', value: '' }])}><Icon name="add" size={16} /> Add rule</button>
        <span class="grow"></span>
        {#if running}
          <button class="btn" onclick={() => running?.cancel()}><Icon name="close" size={16} /> Cancel</button>
        {:else}
          <button class="btn primary" onclick={start}><Icon name="manage_search" size={16} /> Find compounds</button>
        {/if}
      </div>
    </div>
  {:else}
    <form class="form" onsubmit={(e) => { e.preventDefault(); void findChunk(); }}>
      <div class="seg">
        <button type="button" class:on={coordKind === 'block'} onclick={() => (coordKind = 'block')}>Block coords</button>
        <button type="button" class:on={coordKind === 'chunk'} onclick={() => (coordKind = 'chunk')}>Chunk coords</button>
      </div>
      <label class="in"><span class="axis">X</span><input class="field mono" bind:value={cx} placeholder="0" /></label>
      <label class="in"><span class="axis">Z</span><input class="field mono" bind:value={cz} placeholder="0" /></label>
      <button class="btn primary" type="submit"><Icon name="my_location" size={16} /> Go</button>
    </form>
    {#if chunkHits.length > 1}
      <div class="hits-inline">
        {#each chunkHits as r (r.id)}
          <button class="btn" onclick={() => { const x = Number(cx), z = Number(cz); const ccx = coordKind === 'block' ? Math.floor(x / 16) : x; const ccz = coordKind === 'block' ? Math.floor(z / 16) : z; void goChunk(r, ccx - r.coords!.rx * 32, ccz - r.coords!.rz * 32); }}>
            <Icon name="grid_view" size={16} /> {r.parent?.parent?.name ?? ''}/{r.parent?.name}/{r.name}
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  <div class="status">
    {#if progress}
      <div class="progress"><div style="width: {pct}%"></div></div>
      <span class="hint">Searching… {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · {results.length.toLocaleString()} found</span>
    {:else if message}
      <span class="hint">{message}</span>
    {/if}
    {#if mode !== 'chunk'}
      <label class="checkbox scope" title="Only search inside the selected file, chunk or tag">
        <input type="checkbox" bind:checked={scopeSel} /> Only in selection
      </label>
    {/if}
  </div>

  {#if mode !== 'chunk'}
    <ul class="results">
      {#each results.slice(0, shown) as r (r.id)}
        <li>
          <button class:active={activeId === r.id} onclick={() => open(r)}>
            <TypeBadge type={r.tagType} size="sm" />
            <span class="where">{r.file.name}{r.chunk ? ` › ${r.chunk.slot.x},${r.chunk.slot.z}` : ''}</span>
            <span class="rpath mono">{formatPath(r.path)}</span>
            <span class="rval mono">{r.preview}</span>
          </button>
        </li>
      {/each}
      {#if results.length > shown}
        <li><button class="more" onclick={() => (shown += 500)}>Show more ({(results.length - shown).toLocaleString()} hidden)</button></li>
      {/if}
      {#if !results.length && !running && !message}
        <li class="empty hint">
          <Icon name="travel_explore" size={22} />
          Search keys and values across every file and chunk in this tab. Unloaded region chunks are scanned in the background. Up to {MAX_RESULTS.toLocaleString()} results.
        </li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .search {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .modes {
    display: flex;
    gap: 2px;
    padding: 6px 10px 0;
  }
  .modes button,
  .seg button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: none;
    color: var(--muted);
    padding: 4px 10px;
    border-radius: var(--radius);
    font-size: 12px;
  }
  .modes button.on,
  .seg button.on {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1px;
  }
  .form {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 0;
    flex-wrap: wrap;
  }
  .in {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    flex: 1 1 180px;
    min-width: 140px;
  }
  .in .field {
    flex: 1;
  }
  .in.grow,
  .grow {
    flex: 1;
  }
  .axis {
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .rules {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px 0;
  }
  .rule-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rule {
    display: grid;
    grid-template-columns: 1fr 150px 1fr 28px;
    gap: 6px;
  }
  .rules .form {
    padding: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    min-height: 30px;
    border-bottom: 1px solid var(--border);
  }
  .scope {
    margin-left: auto;
    font-size: 12px;
    color: var(--muted);
  }
  .progress {
    width: 120px;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .progress div {
    height: 100%;
    background: var(--accent);
    transition: width 0.15s;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 2px 0;
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .results button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 26px;
    padding: 0 10px;
    border: 0;
    background: none;
    text-align: left;
    white-space: nowrap;
  }
  .results button:hover {
    background: var(--row-hover);
  }
  .results button.active {
    background: var(--row-select-strong);
  }
  .where {
    color: var(--muted);
    font-size: 12px;
    flex: none;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rpath {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .rval {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1;
  }
  .more {
    color: var(--accent) !important;
    justify-content: center;
  }
  .empty {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 14px;
    max-width: 640px;
  }
  .hits-inline {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 10px 0;
  }
</style>
