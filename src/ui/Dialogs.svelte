<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import TypeBadge from './TypeBadge.svelte';
  import { app, type Tab } from './state.svelte';
  import { commands } from './commands';
  import * as actions from '../lib/doc/actions';
  import { saveWorkspace } from '../lib/doc/export';
  import { parsePrimitive } from '../lib/nbt/format';
  import { parseSnbt, toSnbt } from '../lib/nbt/snbt';
  import { defaultTag, TAG_META, TagType, countTags, type Compression, type Tag } from '../lib/nbt/types';
  import type { FileNode } from '../lib/doc/model';

  const d = $derived(app.dialog);
  let dlg = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    if (!dlg) return;
    if (d && !dlg.open) dlg.showModal();
    if (!d && dlg.open) dlg.close();
  });

  const close = () => (app.dialog = null);

  // ------------------------------------------------------------------------- export
  let exportFiles = $state.raw<FileNode[]>([]);
  let selected = $state.raw<Set<FileNode>>(new Set());
  let compression = $state<'keep' | Compression>('keep');
  let busy = $state(false);

  function filesFor(t: Tab): FileNode[] {
    const dirty = t.ws.dirtyFiles();
    if (dirty.length) return dirty;
    const r = t.ws.root;
    return r.kind === 'nbt' || r.kind === 'region' ? [r] : [];
  }

  // Only re-initialise when the dialog opens. The writes must stay untracked: reading
  // `exportFiles` right after assigning it would make this effect depend on itself (infinite loop).
  $effect(() => {
    const cur = d;
    if (cur?.kind !== 'export') return;
    untrack(() => {
      const files = filesFor(cur.tab);
      exportFiles = files;
      selected = new Set(files);
      compression = 'keep';
      busy = false;
    });
  });

  async function doExport(tab: Tab): Promise<void> {
    const files = exportFiles.filter((f) => selected.has(f));
    if (!files.length) return;
    busy = true;
    try {
      if (compression !== 'keep') for (const f of files) if (f.kind === 'nbt' && !f.format.bedrockHeader) f.format = { ...f.format, compression };
      const reports = await saveWorkspace(tab.ws, files, { backup: app.backupOnSave });
      const backups = reports.filter((r) => r.backup === 'downloaded').length;
      const unavailable = reports.filter((r) => r.backup === 'unavailable').length;
      app.toast('ok', `Downloaded ${reports.length} file${reports.length > 1 ? 's' : ''}${backups ? ` + ${backups} .backup` : ''}`);
      if (unavailable) app.toast('warn', `${unavailable} backup(s) could not be created (no original available)`);
      close();
    } catch (e) {
      app.toast('error', `Download failed: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }

  // ------------------------------------------------------------------------- add tag
  let newName = $state('');
  let newValue = $state('');
  let addError = $state<string | null>(null);

  $effect(() => {
    if (d?.kind === 'addTag') {
      newName = '';
      newValue = d.type === TagType.String ? '' : d.type <= TagType.Double ? '0' : '';
      addError = null;
    }
  });

  function doAdd(): void {
    if (d?.kind !== 'addTag') return;
    let tag: Tag = defaultTag(d.type);
    if (d.type <= TagType.Double || d.type === TagType.String) {
      const p = parsePrimitive(d.type, newValue);
      if (!p.ok) { addError = p.error ?? 'Invalid value'; return; }
      tag = { type: d.type, value: p.value } as Tag;
    }
    const point = actions.insertionPoint(d.row);
    if (point && point.container.type === TagType.Compound && point.container.value.has(newName)) {
      addError = `"${newName}" already exists here`;
      return;
    }
    const res = actions.insertTags(d.tab.ws, d.row, [{ name: newName, tag }], `Add ${TAG_META[d.type].name}`, 'add');
    if (!res.ok) { addError = res.error; return; }
    if (point) d.tab.expanded.add(point.container);
    d.tab.expandTick++;
    app.lastEntry = res.entry;
    queueMicrotask(() => { d.tab.select(tag); d.tab.scrollRequest++; });
    close();
  }

  // ------------------------------------------------------------------------- SNBT
  let snbtText = $state('');
  let snbtError = $state<string | null>(null);
  let snbtTooBig = $state(false);

  $effect(() => {
    if (d?.kind === 'snbt') {
      snbtError = null;
      snbtTooBig = false;
      if (d.mode === 'edit' && d.row.tag) {
        snbtTooBig = countTags(d.row.tag) > 200_000;
        snbtText = snbtTooBig ? '' : toSnbt(d.row.tag, { indent: '  ' });
      } else snbtText = '';
    }
  });

  function doSnbt(): void {
    if (d?.kind !== 'snbt') return;
    let tag: Tag;
    try {
      tag = parseSnbt(snbtText);
    } catch (e) {
      snbtError = (e as Error).message;
      return;
    }
    const res = d.mode === 'edit' ? actions.replaceTag(d.tab.ws, d.row, tag) : actions.insertTags(d.tab.ws, d.row, [{ name: null, tag }], 'Insert SNBT', 'code');
    if (!res.ok) { snbtError = res.error; return; }
    app.lastEntry = res.entry;
    close();
  }

  // ------------------------------------------------------------------------- confirm close

  const groups = ['File', 'Edit', 'Tree', 'Search', 'View', 'Help'] as const;
</script>

<dialog bind:this={dlg} onclose={() => (app.dialog = null)} onclick={(e) => { if (e.target === dlg) close(); }}>
  {#if d?.kind === 'export'}
    <div class="panel wide">
      <h2><Icon name="download" size={20} /> Download</h2>
      {#if exportFiles.length === 0}
        <p class="hint">Nothing to download yet. Open a file inside this folder and edit it first.</p>
      {:else}
        <ul class="files">
          {#each exportFiles as f (f.id)}
            <li>
              <label class="checkbox">
                <input type="checkbox" checked={selected.has(f)} onchange={(e) => { const s = new Set(selected); if ((e.target as HTMLInputElement).checked) s.add(f); else s.delete(f); selected = s; }} />
                <Icon name={f.kind === 'region' ? 'grid_view' : 'description'} size={17} />
                <span class="fname">{f.name}</span>
              </label>
            </li>
          {/each}
        </ul>

        <label class="checkbox backup">
          <input type="checkbox" checked={app.backupOnSave} onchange={(e) => app.setBackup((e.target as HTMLInputElement).checked)} />
          <span><b>Also download the original as <code>&lt;filename&gt;.backup</code></b><br />
            <span class="hint">The untouched original, byte for byte. It is streamed from your disk, so no extra memory is used.</span></span>
        </label>

        {#if exportFiles.some((f) => f.kind === 'nbt' && !f.format.bedrockHeader)}
          <label class="row-field">
            <span class="label">Compression</span>
            <select class="field" bind:value={compression}>
              <option value="keep">Keep original</option>
              <option value="gzip">gzip (level.dat, player data, schematics)</option>
              <option value="zlib">zlib</option>
              <option value="none">Uncompressed (servers.dat, idcounts.dat)</option>
            </select>
          </label>
        {/if}
      {/if}
      <div class="actions">
        <button class="btn" onclick={close}>Cancel</button>
        <span class="grow"></span>
        <button class="btn primary" disabled={busy || !selected.size} onclick={() => d.kind === 'export' && doExport(d.tab)}><Icon name="download" size={17} /> Download</button>
      </div>
    </div>
  {:else if d?.kind === 'addTag'}
    <form class="panel" onsubmit={(e) => { e.preventDefault(); doAdd(); }}>
      <h2><TypeBadge type={d.type} size="lg" /> New {TAG_META[d.type].name} tag</h2>
      <label class="col-field">
        <span class="label">Name</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="field" bind:value={newName} autofocus spellcheck="false" placeholder="e.g. CustomName" />
      </label>
      {#if d.type <= TagType.Double || d.type === TagType.String}
        <label class="col-field">
          <span class="label">Value</span>
          <input class="field mono" bind:value={newValue} spellcheck="false" />
        </label>
      {:else}
        <p class="hint">Starts empty, add entries afterwards.</p>
      {/if}
      {#if addError}<p class="error-text">{addError}</p>{/if}
      <div class="actions">
        <button type="button" class="btn" onclick={close}>Cancel</button>
        <span class="grow"></span>
        <button class="btn primary" type="submit"><Icon name="add" size={17} /> Add</button>
      </div>
    </form>
  {:else if d?.kind === 'snbt'}
    <div class="panel wide">
      <h2><Icon name="code" size={20} /> {d.mode === 'edit' ? 'Edit as SNBT' : 'Insert from SNBT'}</h2>
      <p class="hint">SNBT is the text format used by <code>/data</code>, <code>/give</code> and <code>/summon</code>, for example <code>{'{'}id:"minecraft:diamond",count:3{'}'}</code>.</p>
      {#if snbtTooBig}
        <p class="error-text">This tag is too large to edit as text. Edit it in the tree instead.</p>
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <textarea class="field snbt" bind:value={snbtText} spellcheck="false" autofocus rows="16"
          onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSnbt(); }}></textarea>
      {/if}
      {#if snbtError}<p class="error-text">{snbtError}</p>{/if}
      <div class="actions">
        <button class="btn" onclick={close}>Cancel</button>
        <span class="grow"></span>
        <span class="hint">Ctrl+Enter</span>
        <button class="btn primary" disabled={snbtTooBig} onclick={doSnbt}><Icon name="check_circle" size={17} /> Apply</button>
      </div>
    </div>
  {:else if d?.kind === 'confirmClose'}
    <div class="panel">
      <h2><Icon name="warning" size={20} /> Unsaved changes</h2>
      <p><b>{d.tab.title}</b> has changes that were not downloaded yet. Closing the tab discards them.</p>
      <div class="actions">
        <button class="btn" onclick={close}>Cancel</button>
        <span class="grow"></span>
        <button class="btn danger" onclick={() => { if (d.kind === 'confirmClose') app.closeTab(d.tab); close(); }}><Icon name="delete" size={17} /> Discard</button>
        <button class="btn primary" onclick={() => { if (d.kind === 'confirmClose') app.dialog = { kind: 'export', tab: d.tab }; }}><Icon name="download" size={17} /> Download…</button>
      </div>
    </div>
  {:else if d?.kind === 'shortcuts'}
    <div class="panel wide">
      <h2><Icon name="keyboard" size={20} /> Keyboard shortcuts</h2>
      <div class="shortcuts">
        {#each groups as g (g)}
          {@const list = Object.values(commands).filter((c) => c.group === g && c.keys)}
          {#if list.length}
            <section>
              <h3 class="label">{g}</h3>
              {#each list as c (c.id)}
                <div class="sc"><Icon name={c.icon} size={16} /><span>{c.label}</span><kbd>{c.keys}</kbd></div>
              {/each}
            </section>
          {/if}
        {/each}
        <section>
          <h3 class="label">Tree</h3>
          <div class="sc"><Icon name="chevron_right" size={16} /><span>Expand / collapse</span><kbd>→ ←</kbd></div>
          <div class="sc"><Icon name="select_all" size={16} /><span>Multi-select</span><kbd>Ctrl/Shift+Click</kbd></div>
          <div class="sc"><Icon name="more_vert" size={16} /><span>All actions</span><kbd>Right-click</kbd></div>
        </section>
      </div>
      <div class="actions"><span class="grow"></span><button class="btn" onclick={close}>Close</button></div>
    </div>
  {:else if d?.kind === 'about'}
    <div class="panel about">
      <img src="./icon.gif" alt="" width="96" height="96" />
      <div>
        <h2>NBT-Editor</h2>
        <p>Explore and edit Minecraft NBT data: level.dat, player data, region files (.mca incl. LZ4), structures,
          schematics and Bedrock files. Right in your browser.</p>
        <p class="private"><Icon name="lock" size={16} fill /> Your files are read and written locally. Nothing is uploaded and the app makes no network requests.</p>
        <p class="hint">A modern rewrite inspired by <b>NBTExplorer</b> by Justin Aquadro (MIT License, © 2011). NBT-Editor is
          also released under the MIT License. Icons: Material Symbols (Apache 2.0). Fonts: IBM Plex Sans, JetBrains Mono (OFL).
          Not affiliated with Mojang or Microsoft.</p>
      </div>
      <div class="actions"><span class="grow"></span><button class="btn" onclick={close}>Close</button></div>
    </div>
  {/if}
</dialog>

<style>
  dialog {
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
    max-width: calc(100vw - 32px);
  }
  dialog::backdrop {
    background: var(--scrim);
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 20px 16px;
    width: 440px;
    max-width: 100%;
  }
  .panel.wide {
    width: 640px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 2px;
    font-size: 16px;
    font-weight: 600;
  }
  h2 :global(.icon) {
    color: var(--accent);
  }
  p {
    margin: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .grow {
    flex: 1;
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 220px;
    overflow: auto;
  }
  .files li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 6px;
  }
  .fname {
    font-weight: 500;
  }
  .backup {
    align-items: flex-start;
    padding: 10px 12px;
    border: 1px solid var(--accent-line);
    background: var(--accent-soft);
    border-radius: var(--radius);
  }
  .backup input {
    margin-top: 2px;
  }
  .row-field {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .row-field .field {
    flex: 1;
  }
  .col-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .snbt {
    min-height: 260px;
    max-height: 60vh;
  }
  .shortcuts {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 14px 24px;
  }
  .shortcuts h3 {
    margin: 0 0 6px;
  }
  .sc {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  }
  .sc span {
    flex: 1;
  }
  .sc :global(.icon) {
    color: var(--muted);
  }
  .about {
    width: 560px;
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 18px;
  }
  .about img {
    image-rendering: pixelated;
  }
  .about > div {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .about .actions {
    grid-column: 1 / -1;
  }
  .private {
    display: flex;
    gap: 6px;
    color: var(--ok);
  }
</style>
