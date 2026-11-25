/// <reference lib="webworker" />
/**
 * Searches files/chunks that are not loaded in the editor, so a whole region (1024 chunks) or a
 * world folder can be searched without freezing the UI or keeping every chunk in memory.
 * Only paths of hits are sent back; the UI loads a chunk when a result is opened.
 */
import { parseNbtFile } from '../nbt/nbtfile';
import { decodeChunk, parseChunkRecord, SECTOR } from '../nbt/region';
import { previewValue } from '../nbt/format';
import { compileQuery, searchTree, type Query } from './query';
import type { WorkerRequest, WorkerResponse } from './protocol';

let current = 0;
const MAX_HITS_PER_TARGET = 2000;

const post = (m: WorkerResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    if (msg.jobId === current) current = 0;
    return;
  }
  const jobId = msg.jobId;
  current = jobId;
  const match = compileQuery(msg.query as Query);
  const total = msg.targets.reduce((n, t) => n + (t.chunks ? t.chunks.length : 1), 0);
  let done = 0;
  let lastProgress = 0;

  for (const target of msg.targets) {
    if (current !== jobId) return;
    try {
      if (target.chunks) {
        for (const c of target.chunks) {
          if (current !== jobId) return;
          try {
            const bytes = new Uint8Array(await target.file.slice(c.sectorOffset * SECTOR, (c.sectorOffset + c.sectorCount) * SECTOR).arrayBuffer());
            const rec = parseChunkRecord(bytes);
            if (!rec.external) {
              const root = await decodeChunk(rec.compressionId, rec.payload);
              let hits = 0;
              for (const h of searchTree(root.tag, match)) {
                if (!h) continue;
                post({ type: 'hit', jobId, targetId: target.id, chunkIndex: c.index, path: h.path, tagType: h.tag.type, preview: previewValue(h.tag, 80) });
                if (++hits >= MAX_HITS_PER_TARGET) break;
              }
            }
          } catch {
            /* unreadable chunk: skip */
          }
          done++;
          if (performance.now() - lastProgress > 100) {
            lastProgress = performance.now();
            post({ type: 'progress', jobId, done, total });
          }
        }
      } else {
        const parsed = await parseNbtFile(new Uint8Array(await target.file.arrayBuffer()), target.name);
        let hits = 0;
        for (const h of searchTree(parsed.root.tag, match)) {
          if (!h) continue;
          post({ type: 'hit', jobId, targetId: target.id, chunkIndex: null, path: h.path, tagType: h.tag.type, preview: previewValue(h.tag, 80) });
          if (++hits >= MAX_HITS_PER_TARGET) break;
        }
        done++;
      }
    } catch (e) {
      post({ type: 'error', jobId, targetId: target.id, message: (e as Error).message });
      done += target.chunks ? 0 : 1;
    }
    post({ type: 'progress', jobId, done, total });
  }
  if (current === jobId) post({ type: 'done', jobId });
};
