/**
 * Orchestrates a search over a workspace:
 *  - loaded holders (and any with edits) are searched on the main thread in ~8 ms slices
 *  - unloaded NBT files and region chunks are searched by a Web Worker straight from the File
 * Results arrive incrementally; the run can be cancelled at any time.
 */
import { previewValue } from '../nbt/format';
import { loadNode, sourceFile, type ChunkNode, type FileNode, type Holder, type SourceNode } from '../doc/model';
import { compileQuery, searchTree, type Query } from './query';
import type { WorkerResponse, WorkerTarget } from './protocol';
import type { Tag, TagType } from '../nbt/types';

export interface SearchResult {
  id: number;
  /** file the hit is in */
  file: FileNode;
  /** chunk for region hits */
  chunk: ChunkNode | null;
  /** in-memory hit (tag object known) */
  tag: Tag | null;
  path: (string | number)[];
  tagType: TagType;
  preview: string;
}

export interface SearchCallbacks {
  onResult(r: SearchResult): void;
  onProgress(done: number, total: number): void;
  onDone(summary: { cancelled: boolean; errors: string[] }): void;
}

export const MAX_RESULTS = 5000;

let worker: Worker | null = null;
function getWorker(): Worker {
  worker ??= new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

let jobCounter = 1;
let resultId = 1;

export interface SearchRun {
  cancel(): void;
}

export function runSearch(query: Query, scope: SourceNode, cb: SearchCallbacks): SearchRun {
  const jobId = jobCounter++;
  let cancelled = false;
  let count = 0;
  const errors: string[] = [];
  const match = compileQuery(query);

  const emit = (r: Omit<SearchResult, 'id'>): boolean => {
    if (count >= MAX_RESULTS) return false;
    count++;
    cb.onResult({ ...r, id: resultId++ });
    return count < MAX_RESULTS;
  };

  const cancelWorker = () => worker?.postMessage({ type: 'cancel', jobId });

  const run = async () => {
    // 1. Collect holders in memory and targets for the worker.
    const memory: Holder[] = [];
    const targets: WorkerTarget[] = [];
    const targetFiles = new Map<number, { file: FileNode; chunks: Map<number, ChunkNode> }>();
    let tid = 1;

    const visit = async (n: SourceNode): Promise<void> => {
      if (cancelled) return;
      switch (n.kind) {
        case 'folder':
          await loadNode(n);
          for (const c of n.children ?? []) await visit(c);
          return;
        case 'nbt':
          if (n.state === 'ready' && n.root) memory.push(n);
          else if (n.state !== 'error') {
            const file = await sourceFile(n).catch(() => null);
            if (file) {
              const id = tid++;
              targets.push({ id, name: n.name, file });
              targetFiles.set(id, { file: n, chunks: new Map() });
            }
          }
          return;
        case 'region': {
          await loadNode(n);
          if (n.state !== 'ready') return;
          const pending: ChunkNode[] = [];
          for (const c of n.chunks ?? []) {
            if (c.deleted) continue;
            if (c.state === 'ready' && c.root) memory.push(c);
            else pending.push(c);
          }
          if (pending.length) {
            const file = await sourceFile(n);
            const id = tid++;
            targets.push({ id, name: n.name, file, chunks: pending.map((c) => ({ index: c.slot.index, sectorOffset: c.slot.sectorOffset, sectorCount: c.slot.sectorCount })) });
            targetFiles.set(id, { file: n, chunks: new Map(pending.map((c) => [c.slot.index, c])) });
          }
          return;
        }
        case 'chunk':
          if (n.state !== 'ready') await loadNode(n);
          if (n.root && !n.deleted) memory.push(n);
          return;
      }
    };
    await visit(scope);
    if (cancelled) return;

    const total = memory.length + targets.reduce((s, t) => s + (t.chunks?.length ?? 1), 0);
    let done = 0;
    cb.onProgress(0, total);

    // 2. In-memory search, time-sliced.
    for (const h of memory) {
      if (cancelled) return;
      const file = h.kind === 'chunk' ? h.region : h;
      let slice = performance.now();
      for (const hit of searchTree(h.root!.tag, match)) {
        if (cancelled) return;
        if (hit === null) {
          if (performance.now() - slice > 8) {
            await new Promise((r) => setTimeout(r, 0));
            slice = performance.now();
          }
          continue;
        }
        if (!emit({ file, chunk: h.kind === 'chunk' ? h : null, tag: hit.tag, path: hit.path, tagType: hit.tag.type, preview: previewValue(hit.tag, 80) })) {
          cb.onDone({ cancelled: false, errors: [`Stopped after ${MAX_RESULTS.toLocaleString()} results`] });
          return;
        }
      }
      done++;
      cb.onProgress(done, total);
    }

    // 3. Worker search for everything not in memory.
    if (targets.length === 0) {
      cb.onDone({ cancelled: false, errors });
      return;
    }
    const w = getWorker();
    const base = done;
    await new Promise<void>((resolve) => {
      const onMsg = (ev: MessageEvent<WorkerResponse>) => {
        const m = ev.data;
        if (m.jobId !== jobId) return;
        if (cancelled) { w.removeEventListener('message', onMsg); resolve(); return; }
        if (m.type === 'hit') {
          const t = targetFiles.get(m.targetId)!;
          const chunk = m.chunkIndex !== null ? (t.chunks.get(m.chunkIndex) ?? null) : null;
          if (!emit({ file: t.file, chunk, tag: null, path: m.path, tagType: m.tagType, preview: m.preview })) {
            cancelWorker();
            errors.push(`Stopped after ${MAX_RESULTS.toLocaleString()} results`);
            w.removeEventListener('message', onMsg);
            resolve();
          }
        } else if (m.type === 'progress') cb.onProgress(base + m.done, total);
        else if (m.type === 'error') errors.push(`${targetFiles.get(m.targetId)?.file.name}: ${m.message}`);
        else if (m.type === 'done') { w.removeEventListener('message', onMsg); resolve(); }
      };
      w.addEventListener('message', onMsg);
      w.postMessage({ type: 'search', jobId, query, targets });
    });
    if (!cancelled) cb.onDone({ cancelled: false, errors });
  };

  run().catch((e: unknown) => {
    if (!cancelled) cb.onDone({ cancelled: false, errors: [(e as Error).message] });
  });

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      cancelWorker();
      cb.onDone({ cancelled: true, errors });
    },
  };
}
