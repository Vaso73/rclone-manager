import { Entry } from '@app/types';
import { restoredHistoryName, safeHistoryName } from './simple-profile.util';

export interface HistoryVersion {
  path: string;
  originalPath: string;
  name: string;
  archived: string;
  entry: Entry;
}
export function validArchiveStamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, millisecond] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === millisecond
  );
}

export function historyVersion(entry: Entry, parent: string): HistoryVersion | null {
  if (
    typeof entry?.Name !== 'string' ||
    entry.IsDir ||
    !safeHistoryName(entry.Name) ||
    !Number.isFinite(entry.Size) ||
    entry.Size < 0
  )
    return null;
  const path = parent ? parent + '/' + entry.Name : entry.Name;
  if (path.split('/').some(part => !safeHistoryName(part))) return null;
  const legacyMatch = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3})_[a-f0-9]{32}\//.exec(path);
  const suffixMatch = /_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3})(?=(?:\.[^./]+)?$)/.exec(
    entry.Name
  );
  const legacy = legacyMatch && validArchiveStamp(legacyMatch[1]) ? legacyMatch : null;
  const suffix = suffixMatch && validArchiveStamp(suffixMatch[1]) ? suffixMatch : null;
  const name =
    legacy || suffix ? restoredHistoryName(entry.Name, legacy ? path : entry.Name) : entry.Name;
  const originalParent = legacy ? parent.slice(legacy[0].length).replace(/^\//, '') : parent;
  // A legacy file in the run root has no remaining parent directory.
  const relativeParent = legacy && parent === legacy[0].slice(0, -1) ? '' : originalParent;
  return {
    path,
    name,
    originalPath: relativeParent ? relativeParent + '/' + name : name,
    archived: legacy?.[1] || suffix?.[1] || '',
    entry,
  };
}

export interface HistorySearchResult {
  versions: HistoryVersion[];
  partial: boolean;
  errors: number;
  folders: number;
}
/** Bounded, lazy traversal of one explicitly selected archive. Cancel stops subsequent requests. */
export async function searchHistory(
  query: string,
  list: (path: string) => Promise<{ list: Entry[] }>,
  cancelled: () => boolean,
  update: (result: HistorySearchResult) => void,
  limits = { folders: 500, entries: 20000 }
): Promise<HistorySearchResult> {
  const result: HistorySearchResult = { versions: [], partial: false, errors: 0, folders: 0 };
  const term = query.trim().toLocaleLowerCase();
  if (!term) return result;
  const queue = [''],
    visited = new Set<string>();
  let entries = 0;
  while (
    queue.length &&
    result.folders < limits.folders &&
    entries < limits.entries &&
    !cancelled()
  ) {
    const parent = queue.shift();
    if (parent === undefined) break;
    if (visited.has(parent)) continue;
    visited.add(parent);
    try {
      const response = await list(parent);
      if (cancelled()) break;
      result.folders++;
      for (const entry of response.list ?? []) {
        if (++entries > limits.entries) break;
        if (typeof entry?.Name !== 'string' || !safeHistoryName(entry.Name)) continue;
        if (entry.IsDir) {
          queue.push(parent ? parent + '/' + entry.Name : entry.Name);
          continue;
        }
        const version = historyVersion(entry, parent);
        if (version?.originalPath.toLocaleLowerCase().includes(term)) result.versions.push(version);
      }
    } catch {
      if (cancelled()) break;
      result.errors++;
    }
    update({ ...result, versions: [...result.versions] });
  }
  result.partial = cancelled() || queue.length > 0 || entries > limits.entries || result.errors > 0;
  return result;
}
