# NBT-Editor

A browser-based Minecraft NBT editor (rewrite of the 2011–2017 C# app NBTExplorer, which is kept read-only in
`NBTExplorer-master/` as a feature reference — never build or edit it). Static site: Vite + Svelte 5 (runes) + TypeScript.

## Non-negotiable rules
- **Nothing leaves the device.** No `fetch`/XHR/WebSocket/beacon calls, no analytics, no CDN assets, no Google Fonts.
  Fonts and icons are self-hosted npm packages. Production builds ship a CSP with `connect-src 'self'` (see `vite.config.ts`).
- **`src/lib/nbt/` is pure TypeScript** — no DOM, no Svelte imports. It must run in Node (Vitest) and Web Workers.
- **Every data mutation goes through the Journal** (`src/lib/doc/journal.ts`). Never assign to `tag.value`, `Map.set`,
  or `splice` from UI code: undo/redo, change markers, dirty state and the `.backup` fallback all depend on it.
- **Tag objects are identities.** Selection, expansion and change markers key on the tag object. Edit primitives by
  mutating `tag.value` (via the Journal), never by replacing the tag object.
- **No deep `$state` on documents.** NBT trees can have millions of nodes; Svelte proxies would kill performance.
  Workspaces expose a `version` counter; UI derives rows from it (`src/ui/state.svelte.ts`).
- **Reactivity gotcha:** because tags/nodes are mutated in place, `$derived(row.tag)` never "changes" and anything
  downstream goes stale. Derive display data from the `row` object itself (rebuilt on every version bump), or wrap
  values in a fresh object per version (see `TreeRow.svelte` `v`, `Inspector.svelte` `s`). Command availability in
  templates must go through `isEnabled()` (`src/ui/reactive.svelte.ts`).
- **Effects that initialise state** (e.g. when a dialog opens): read only the trigger, then do the writes inside
  `untrack()`. Reading a `$state` right after assigning it in the same effect makes the effect depend on itself →
  `effect_update_depth_exceeded` and a frozen page (see the export effect in `Dialogs.svelte`).
- **Output is download-only.** There is no in-place save (it was removed for UI simplicity): never write through
  File System Access handles; pickers open read-only. One `download` command (Ctrl+S) opens the Download dialog.
- Keep the original file `File`/`Blob` around as the backup source — it lives on disk, not in RAM.

## Layout
- `src/lib/nbt/` format core: `types` (tag model), `mutf8`, `reader` (iterative, explicit stack), `writer`,
  `compression` (native Compression Streams), `lz4` (lz4-java `LZ4Block` format + xxHash32), `nbtfile`
  (format sniffing: gzip/zlib/raw, BE/LE, Bedrock header), `region` (Anvil, lazy chunks, compression ids 1/2/3/4/127, `.mcc`),
  `snbt`, `format` (previews, input validation, paths), `dataversion`.
- `src/lib/doc/` workspace model: source nodes (folder → file → region → chunk), Journal, clipboard, download (`export.ts`).
- `src/lib/search/` query compilation + search (worker for unloaded region chunks).
- `src/lib/fs/` File System Access API with `<input>`/download fallbacks.
- `src/ui/` Svelte components; `src/styles/tokens.css` holds every color/spacing token.
  `commands.ts` is the single registry of user actions (label, icon, shortcut, enabled, run) used by the toolbar,
  context menu, Inspector and shortcut help; add new actions there. `actions.ts` (lib/doc) builds Journal entries.
- `tests/unit` Vitest, `tests/e2e` Playwright (uses installed Edge: `channel: 'msedge'`, override with `PW_CHANNEL`).
  Real Minecraft files for manual testing go in `tests/fixtures/private/` (gitignored).

## Commands
- `npm run dev` · `npm run build` · `npm run preview`
- `npm test` (Vitest) · `npm run e2e` (Playwright, builds first) · `npm run check` (svelte-check / types)
- `npm run bench` prints parse/write/search timings.
- Icons: add the Material Symbol name to `scripts/gen-icon-map.mjs`, then `node scripts/gen-icon-map.mjs`
  (regenerates `src/ui/icons.ts`, only listed icons ship). `node scripts/gen-icons.mjs` regenerates favicon/PWA icons
  from `public/icon.png`.
- Before finishing a change: `npm run check && npm test && npm run e2e`. E2E tests drop synthetic fixtures
  (`tests/e2e/fixtures.ts`) and fail if any request leaves the origin or the page throws an uncaught error. They run
  against the production build; some Svelte errors only throw in dev, so for UI-state changes also run the suite
  against `npm run dev` once.

## Minecraft format notes
- Java NBT is big-endian with **Modified UTF-8** strings; Bedrock is little-endian with UTF-8 and `level.dat` has an
  8-byte header (version i32le, length i32le) that must be preserved.
- Region compression: 1 gzip, 2 zlib, 3 none, 4 LZ4 (lz4-java block stream, checksum = XXH32 seed 0x9747b28c & 0x0FFFFFFF),
  127 custom (read-only). Bit 0x80 → data in `c.<cx>.<cz>.mcc`.
- 1.18+ chunks have no `Level` wrapper; 1.17+ entities live in `entities/`, POI in `poi/`.
- 1.21.5+ heterogeneous lists are stored as lists of `{"": value}` compounds — show unwrapped hints, never rewrite them.
- `TAG_Short_Array` (Substrate-only) is intentionally unsupported.

## Design rules ("Basalt & Magma")
- Dense, tool-like layout (top bar → tabs → tree | inspector, docked bottom panel, status bar). No landing-page hero.
- Use tokens from `tokens.css` only. Magma orange accent, basalt neutrals, per-tag-type colors (`--t-int`, `--t-float`, …).
- 4–6 px radii, 1 px borders, tabular numbers, IBM Plex Sans + JetBrains Mono.
- Avoid: purple/indigo gradients, glassmorphism/blur, glows, emoji, big soft-shadow cards, centered marketing copy.
- Every action has a Material Symbol icon and a tooltip with its shortcut.
- Pixel art only in branding (`public/icon.png`, `public/icon.gif`).

## License
MIT. Keep the credit to the original NBTExplorer (© 2011 Justin Aquadro) in `LICENSE` and the About dialog.
