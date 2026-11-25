<script lang="ts">
  import Icon from './Icon.svelte';
  import { commands } from './commands';

  const formats = [
    { icon: 'public', title: 'World & player data', ext: 'level.dat · playerdata/*.dat · .dat_old' },
    { icon: 'grid_view', title: 'Region files', ext: '.mca · .mcr · entities · poi · LZ4 & .mcc' },
    { icon: 'deployed_code', title: 'Structures & schematics', ext: '.nbt · .schem · .schematic · .litematic' },
    { icon: 'view_in_ar', title: 'Bedrock Edition', ext: 'level.dat · .mcstructure' },
  ];

  const paths = [
    { os: 'Windows', path: '%APPDATA%\\.minecraft\\saves' },
    { os: 'macOS', path: '~/Library/Application Support/minecraft/saves' },
    { os: 'Linux', path: '~/.minecraft/saves' },
  ];
</script>

<div class="empty">
  <section class="drop">
    <img src="./icon.gif" alt="" width="112" height="112" />
    <h1>Drop NBT files or a world folder here</h1>
    <p class="hint">Or pick them from your computer. You can open several files: each gets its own tab, and you can copy & paste between them.</p>
    <div class="buttons">
      <button class="btn primary" onclick={() => commands.open.run()}><Icon name="file_open" size={18} /> Open files</button>
      <button class="btn" onclick={() => commands.openFolder.run()}><Icon name="folder_open" size={18} /> Open world folder</button>
      <button class="btn ghost" onclick={() => commands.newFile.run()}><Icon name="note_add" size={18} /> New file</button>
    </div>
    <p class="privacy"><Icon name="lock" size={16} fill /> Everything runs in this browser tab. Your files are never uploaded.</p>
  </section>

  <section class="side">
    <h2 class="label">Opens</h2>
    <ul class="formats">
      {#each formats as f (f.title)}
        <li>
          <span class="fi"><Icon name={f.icon} size={20} /></span>
          <div><b>{f.title}</b><span class="mono">{f.ext}</span></div>
        </li>
      {/each}
    </ul>

    <h2 class="label">Where are my worlds?</h2>
    <dl class="paths">
      {#each paths as p (p.os)}
        <dt>{p.os}</dt><dd><code>{p.path}</code></dd>
      {/each}
    </dl>
    <p class="hint">Tip: work on a copy of your world, or keep "Also download the original as .backup" switched on.</p>

    <h2 class="label">Good to know</h2>
    <ul class="tips">
      <li><kbd>Ctrl</kbd>+<kbd>F</kbd> searches every file and chunk in a tab</li>
      <li>Right-click any tag for all actions</li>
      <li>Copied tags land on your clipboard as SNBT, ready for <code>/data</code> commands</li>
      <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes anything; the <Icon name="history" size={14} /> Changes panel lists every edit</li>
    </ul>
  </section>
</div>

<style>
  .empty {
    display: grid;
    grid-template-columns: minmax(320px, 1.2fr) minmax(280px, 1fr);
    gap: 28px;
    padding: 36px clamp(16px, 5vw, 64px);
    height: 100%;
    overflow: auto;
    align-content: start;
  }
  .drop {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 28px;
    border: 1.5px dashed var(--border-strong);
    border-radius: 8px;
    background: var(--surface);
  }
  .drop img {
    image-rendering: pixelated;
    margin-bottom: 4px;
  }
  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .drop .hint {
    margin: 0;
    max-width: 52ch;
    font-size: 13px;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
  }
  .buttons .btn {
    height: 34px;
    padding: 0 14px;
  }
  .privacy {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 10px 0 0;
    color: var(--ok);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .side h2 {
    margin: 8px 0 0;
  }
  .formats {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .formats li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .fi {
    display: inline-flex;
    color: var(--accent);
  }
  .formats div {
    display: flex;
    flex-direction: column;
  }
  .formats .mono {
    color: var(--muted);
    font-size: 11.5px;
  }
  .paths {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    margin: 0;
  }
  .paths dt {
    color: var(--muted);
  }
  .paths dd {
    margin: 0;
  }
  .side > .hint {
    margin: 0;
  }
  .tips {
    margin: 0;
    padding-left: 18px;
    color: var(--text-2);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  @media (max-width: 860px) {
    .empty {
      grid-template-columns: 1fr;
    }
  }
</style>
