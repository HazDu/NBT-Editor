/**
 * File access with progressive enhancement:
 *  - Chromium: File System Access API pickers (read-only; handles let files be re-read from disk)
 *  - Others: <input type=file> / <input webkitdirectory>.
 * Output is always a browser download; files on disk are never written.
 */

export interface PickedFile {
  file: File;
  handle?: FileSystemFileHandle;
}

/** Minimal directory abstraction over a FileSystemDirectoryHandle or a webkitdirectory file list. */
export interface DirLike {
  name: string;
  handle?: FileSystemDirectoryHandle;
  list(): Promise<EntryLike[]>;
}

export type EntryLike =
  | { kind: 'file'; name: string; getFile(): Promise<File>; handle?: FileSystemFileHandle }
  | { kind: 'directory'; name: string; dir: DirLike };

type FsWindow = Window & {
  showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?: (opts?: unknown) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle>;
};
const w = (typeof window !== 'undefined' ? window : undefined) as FsWindow | undefined;

export const supportsFsAccess = !!w?.showOpenFilePicker;
export const supportsDirectoryPicker = !!w?.showDirectoryPicker;

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'AbortError' || e.name === 'SecurityError');
}

/** Default picker filter; the OS dialog keeps an "All files" choice for custom extensions. */
export interface FileFilter {
  description: string;
  extensions: readonly string[];
}

function pickViaInput(opts: { multiple?: boolean; directory?: boolean; filter?: FileFilter }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!opts.multiple;
    if (opts.filter) input.accept = opts.filter.extensions.join(',');
    if (opts.directory) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export async function pickFiles(filter?: FileFilter): Promise<PickedFile[]> {
  if (w?.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({
        multiple: true,
        id: 'nbt-open',
        excludeAcceptAllOption: false,
        ...(filter && {
          // Chromium rejects the whole call for extensions outside [A-Za-z0-9.+] or longer than 16 chars
          // (e.g. ".dat_old"); those files stay reachable through the "All files" choice.
          types: [{
            description: filter.description,
            accept: { 'application/octet-stream': filter.extensions.filter((e) => /^\.[a-z0-9.+]{1,15}$/i.test(e)) },
          }],
        }),
      });
      return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    } catch (e) {
      if (isAbort(e)) return [];
      throw e;
    }
  }
  return (await pickViaInput({ multiple: true, filter })).map((file) => ({ file }));
}

export async function pickDirectory(): Promise<DirLike | null> {
  if (w?.showDirectoryPicker) {
    try {
      const handle = await w.showDirectoryPicker({ mode: 'read', id: 'nbt-world' });
      return dirFromHandle(handle);
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  const files = await pickViaInput({ directory: true });
  return files.length ? dirFromFileList(files) : null;
}

export function dirFromHandle(handle: FileSystemDirectoryHandle): DirLike {
  return {
    name: handle.name,
    handle,
    async list() {
      const out: EntryLike[] = [];
      for await (const entry of (handle as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (entry.kind === 'file') {
          const fh = entry as FileSystemFileHandle;
          out.push({ kind: 'file', name: fh.name, handle: fh, getFile: () => fh.getFile() });
        } else {
          out.push({ kind: 'directory', name: entry.name, dir: dirFromHandle(entry as FileSystemDirectoryHandle) });
        }
      }
      return out;
    },
  };
}

/** Builds a virtual directory tree from <input webkitdirectory> results (read-only, saves become downloads). */
export function dirFromFileList(files: File[]): DirLike {
  interface VDir { name: string; dirs: Map<string, VDir>; files: File[] }
  const root: VDir = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split('/');
    let d = root;
    if (!root.name && parts.length > 1) root.name = parts[0];
    for (const p of parts.slice(1, -1)) {
      let next = d.dirs.get(p);
      if (!next) { next = { name: p, dirs: new Map(), files: [] }; d.dirs.set(p, next); }
      d = next;
    }
    d.files.push(f);
  }
  const wrap = (v: VDir): DirLike => ({
    name: v.name,
    async list() {
      return [
        ...[...v.dirs.values()].map((sd): EntryLike => ({ kind: 'directory', name: sd.name, dir: wrap(sd) })),
        ...v.files.map((f): EntryLike => ({ kind: 'file', name: f.name, getFile: async () => f })),
      ];
    },
  });
  return wrap(root);
}

/** Drag & drop: prefers FS handles (Chromium), falls back to plain Files / webkit entries. */
export async function itemsFromDrop(dt: DataTransfer): Promise<{ files: PickedFile[]; dirs: DirLike[] }> {
  const files: PickedFile[] = [];
  const dirs: DirLike[] = [];
  const items = Array.from(dt.items).filter((i) => i.kind === 'file');
  // DataTransfer items are only valid during the event: grab everything synchronously first.
  const plain = items.map((i) => i.getAsFile());
  const entries = items.map((i) => i.webkitGetAsEntry?.() ?? null);
  const handlePromises = items.map((i) =>
    'getAsFileSystemHandle' in i
      ? (i as DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle().catch(() => null)
      : Promise.resolve(null),
  );
  const handles = await Promise.all(handlePromises);
  for (let k = 0; k < items.length; k++) {
    const h = handles[k];
    if (h?.kind === 'file') {
      files.push({ file: await (h as FileSystemFileHandle).getFile(), handle: h as FileSystemFileHandle });
    } else if (h?.kind === 'directory') {
      dirs.push(dirFromHandle(h as FileSystemDirectoryHandle));
    } else if (entries[k]?.isDirectory) {
      dirs.push(dirFromEntry(entries[k] as FileSystemDirectoryEntry));
    } else if (plain[k]) {
      files.push({ file: plain[k]! });
    }
  }
  return { files, dirs };
}

function dirFromEntry(entry: FileSystemDirectoryEntry): DirLike {
  return {
    name: entry.name,
    list: () =>
      new Promise((resolve, reject) => {
        const reader = entry.createReader();
        const all: FileSystemEntry[] = [];
        const read = () =>
          reader.readEntries((batch) => {
            if (batch.length === 0) {
              resolve(
                all.map((e): EntryLike =>
                  e.isDirectory
                    ? { kind: 'directory', name: e.name, dir: dirFromEntry(e as FileSystemDirectoryEntry) }
                    : { kind: 'file', name: e.name, getFile: () => new Promise((res, rej) => (e as FileSystemFileEntry).file(res, rej)) },
                ),
              );
            } else {
              all.push(...batch);
              read();
            }
          }, reject);
        read();
      }),
  };
}

/** Triggers a browser download. Blob URLs of a File stream from disk, so this costs no RAM. */
export function downloadBlob(data: Blob, name: string): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
