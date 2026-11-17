import { extractProfileSource, getRcloneCfg } from '../shared/utils/profile-config.util';
import { SimpleTask, splitSimplePath } from './simple-profile.util';

export const simpleTaskKey = (task: SimpleTask): string =>
  JSON.stringify([task.remote, task.operation, task.name]);

/** A profile belongs to its stored owner, but filters describe the paths it actually uses. */
export function simpleTaskConnections(task: SimpleTask, available: readonly string[]): string[] {
  const raw = extractProfileSource(getRcloneCfg(task.config));
  const paths = [...(Array.isArray(raw) ? raw : [raw]), task.source, task.destination];
  const used = new Set(
    paths
      .filter((path): path is string => typeof path === 'string')
      .map(path => splitSimplePath(path).remote)
      .filter(Boolean)
  );
  const matches = available.filter(name => used.has(name));
  // Keep local-only/legacy tasks accessible rather than dropping their stored owner.
  return matches.length ? matches : available.includes(task.remote) ? [task.remote] : [];
}
