import { Injectable, inject, signal } from '@angular/core';
import { LocalStorageService } from '../services/ui/state/local-storage.service';
import { SimpleTask } from './simple-profile.util';

export interface HistoryPlace {
  id: string;
  name: string;
  owner: string;
  root: string;
  hidden: boolean;
}

export function historyPlaceId(owner: string, root: string): string {
  return JSON.stringify([owner, root]);
}
export function validHistoryRoot(root: string): boolean {
  return (
    !!root.trim() &&
    !Array.from(root).some(char => char.charCodeAt(0) < 32) &&
    !root
      .replace(/\\/g, '/')
      .split('/')
      .some(part => part === '..') &&
    (/^[A-Za-z]:[\\/]/.test(root) ||
      root.startsWith('/') ||
      root.startsWith('\\\\') ||
      /^[^:/\\]+:/.test(root))
  );
}
export function mergeHistoryPlaces(saved: unknown, tasks: readonly SimpleTask[]): HistoryPlace[] {
  const entries = new Map<string, HistoryPlace>();
  if (Array.isArray(saved))
    for (const item of saved) {
      if (
        !item ||
        typeof item.name !== 'string' ||
        typeof item.owner !== 'string' ||
        typeof item.root !== 'string' ||
        !validHistoryRoot(item.root)
      )
        continue;
      const id = historyPlaceId(item.owner, item.root);
      entries.set(id, {
        id,
        name: item.name,
        owner: item.owner,
        root: item.root,
        hidden: item.hidden === true,
      });
    }
  for (const task of tasks) {
    if (!validHistoryRoot(task.history)) continue;
    const id = historyPlaceId(task.remote, task.history);
    const previous = entries.get(id);
    entries.set(id, {
      id,
      name: task.displayName || task.name,
      owner: task.remote,
      root: task.history,
      hidden: previous?.hidden ?? false,
    });
  }
  return [...entries.values()];
}

/** Persistent presentation catalog; removing a task never removes its archived files or locator. */
@Injectable({ providedIn: 'root' })
export class SimpleHistoryPlacesService {
  private readonly storage = inject(LocalStorageService);
  private readonly revision = signal(0);
  places(backend: string, tasks: readonly SimpleTask[] = []): HistoryPlace[] {
    this.revision();
    return mergeHistoryPlaces(
      this.storage.getScoped<unknown>('simple-history-places', backend, []),
      tasks
    );
  }
  remember(backend: string, tasks: readonly SimpleTask[]): void {
    const before = this.storage.getScoped<unknown>('simple-history-places', backend, []);
    const after = mergeHistoryPlaces(before, tasks);
    if (JSON.stringify(before) !== JSON.stringify(after)) this.save(backend, after);
  }
  add(backend: string, name: string, root: string, owner: string): boolean {
    if (!name.trim() || !validHistoryRoot(root.trim())) return false;
    const entries = this.places(backend),
      id = historyPlaceId(owner, root.trim());
    const place = { id, name: name.trim(), root: root.trim(), owner, hidden: false };
    this.save(backend, [...entries.filter(item => item.id !== id), place]);
    return true;
  }
  toggleHidden(backend: string, id: string): void {
    this.save(
      backend,
      this.places(backend).map(item => (item.id === id ? { ...item, hidden: !item.hidden } : item))
    );
  }
  private save(backend: string, places: HistoryPlace[]): void {
    this.storage.setScoped('simple-history-places', backend, places);
    this.revision.update(n => n + 1);
  }
}
