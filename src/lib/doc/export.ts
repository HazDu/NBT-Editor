/**
 * Building output files and downloading them, optionally with "<name>.backup" of the original.
 *
 * Backup source, in order of preference:
 *  1. the original File the user opened (disk-backed Blob → streamed, byte-identical, no RAM)
 *  2. if that can no longer be read (changed on disk): rebuilt by rewinding the Journal to the
 *     save point and serializing (NBT files only)
 */
import { serializeNbtFile } from '../nbt/nbtfile';
import { buildRegion, encodeChunk, mccName, SECTOR, type RegionEntry } from '../nbt/region';
import { writeNbt } from '../nbt/writer';
import { compress } from '../nbt/compression';
import { downloadBlob } from '../fs/access';
import { sourceFile, type FileNode, type RegionFileNode, type Workspace } from './model';

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
  const raw = ws.journal.atOriginal(() => writeNbt(root, node.format.endian));
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
}

export interface SaveReport {
  name: string;
  backup: 'downloaded' | 'skipped' | 'unavailable';
  extras: number;
}

/** Downloads one file (plus external chunks), optionally preceded by "<name>.backup" of the original. */
export async function saveFile(ws: Workspace, node: FileNode, opts: SaveOptions): Promise<SaveReport> {
  const out = await buildOutput(node);
  const report: SaveReport = { name: node.name, backup: 'skipped', extras: out.extras.length };
  if (opts.backup) {
    const orig = await originalBlob(ws, node);
    if (orig) downloadBlob(orig, `${node.name}.backup`);
    report.backup = orig ? 'downloaded' : 'unavailable';
  }
  downloadBlob(out.main, node.name);
  for (const extra of out.extras) downloadBlob(new Blob([extra.data as BlobPart]), extra.name);
  return report;
}

export async function saveWorkspace(ws: Workspace, files: FileNode[], opts: SaveOptions): Promise<SaveReport[]> {
  const reports: SaveReport[] = [];
  for (const f of files) reports.push(await saveFile(ws, f, opts));
  ws.journal.markSaved();
  return reports;
}
