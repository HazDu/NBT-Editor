<script lang="ts">
  import Icon from './Icon.svelte';
  import TopBar from './TopBar.svelte';
  import TabBar from './TabBar.svelte';
  import Tree from './Tree.svelte';
  import Inspector from './Inspector.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import ChangesPanel from './ChangesPanel.svelte';
  import StatusBar from './StatusBar.svelte';
  import EmptyState from './EmptyState.svelte';
  import ContextMenu from './ContextMenu.svelte';
  import Dialogs from './Dialogs.svelte';
  import Toasts from './Toasts.svelte';
  import { app } from './state.svelte';
  import { commands, copySelection, openDirectory, openPicked, pasteText } from './commands';
  import { itemsFromDrop } from '../lib/fs/access';

  const tab = $derived(app.active);
  let dragging = $state(false);
  let dragDepth = 0;
  let panelHeight = $state(260);
  let searchPanel = $state<{ next(): void } | null>(null);

  function inEditable(e: Event): boolean {
    const el = (e.target as HTMLElement | null) ?? document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
  }

  function onKey(e: KeyboardEvent): void {
    if (app.dialog) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const run = (id: string) => { e.preventDefault(); void commands[id].run(); };

    if (ctrl && !e.shiftKey && k === 'o') return run('open');
    if (ctrl && e.shiftKey && k === 'o') return run('openFolder');
    if (ctrl && k === 's') return run('download');
    if (ctrl && e.shiftKey && k === 'f') return run('findValue');
    if (ctrl && k === 'f') return run('find');
    if (e.key === 'F3') {
      e.preventDefault();
      if (app.panel !== 'search') app.setPanel('search');
      queueMicrotask(() => searchPanel?.next());
      return;
    }
    if (e.altKey && k === 'n') return run('newFile');
    if (e.altKey && k === 'w') return run('closeTab');
    if (e.altKey && k === 'h') return run('changes');
    if (ctrl && e.key === 'Tab' && app.tabs.length > 1) {
      e.preventDefault();
      const i = app.tabs.indexOf(app.active!);
      app.active = app.tabs[(i + (e.shiftKey ? -1 : 1) + app.tabs.length) % app.tabs.length];
      return;
    }
    if (inEditable(e)) return;
    if (ctrl && !e.shiftKey && k === 'z') return run('undo');
    if ((ctrl && k === 'y') || (ctrl && e.shiftKey && k === 'z')) return run('redo');
    if (ctrl && k === 'd') return run('duplicate');
    if (e.key === '?' && !ctrl) return run('shortcuts');
    if (e.key === 'Escape' && app.menu) app.menu = null;
  }

  // Native clipboard events give us clipboardData without a permission prompt.
  function onCopy(e: ClipboardEvent): void {
    if (inEditable(e) || app.dialog || !app.active?.focusedRow?.tag) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
    void copySelection(false);
  }
  function onCut(e: ClipboardEvent): void {
    if (inEditable(e) || app.dialog || !app.active?.focusedRow?.tag) return;
    e.preventDefault();
    void copySelection(true);
  }
  function onPaste(e: ClipboardEvent): void {
    if (inEditable(e) || app.dialog || !app.active) return;
    e.preventDefault();
    pasteText(e.clipboardData?.getData('text/plain') ?? null);
  }

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  }
  function onDragEnter(e: DragEvent): void {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dragging = true;
  }
  function onDragLeave(): void {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging = false;
  }
  async function onDrop(e: DragEvent): Promise<void> {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragging = false;
    dragDepth = 0;
    try {
      const { files, dirs } = await itemsFromDrop(e.dataTransfer!);
      openPicked(files);
      for (const d of dirs) openDirectory(d);
    } catch (err) {
      app.toast('error', `Could not open dropped items: ${(err as Error).message}`);
    }
  }

  function onBeforeUnload(e: BeforeUnloadEvent): void {
    if (app.tabs.some((t) => t.ws.isDirty)) e.preventDefault();
  }

  // Installed PWA: files opened via the OS "Open with" land here.
  $effect(() => {
    const lq = (window as Window & { launchQueue?: { setConsumer(fn: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      const picked = await Promise.all(params.files.map(async (handle) => ({ file: await handle.getFile(), handle })));
      openPicked(picked);
    });
  });

  // ---------------------------------------------------------------- resizers
  function resizeInspector(e: PointerEvent): void {
    const startX = e.clientX;
    const startW = app.inspectorWidth;
    const move = (ev: PointerEvent) => app.setInspectorWidth(Math.max(260, Math.min(720, startW - (ev.clientX - startX))));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }
  function resizePanel(e: PointerEvent): void {
    const startY = e.clientY;
    const startH = panelHeight;
    const move = (ev: PointerEvent) => (panelHeight = Math.max(140, Math.min(innerHeight - 200, startH - (ev.clientY - startY))));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }
</script>

<svelte:window onkeydown={onKey} onbeforeunload={onBeforeUnload} />
<svelte:document oncopy={onCopy} oncut={onCut} onpaste={onPaste} />

<div
  class="app"
  role="application"
  ondragenter={onDragEnter}
  ondragover={(e) => { if (hasFiles(e)) e.preventDefault(); }}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <TopBar />
  <TabBar />
  <main class="main">
    {#if tab}
      <div class="work">
        <div class="split" style="--iw: {app.inspectorWidth}px">
          <section class="tree-pane" aria-label="Tree">
            {#key tab}
              <Tree {tab} />
            {/key}
          </section>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="vgrip" onpointerdown={resizeInspector} title="Drag to resize"></div>
          <Inspector {tab} />
        </div>
        {#if app.panel}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="hgrip" onpointerdown={resizePanel} title="Drag to resize"></div>
          <section class="dock" style="height: {panelHeight}px">
            <div class="dock-tabs">
              <button class:on={app.panel === 'search'} onclick={() => app.setPanel('search')}><Icon name="search" size={16} /> Search</button>
              <button class:on={app.panel === 'changes'} onclick={() => app.setPanel('changes')}><Icon name="history" size={16} /> Changes</button>
              <span class="grow"></span>
              <button class="x" title="Close panel" onclick={() => app.setPanel(null)}><Icon name="bottom_panel_close" size={17} /></button>
            </div>
            <div class="dock-body">
              {#key tab}
                {#if app.panel === 'search'}
                  <SearchPanel {tab} bind:this={searchPanel} />
                {:else}
                  <ChangesPanel {tab} />
                {/if}
              {/key}
            </div>
          </section>
        {/if}
      </div>
    {:else}
      <EmptyState />
    {/if}
  </main>
  <StatusBar />

  {#if dragging}
    <div class="dropzone">
      <div class="dz-inner">
        <img src="./icon.gif" alt="" width="72" height="72" />
        <b>Drop to open</b>
        <span class="hint">Files open in new tabs; folders open as a world browser.</span>
      </div>
    </div>
  {/if}
</div>

<ContextMenu />
<Dialogs />
<Toasts />

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .main {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .work {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 5px var(--iw);
    /* cap the row: a tall inspector (array grid) must scroll, not push the tree over the dock */
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }
  .tree-pane {
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  .vgrip {
    cursor: col-resize;
    background: var(--border);
    border-left: 2px solid var(--bg);
    border-right: 2px solid var(--surface);
  }
  .vgrip:hover,
  .hgrip:hover {
    background: var(--accent);
  }
  .hgrip {
    height: 4px;
    cursor: row-resize;
    background: var(--border);
  }
  .dock {
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    min-height: 0;
  }
  .dock-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px;
    height: 32px;
    border-bottom: 1px solid var(--border);
  }
  .dock-tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
  }
  .dock-tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .dock-tabs .x {
    border: 0;
  }
  .grow {
    flex: 1;
  }
  .dock-body {
    flex: 1;
    min-height: 0;
  }
  .dropzone {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    background: var(--scrim);
    pointer-events: none;
  }
  .dz-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 28px 40px;
    border: 2px dashed var(--accent);
    border-radius: 10px;
    background: var(--surface);
  }
  .dz-inner img {
    image-rendering: pixelated;
  }
</style>
