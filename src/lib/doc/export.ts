/**
 * Building output files and saving/exporting them, optionally with "<name>.backup" of the original.
 *
 * Backup source, in order of preference:
 *  1. the original File the user opened (disk-backed Blob → streamed, byte-identical, no RAM)
 *  2. if that can no longer be read (changed on disk): rebuilt by rewinding the Journal to the
 *     save point and serializing (NBT files only)
 */
import { serializeNbtFile } from '../nbt/nbtfile';
import { buildRegion, encodeChunk, mccName, parseRegionHeader, SECTOR, type RegionEntry } from '../nbt/region';
import { writeNbt } from '../nbt/writer';
import { compress } from '../nbt/compression';
import { canWriteInPlace, downloadBlob, ensureWritePermission, writeToHandle } from '../fs/access';
import { ChunkNode, loadNode, sourceFile, type FileNode, type RegionFileNode, type Workspace } from './model';

export interface BuiltOutput {
  main: Blob;
  /** extra files (external chunks) to write next to the main file */
  extras: { name: string; data: Uint8Array }[];
}

export async function buildOutput(node: FileNode): Promise<BuiltOutput> {
  if (node.kind === 'nbt') {
    if (!node.root) throw new Error(`${node.name} is not loaded`);
    const bytes = await serializeNbtFile(node.root, node.format, node.rawSize || undefined);
    return { main: new Blob([bytes as BlobPart]), extras: [] };
  }
  return buildRegionOutput(node);
}

async function buildRegionOutput(node: RegionFileNode): Promise<BuiltOutput> {
  const file = await sourceFile(node);
  const entries: RegionEntry[] = [];
  const extras: BuiltOutput['extras'] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const chunk of node.chunks ?? []) {
    if (chunk.deleted) continue;
    const { slot } = chunk;
    if (chunk.modified && chunk.root) {
      const enc = await encodeChunk(chunk.root, chunk.compressionId);
      if (enc.external) {
        if (!node.coords) throw new Error(`Chunk ${slot.x},${slot.z} is too large and the region coordinates are unknown`);
        extras.push({ name: mccName(node.coords.rx, node.coords.rz, slot.x, slot.z), data: enc.external });
      }
      entries.push({ index: slot.index, timestamp: now, data: enc.record, size: enc.record.length });
    } else {
      // Unchanged: copy the original sectors as a lazy Blob slice (no decode, no copy in JS).
      const start = slot.sectorOffset * SECTOR;
      const end = Math.min(start + slot.sectorCount * SECTOR, file.size);
      entries.push({ index: slot.index, timestamp: slot.timestamp, data: file.slice(start, end), size: end - start });
    }
  }
  return { main: buildRegion(entries), extras };
}

/** Rebuilds the on-disk state of an NBT file from the journal (fallback when the original is unreadable). */
async function reconstructOriginal(ws: Workspace, node: FileNode): Promise<Blob | null> {
  if (node.kind !== 'nbt' || !node.root) return null;
  const root = node.root;
  const raw = ws.journal.atSavePoint(() => writeNbt(root, node.format.endian));
  if (!raw) return null;
  if (node.format.bedrockHeader) {
    const out = new Uint8Array(raw.length + 8);
    const dv = new DataView(out.buffer);
    dv.setInt32(0, node.format.bedrockHeader.version, true);
    dv.setInt32(4, raw.length, true);
    out.set(raw, 8);
    return new Blob([out]);
  }
  return new Blob([(await compress(raw, node.format.compression)) as BlobPart]);
}

async function originalBlob(ws: Workspace, node: FileNode): Promise<Blob | null> {
  try {
    const f = node.source.file ?? (node.source.handle ? await node.source.handle.getFile() : null);
    if (f) {
      // Touch the file to detect "changed on disk" (NotReadableError) before relying on it.
      await f.slice(0, 1).arrayBuffer();
      return f;
    }
  } catch {
    /* fall through to journal reconstruction */
  }
  return reconstructOriginal(ws, node);
}

export interface SaveOptions {
  backup: boolean;
  /** force download even when in-place saving is possible */
  download?: boolean;
}

export interface SaveReport {
  name: string;
  mode: 'in-place' | 'download';
  backup: 'written' | 'downloaded' | 'skipped' | 'unavailable';
  extras: number;
}

export function canSaveInPlace(node: FileNode): boolean {
  return canWriteInPlace(node.source.handle);
}

/**
 * Saves one file. In place (File System Access API) when possible, otherwise as download.
 * The backup is always written before the original is overwritten.
 */
export async function saveFile(ws: Workspace, node: FileNode, opts: SaveOptions): Promise<SaveReport> {
  const inPlace = !opts.download && canSaveInPlace(node);
  // Permission prompts need the user gesture, so ask before any slow work.
  if (inPlace && !(await ensureWritePermission(node.source.handle!))) {
    throw new Error(`Write permission for ${node.name} was denied`);
  }
  if (inPlace && node.kind === 'region') {
    // Deleted chunks must stay restorable by undo after the old file is replaced: load them now.
    for (const c of node.chunks ?? []) if (c.deleted && !c.root) await loadNode(c);
  }
  const out = await buildOutput(node);
  const report: SaveReport = { name: node.name, mode: inPlace ? 'in-place' : 'download', backup: 'skipped', extras: out.extras.length };
  const backupName = `${node.name}.backup`;
  const dirHandle = node.source.dir?.handle;

  if (opts.backup) {
    const orig = await originalBlob(ws, node);
    if (!orig) report.backup = 'unavailable';
    else if (inPlace && dirHandle && (await ensureWritePermission(dirHandle))) {
      const fh = await dirHandle.getFileHandle(backupName, { create: true });
      await writeToHandle(fh, orig);
      report.backup = 'written';
    } else if (inPlace) {
      // About to overwrite the source: snapshot it first, the download may start after the write.
      downloadBlob(new Blob([await orig.arrayBuffer()]), backupName);
      report.backup = 'downloaded';
    } else {
      downloadBlob(orig, backupName);
      report.backup = 'downloaded';
    }
  }

  if (inPlace) {
    // For regions `out.main` references slices of the original file; createWritable writes to a
    // swap file and only replaces the original on close(), so those reads stay valid.
    await writeToHandle(node.source.handle!, out.main);
    for (const extra of out.extras) {
      if (dirHandle) {
        const fh = await dirHandle.getFileHandle(extra.name, { create: true });
        await writeToHandle(fh, new Blob([extra.data as BlobPart]));
      } else downloadBlob(new Blob([extra.data as BlobPart]), extra.name);
    }
    await rebase(node);
  } else {
    downloadBlob(out.main, node.name);
    for (const extra of out.extras) downloadBlob(new Blob([extra.data as BlobPart]), extra.name);
  }
  return report;
}

/** After an in-place save the file on disk is the new baseline. */
async function rebase(node: FileNode): Promise<void> {
  const file = await node.source.handle!.getFile();
  node.source.file = file;
  if (node.kind === 'region' && node.chunks) {
    const header = new Uint8Array(await file.slice(0, 2 * SECTOR).arrayBuffer());
    const slots = new Map(parseRegionHeader(header, file.size).map((s) => [s.index, s]));
    const kept: ChunkNode[] = [];
    for (const c of node.chunks) {
      const s = slots.get(c.slot.index);
      if (c.deleted) {
        // Not in the new file any more; if undo restores it, it is re-encoded from memory.
        if (c.root) { c.modified = true; kept.push(c); }
        continue;
      }
      if (!s) continue;
      c.slot = s;
      c.modified = false;
      kept.push(c);
    }
    node.chunks = kept;
  }
}

export async function saveWorkspace(ws: Workspace, files: FileNode[], opts: SaveOptions): Promise<SaveReport[]> {
  const reports: SaveReport[] = [];
  for (const f of files) reports.push(await saveFile(ws, f, opts));
  ws.journal.markSaved(reports.length > 0 && reports.every((r) => r.mode === 'in-place'));
  return reports;
}
