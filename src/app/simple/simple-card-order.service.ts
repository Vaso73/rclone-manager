import { inject, Injectable, signal } from '@angular/core';
import { LocalStorageService } from '../services/ui/state/local-storage.service';

/** Unknown, duplicate and removed keys never hide live cards; new cards follow saved ones. */
export function orderSimpleCards<T>(
  items: readonly T[],
  saved: unknown,
  key: (item: T) => string
): T[] {
  const byKey = new Map(items.map(item => [key(item), item]));
  const result: T[] = [];
  for (const id of Array.isArray(saved) ? saved : []) {
    if (typeof id !== 'string' || !byKey.has(id)) continue;
    const item = byKey.get(id);
    if (item === undefined) continue;
    result.push(item);
    byKey.delete(id);
  }
  result.push(...byKey.values());
  return result;
}

export function moveSimpleCard(keys: readonly string[], from: string, to: string): string[] {
  const result = [...new Set(keys)];
  const start = result.indexOf(from),
    end = result.indexOf(to);
  if (start < 0 || end < 0 || start === end) return result;
  result.splice(end, 0, ...result.splice(start, 1));
  return result;
}

/** Presentation only, scoped to this client and backend; never writes transfer settings. */
@Injectable({ providedIn: 'root' })
export class SimpleCardOrderService {
  private readonly storage = inject(LocalStorageService);
  private readonly revision = signal(0);

  private storageKey(backend: string, group: string): string {
    return JSON.stringify([backend, group]);
  }

  sorted<T>(backend: string, group: string, items: readonly T[], key: (item: T) => string): T[] {
    this.revision();
    return orderSimpleCards(
      items,
      this.storage.getScoped<unknown>('simple-card-order', this.storageKey(backend, group), []),
      key
    );
  }

  move(backend: string, group: string, keys: readonly string[], from: string, to: string): void {
    if (!keys.includes(from) || !keys.includes(to) || from === to) return;
    this.storage.setScoped(
      'simple-card-order',
      this.storageKey(backend, group),
      moveSimpleCard(keys, from, to)
    );
    this.revision.update(n => n + 1);
  }
}
