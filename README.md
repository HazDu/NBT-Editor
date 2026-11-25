# NBT-Editor

A modern, browser-based editor for Minecraft NBT data. It is a rewrite of the desktop app
[NBTExplorer](NBTExplorer-master/) as a static website.

**Your files never leave your device.** After the page has loaded, every file is parsed, edited and saved inside the
browser tab. The production build sets a Content-Security-Policy with `connect-src 'self'`, so the page cannot send
data anywhere. The app works offline and can be installed as a PWA.

## Features

- **Opens:**
  - `level.dat`, player data, `.dat_old`
  - region files (`.mca`/`.mcr`, including `entities/` and `poi/`)
  - structures and schematics: `.nbt`, `.schem`, `.schematic`, `.litematic`
  - Bedrock `level.dat` and `.mcstructure`
- **Whole world folders:** opened with a lazy file tree.
- **Tabs:** one per file or folder. Copy and paste works between tabs, and copied tags are also put on the system
  clipboard as SNBT.
- **Editing:**
  - inline editing with validation for each type
  - a hex/decimal grid for byte, int and long arrays
  - rename, add, duplicate, delete, reorder list entries, and edit any tag as SNBT
- **Search:**
  - by key and/or value, with "contains", exact or regex matching
  - array values like `[I;1,2,3,4]`; a 4-int UUID also finds the same UUID written as a string or as an
    old `…UUIDMost`/`…UUIDLeast` pair
  - **Find this value everywhere** (Ctrl+Shift+F or right-click) searches for the selected tag's value
  - **rule search** (e.g. `id = minecraft:zombie` AND `Health < 5`)
  - **find & replace**
  - **go to chunk** by block or chunk coordinates
  - unloaded region chunks are searched in a Web Worker
- **Git-like change log:** undo/redo, and a Changes panel with "jump to" and "revert this change". Tree rows show
  markers for changed tags.
- **Save & export:**
  - Chrome/Edge save in place through the File System Access API; other browsers download the files.
  - Optional **`<filename>.backup`** of the untouched original. The backup is streamed byte for byte from the
    original file on disk, so it uses no extra RAM. If that file can no longer be read, the backup is rebuilt by
    rewinding the change log.

## Updated for current Minecraft (vs. NBTExplorer, last updated 2017)

| Area | Change |
| --- | --- |
| Strings | Proper Java **Modified UTF-8** (NUL and emoji/supplementary characters round-trip correctly) |
| Region compression | gzip, zlib, **uncompressed (1.15.1+)**, **LZ4 (1.20.5+, lz4-java block format + xxHash32)**, custom (id 127, read-only) |
| Oversized chunks | External `c.x.z.mcc` files (flag 0x80) are read and written in folder mode |
| Chunk format | 1.18+ layout (no `Level` wrapper), 1.17+ `entities/` and `poi/` regions labelled |
| Versions | `DataVersion` → Minecraft release shown on files and chunks |
| Lists | 1.21.5+ heterogeneous lists (`{"": value}` wrappers) shown with hints and preserved |
| Items | 1.20.5+ item components (`id` + `count`) shown as hints next to item compounds |
| Bedrock | Little-endian NBT and the `level.dat` 8-byte header |
| SNBT | Parser accepts the 1.21.5 syntax (`true`/`false`, hex/binary, `_`, signed/unsigned suffixes) |
| Removed | Substrate's non-standard `TAG_Short_Array` |

## Performance

- **Format detection:** by magic bytes, instead of trying gzip and falling back when it throws.
- **Decompression:** gzip/zlib use the browser's native, streaming `DecompressionStream`.
- **Reading:**
  - an iterative parser, so deep nesting cannot overflow the stack
  - bulk copies for typed arrays
  - interning of repeated short keys
- **Region files:** opening one reads only the 8 KiB header, and chunks are decoded when they are expanded. Saving
  copies untouched chunks straight from the original file without decoding or recompressing them.
- **Tree:** virtualized, so rows outside the viewport cost nothing.
- **Search:** in-memory search runs in time slices; unloaded data is searched in a worker.

`npm run bench` prints timings. On a dev laptop:

| Benchmark | Time |
| --- | --- |
| 4.6 MB / 360k-tag file parse | ~100–150 ms |
| 4.6 MB / 360k-tag file write | ~100 ms |
| Opening a 4 MB region (1024 chunks) | ~1 ms |

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run e2e        # end-to-end tests (Playwright, uses the installed Microsoft Edge; PW_CHANNEL=chrome to switch)
npm run check      # type checking
npm run build      # static site in dist/
```

## Hosting

`npm run build` produces a fully static `dist/` folder. Copy it to any static host: GitHub Pages, Netlify,
Cloudflare Pages, nginx, an S3 bucket, and so on. Asset paths are relative, so serving it from a sub-path works.

Serve it over **HTTPS**. Browsers only enable the service worker, the File System Access API and clipboard access in
secure contexts (`localhost` counts as secure).

## Credits

Inspired by NBTExplorer by Justin Aquadro (MIT). Icons: Material Symbols (Apache 2.0). Fonts: IBM Plex Sans and
JetBrains Mono (OFL). Not affiliated with Mojang Studios or Microsoft.
