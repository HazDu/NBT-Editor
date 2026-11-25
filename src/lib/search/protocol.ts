import type { TagType } from '../nbt/types';
import type { Query } from './query';

export interface WorkerTarget {
  id: number;
  name: string;
  file: Blob;
  /** region files: the chunks to scan */
  chunks?: { index: number; sectorOffset: number; sectorCount: number }[];
}

export type WorkerRequest =
  | { type: 'search'; jobId: number; query: Query; targets: WorkerTarget[] }
  | { type: 'cancel'; jobId: number };

export type WorkerResponse =
  | { type: 'hit'; jobId: number; targetId: number; chunkIndex: number | null; path: (string | number)[]; tagType: TagType; preview: string }
  | { type: 'progress'; jobId: number; done: number; total: number }
  | { type: 'error'; jobId: number; targetId: number; message: string }
  | { type: 'done'; jobId: number };
