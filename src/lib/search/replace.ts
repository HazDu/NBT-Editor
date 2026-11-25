/**
 * Find & Replace over search results, committed as ONE journal entry (one undo step).
 */
import { formatPath, parsePrimitive } from '../nbt/format';
import { TagType, type Tag } from '../nbt/types';
import type { Op } from '../doc/journal';
import { loadNode, type Holder, type Workspace } from '../doc/model';
import { resolvePath } from '../doc/rows';
import type { QuickQuery } from './query';
import type { SearchResult } from './runner';

export interface ReplaceReport {
  replaced: number;
  skipped: number;
  errors: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function replaceInResults(ws: Workspace, results: SearchResult[], q: QuickQuery, replacement: string): Promise<ReplaceReport> {
  const ops: Op[] = [];
  const touched: Tag[] = [];
  const targets: Tag[] = [];
  const report: ReplaceReport = { replaced: 0, skipped: 0, errors: [] };
  const pattern = q.mode === 'regex' ? new RegExp(q.value, q.caseSensitive ? 'gu' : 'giu') : new RegExp(escapeRe(q.value), q.caseSensitive ? 'g' : 'gi');

  for (const r of results) {
    const holder: Holder | null = r.chunk ?? (r.file.kind === 'nbt' ? r.file : null);
    if (!holder) { report.skipped++; continue; }
    if (holder.state !== 'ready') await loadNode(holder);
    if (!holder.root) { report.skipped++; continue; }
    const chain = resolvePath(holder.root.tag, r.path);
    if (!chain) { report.skipped++; continue; }
    const tag = chain[chain.length - 1];
    if (tag.type === TagType.Compound || tag.type === TagType.List || tag.type === TagType.ByteArray || tag.type === TagType.IntArray || tag.type === TagType.LongArray) {
      report.skipped++;
      continue;
    }
    let next: Tag['value'];
    if (tag.type === TagType.String) {
      next = q.mode === 'contains' || q.mode === 'regex' ? tag.value.replace(pattern, replacement) : replacement;
    } else {
      const p = parsePrimitive(tag.type, replacement);
      if (!p.ok) {
        report.errors.push(`${formatPath(r.path)}: ${p.error}`);
        continue;
      }
      next = p.value!;
    }
    if (next === tag.value) { report.skipped++; continue; }
    ops.push({ kind: 'set', holder, tag, before: tag.value, after: next });
    touched.push(...chain);
    targets.push(tag);
    report.replaced++;
  }
  if (ops.length) {
    ws.journal.commit({
      label: `Replace ${ops.length} value${ops.length === 1 ? '' : 's'}`,
      icon: 'find_replace',
      ops,
      where: `${new Set(results.map((r) => r.file.name)).size} file(s)`,
      detail: `"${q.value}" → "${replacement}"`,
      touched,
      targets,
    });
  }
  return report;
}
