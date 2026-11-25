/**
 * Workspace model. A workspace (= one editor tab) owns a tree of source nodes:
 *   folder → nbt file | region file → chunk
 * NBT files and chunks are "holders": they own a root tag. Data is loaded lazily on expand.
 * The original File/Blob of every file is kept as the backup source (it is disk-backed, not RAM).
 */
import { parseNbtFile, type NbtFormat } from '../nbt/nbtfile';
import {
  decodeChunk, mccName, parseChunkRecord, parseRegionHeader, parseRegionName, REGION_NAME, SECTOR, type ChunkSlot,
} from '../nbt/region';
import { TagType, type NbtRoot } from '../nbt/types';
import type { DirLike } from '../fs/access';
import { Journal } from './journal';

let nextId = 1;

export interface FileSource {
  /** baseline content: the original file as opened (or as last saved in place) */
  file: Blob | null;
  handle?: FileSystemFileHandle;
  /** parent directory (folder workspaces with write access) — used for .backup and .mcc siblings */
  dir?: DirLike;
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

abstract class BaseNode {
  readonly id = nextId++;
  parent: SourceNode | null = null;
  state: LoadState = 'idle';
  error: string | null = null;
  constructor(public name: string) {}
}

export class FolderNode extends BaseNode {
  readonly kind = 'folder' as const;
  children: SourceNode[] | null = null;
  constructor(public dir: DirLike, name = dir.name) {
    super(name);
  }
}

export class NbtFileNode extends BaseNode {
  readonly kind = 'nbt' as const;
  root: NbtRoot | null = null;
  format: NbtFormat = { compression: 'gzip', endian: 'big', bedrockHeader: null };
  rawSize = 0;
  constructor(name: string, public source: FileSource) {
    super(name);
  }
}

export class RegionFileNode extends BaseNode {
  readonly kind = 'region' as const;
  chunks: ChunkNode[] | null = null;
  coords: { rx: number; rz: number } | null;
  constructor(name: string, public source: FileSource) {
    super(name);
    const c = parseRegionName(name);
    this.coords = c ? { rx: c.rx, rz: c.rz } : null;
  }
  /** "region" | "entities" | "poi" — from the parent folder name (1.17+ split). */
  get category(): string {
    const p = this.parent?.name.toLowerCase();
    return p === 'entities' || p === 'poi' ? p : 'region';
  }
}

export class ChunkNode extends BaseNode {
  readonly kind = 'chunk' as const;
  root: NbtRoot | null = null;
  compressionId = 2;
  external = false;
  /** true once edited since the baseline file; such chunks are re-encoded on save */
  modified = false;
  deleted = false;
  constructor(public region: RegionFileNode, public slot: ChunkSlot) {
    super(`Chunk [${slot.x}, ${slot.z}]`);
    this.parent = region;
  }
  get worldX(): number | null {
    return this.region.coords ? this.region.coords.rx * 32 + this.slot.x : null;
  }
  get worldZ(): number | null {
    return this.region.coords ? this.region.coords.rz * 32 + this.slot.z : null;
  }
}

export type SourceNode = FolderNode | NbtFileNode | RegionFileNode | ChunkNode;
export type Holder = NbtFileNode | ChunkNode;
export type FileNode = NbtFileNode | RegionFileNode;

export function isHolder(n: SourceNode): n is Holder {
  return n.kind === 'nbt' || n.kind === 'chunk';
}

export function fileOf(n: SourceNode): FileNode | null {
  if (n.kind === 'chunk') return n.region;
  if (n.kind === 'nbt' || n.kind === 'region') return n;
  return null;
}

// ---------------------------------------------------------------------------------------- loading

const NBT_FILE = /\.(dat|dat_old|dat_mcr|nbt|schematic|schem|litematic|mcstructure|bpt|rc)$/i;

export function isSupportedName(name: string): boolean {
  return NBT_FILE.test(name) || REGION_NAME.test(name);
}

export function nodeForFile(name: string, source: FileSource): NbtFileNode | RegionFileNode {
  return REGION_NAME.test(name) || /\.(mca|mcr)$/i.test(name) ? new RegionFileNode(name, source) : new NbtFileNode(name, source);
}

const loading = new WeakMap<SourceNode, Promise<void>>();

/** Loads a node's direct content (folder listing, parsed NBT, region header, chunk data). Idempotent. */
export function loadNode(node: SourceNode): Promise<void> {
  if (node.state === 'ready') return Promise.resolve();
  const pending = loading.get(node);
  if (pending) return pending;
  node.state = 'loading';
  node.error = null;
  const p = doLoad(node)
    .then(() => { node.state = 'ready'; })
    .catch((e: unknown) => {
      node.state = 'error';
      node.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => loading.delete(node));
  loading.set(node, p);
  return p;
}

async function doLoad(node: SourceNode): Promise<void> {
  switch (node.kind) {
    case 'folder': {
      const entries = await node.dir.list();
      const dirs: SourceNode[] = [];
      const files: SourceNode[] = [];
      for (const e of entries) {
        if (e.kind === 'directory') {
          const f = new FolderNode(e.dir);
          f.parent = node;
          dirs.push(f);
        } else if (isSupportedName(e.name)) {
          const src: FileSource = { file: null, handle: e.handle, dir: node.dir };
          const f = nodeForFile(e.name, src);
          f.parent = node;
          // Resolve the File lazily; keep the getter for later.
          fileGetters.set(f, e.getFile);
          files.push(f);
        }
      }
      const cmp = (a: SourceNode, b: SourceNode) => a.name.localeCompare(b.name, undefined, { numeric: true });
      node.children = [...dirs.sort(cmp), ...files.sort(cmp)];
      return;
    }
    case 'nbt': {
      const file = await sourceFile(node);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseNbtFile(bytes, node.name);
      node.root = parsed.root;
      node.format = parsed.format;
      node.rawSize = parsed.rawSize;
      return;
    }
    case 'region': {
      const file = await sourceFile(node);
      if (file.size === 0) { node.chunks = []; return; }
      if (file.size < 2 * SECTOR) throw new Error('Not a valid region file (smaller than the 8 KiB header)');
      const header = new Uint8Array(await file.slice(0, 2 * SECTOR).arrayBuffer());
      const slots = parseRegionHeader(header, file.size);
      node.chunks = slots.map((s) => new ChunkNode(node, s));
      return;
    }
    case 'chunk': {
      const file = await sourceFile(node.region);
      const { slot } = node;
      const bytes = new Uint8Array(
        await file.slice(slot.sectorOffset * SECTOR, (slot.sectorOffset + slot.sectorCount) * SECTOR).arrayBuffer(),
      );
      const rec = parseChunkRecord(bytes);
      node.compressionId = rec.compressionId;
      node.external = rec.external;
      let payload = rec.payload;
      if (rec.external) {
        const ext = await findExternalChunk(node);
        if (!ext) {
          throw new Error(
            'This chunk is stored in an external .mcc file. Open the whole world folder so the file can be found.',
          );
        }
        payload = new Uint8Array(await ext.arrayBuffer());
      }
      node.root = await decodeChunk(rec.compressionId, payload);
      return;
    }
  }
}

const fileGetters = new WeakMap<SourceNode, () => Promise<File>>();

export async function sourceFile(node: FileNode): Promise<Blob> {
  if (node.source.file) return node.source.file;
  const getter = fileGetters.get(node);
  if (node.source.handle) node.source.file = await node.source.handle.getFile();
  else if (getter) node.source.file = await getter();
  if (!node.source.file) throw new Error('The original file is not available');
  return node.source.file;
}

async function findExternalChunk(chunk: ChunkNode): Promise<Blob | null> {
  const { region } = chunk;
  if (!region.coords || !region.source.dir) return null;
  const want = mccName(region.coords.rx, region.coords.rz, chunk.slot.x, chunk.slot.z);
  const entries = await region.source.dir.list();
  const e = entries.find((x) => x.kind === 'file' && x.name === want);
  return e && e.kind === 'file' ? e.getFile() : null;
}

// --------------------------------------------------------------------------------------- workspace

export class Workspace {
  readonly id = nextId++;
  readonly journal = new Journal();
  /** bumped on every data or load change; the UI derives rows from it */
  version = 0;
  private listeners = new Set<() => void>();

  constructor(public root: SourceNode) {
    this.journal.onChange = () => this.bump();
  }

  get title(): string {
    return this.root.name;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  async load(node: SourceNode): Promise<void> {
    const p = loadNode(node);
    this.bump();
    await p;
    this.bump();
  }

  /** Files with unsaved changes (journal entries between the save point and now). */
  dirtyFiles(): FileNode[] {
    const set = new Set<FileNode>();
    for (const h of this.journal.unsavedHolders()) {
      const f = fileOf(h);
      if (f) set.add(f);
    }
    return [...set];
  }

  get isDirty(): boolean {
    return this.journal.hasUnsaved;
  }
}

export function newEmptyFile(name = 'untitled.dat'): NbtFileNode {
  const node = new NbtFileNode(name, { file: null });
  node.root = { name: '', tag: { type: TagType.Compound, value: new Map() } };
  node.state = 'ready';
  return node;
}

/** Root tag name editing helper for display */
export function holderLabel(h: Holder): string {
  if (h.kind === 'chunk') {
    const w = h.worldX !== null ? ` @ ${h.worldX}, ${h.worldZ}` : '';
    return `${h.region.name} › Chunk [${h.slot.x}, ${h.slot.z}]${w}`;
  }
  return h.name;
}
