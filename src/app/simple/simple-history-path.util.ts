interface HistoryLocation {
  filesystem: string;
  absolute: boolean;
  parts: string[];
}

function location(path: string, windows: boolean): HistoryLocation | undefined {
  if (
    !path.trim() ||
    Array.from(path).some(
      char => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)
    )
  )
    return undefined;
  const normalized = windows ? path.replace(/\\/g, '/') : path;
  let filesystem: string,
    tail: string,
    fold = false;
  if (windows && /^[a-z]:/i.test(normalized)) {
    if (normalized[2] !== '/') return undefined;
    filesystem = normalized.slice(0, 2).toLowerCase();
    tail = normalized.slice(2);
    fold = true;
  } else if (windows && normalized.startsWith('//')) {
    const [server, share, ...rest] = normalized.slice(2).split('/');
    if (!server || !share || server === '.' || server === '?') return undefined;
    filesystem = ('//' + server + '/' + share).toLowerCase();
    tail = rest.join('/');
    fold = true;
  } else if (normalized.includes(':')) {
    const colon = normalized.indexOf(':');
    filesystem = normalized.slice(0, colon);
    if (!filesystem || filesystem.includes('/')) return undefined;
    filesystem += ':';
    tail = normalized.slice(colon + 1);
  } else if (normalized.startsWith('/')) {
    filesystem = '/';
    tail = normalized;
  } else return undefined;
  const parts = tail.split('/').filter(part => part !== '' && part !== '.');
  if (parts.includes('..')) return undefined;
  return {
    filesystem,
    absolute: tail.startsWith('/'),
    parts: fold ? parts.map(p => p.toLowerCase()) : parts,
  };
}
function overlaps(a: HistoryLocation, b: HistoryLocation): boolean {
  return (
    a.filesystem === b.filesystem &&
    a.absolute === b.absolute &&
    (a.parts.every((part, i) => b.parts[i] === part) ||
      b.parts.every((part, i) => a.parts[i] === part))
  );
}
/** Same component-wise rules as backend backup/history.rs; never checks or changes files. */
export function simpleHistoryError(
  source: string,
  destination: string,
  history: string,
  windows: boolean
): string {
  if (!history.trim()) return '';
  const archive = location(history.trim(), windows),
    target = location(destination.trim(), windows);
  if (!archive || !target) return 'backendErrors.backup.historyPathInvalid';
  if (archive.filesystem !== target.filesystem || archive.absolute !== target.absolute)
    return 'backendErrors.backup.historySameFilesystem';
  if (overlaps(archive, target)) return 'backendErrors.backup.historyOverlap';
  const origin = location(source.trim(), windows);
  return origin && overlaps(archive, origin) ? 'backendErrors.backup.historyOverlap' : '';
}

/** This is the original time written in a legacy name, not an inferred UTC conversion. */
export function legacyArchiveDate(name: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.\d{3}_[a-f0-9]{32}$/.exec(name);
  return match ? `${match[3]}.${match[2]}.${match[1]} ${match[4]}:${match[5]}:${match[6]}` : '';
}
