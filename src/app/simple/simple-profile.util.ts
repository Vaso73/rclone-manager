import {
  AppConfig,
  DEFAULT_PROFILE_NAME,
  ProfileConfig,
  MountedRemote,
  profileOf,
  RemoteSettings,
  RemoteConfigSections,
  REMOTE_CONFIG_KEYS,
} from '@app/types';
import {
  getAppCfg,
  getRcloneCfg,
  extractProfileSource,
  extractProfileDest,
} from '../shared/utils/profile-config.util';

import { normalizeRemoteName } from '../shared/utils/path.utils';

export const SIMPLE_OPERATIONS = [
  'sync',
  'copy',
  'bisync',
  'move',
  'check',
  'mount',
  'serve',
] as const;
export type SimpleOperation = (typeof SIMPLE_OPERATIONS)[number];
export type SimpleSchedule = 'manual' | 'startup' | 'daily' | 'custom';
export interface SimpleTask {
  remote: string;
  name: string;
  operation: SimpleOperation;
  config: ProfileConfig;
  source: string;
  destination: string;
  history: string;
  multipleSources: boolean;
}
export interface SimpleTaskDraft {
  name: string;
  operation: SimpleOperation;
  source: string;
  destination: string;
  history: string;
  useVss: boolean;
  schedule: SimpleSchedule;
  time: string;
  oncePerDay: boolean;
  networkDrive: boolean;
  readOnly: boolean;
  serveType: string;
  address: string;
}

export function listSimpleTasks(remote: string, settings: RemoteSettings): SimpleTask[] {
  return SIMPLE_OPERATIONS.flatMap(operation => {
    const profiles = settings[REMOTE_CONFIG_KEYS[operation]] as
      Record<string, ProfileConfig> | undefined;
    return Object.entries(profiles ?? {}).flatMap(([name, config]) => {
      const rclone = getRcloneCfg(config);
      const src = extractProfileSource(rclone);
      const sources = Array.isArray(src)
        ? src.filter((s): s is string => typeof s === 'string' && !!s.trim())
        : typeof src === 'string' && src.trim()
          ? [src]
          : [];
      if (!sources.length) return [];
      return [
        {
          remote,
          name,
          operation,
          config,
          source: sources[0],
          destination: String(extractProfileDest(rclone) ?? ''),
          history: getAppCfg(config)?.backupHistoryDir ?? '',
          multipleSources: sources.length > 1,
        },
      ];
    });
  });
}

/** Empty destinations must never expose a runnable default profile. */
export function simpleTaskReady(task: SimpleTask): boolean {
  return !!task.source.trim() && (task.operation === 'serve' || !!task.destination.trim());
}

export function simpleTaskMount(
  task: SimpleTask,
  mounts: readonly MountedRemote[]
): MountedRemote | undefined {
  if (task.operation !== 'mount') return undefined;
  return mounts.find(
    mount =>
      normalizeRemoteName(splitSimplePath(mount.fs).remote) === task.remote &&
      profileOf(mount) === task.name
  );
}

export function simpleSchedule(app: AppConfig | null | undefined): {
  schedule: SimpleSchedule;
  time: string;
} {
  if (app?.watchEnabled || (app?.autoStart && app?.cronEnabled))
    return { schedule: 'custom', time: '18:00' };
  if (app?.cronEnabled) {
    const fields = app.cronExpression?.trim().split(/\s+/) ?? [];
    if (fields.length === 5) fields.unshift('0');
    if (
      fields.length === 6 &&
      fields[0] === '0' &&
      /^\d+$/.test(fields[1]) &&
      /^\d+$/.test(fields[2]) &&
      fields.slice(3).every(v => v === '*') &&
      +fields[1] < 60 &&
      +fields[2] < 24
    ) {
      return {
        schedule: 'daily',
        time: `${fields[2].padStart(2, '0')}:${fields[1].padStart(2, '0')}`,
      };
    }
    return { schedule: 'custom', time: '18:00' };
  }
  return { schedule: app?.autoStart ? 'startup' : 'manual', time: '18:00' };
}

/** Read saved mount flags without treating an absent legacy option as enabled. */
export function simpleMountOptions(
  config: ProfileConfig | undefined,
  settings: RemoteSettings = {}
): {
  networkDrive: boolean;
  readOnly: boolean;
} {
  const rc = getRcloneCfg(config) ?? {};
  const profile = getAppCfg(config)?.vfsProfile ?? DEFAULT_PROFILE_NAME;
  const inherited = (settings['vfsConfigs'] as RemoteConfigSections['vfsConfigs'])?.[profile];
  const read = (names: string[], fallback: boolean): boolean => {
    for (const block of [inherited, rc['vfsOpt'], rc['mountOpt'], rc]) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      for (const name of names) {
        const value = (block as Record<string, unknown>)[name];
        if (typeof value === 'boolean') return value;
      }
    }
    return fallback;
  };
  return {
    networkDrive: read(['NetworkMode', 'network_mode', 'network-mode', 'networkMode'], !config),
    readOnly: read(['ReadOnly', 'read_only', 'read-only', 'readOnly'], false),
  };
}

function setMountOption(
  rc: NonNullable<ProfileConfig['rclone']>,
  names: string[],
  value: boolean
): void {
  for (const key of ['mountOpt', 'vfsOpt']) {
    const block = rc[key];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const updated = { ...block };
      for (const name of names) if (Object.hasOwn(updated, name)) updated[name] = value;
      rc[key] = updated;
    }
  }
  for (const name of names) if (Object.hasOwn(rc, name)) rc[name] = value;
  rc[names[1]] = value;
  const blockName = names[0] === 'NetworkMode' ? 'mountOpt' : 'vfsOpt';
  const previous = rc[blockName];
  rc[blockName] = {
    ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
    [names[0]]: value,
  };
}

/** Patch only exposed fields; preserve filters, linked profiles, credentials and unknown options. */
export function patchSimpleProfile(
  existing: ProfileConfig | undefined,
  draft: SimpleTaskDraft,
  settings: RemoteSettings = {}
): ProfileConfig {
  const app: AppConfig = { ...getAppCfg(existing) };
  const rclone: NonNullable<ProfileConfig['rclone']> = { ...getRcloneCfg(existing) };
  if (!draft.source.trim() || (!draft.destination.trim() && draft.operation !== 'serve'))
    throw new Error('simple.errors.paths');
  if (draft.operation === 'bisync') {
    rclone.path1 = draft.source.trim();
    rclone.path2 = draft.destination.trim();
  } else if (draft.operation === 'mount') {
    rclone.fs = draft.source.trim();
    rclone.mountPoint = draft.destination.trim();
    const original = simpleMountOptions(existing, settings);
    if (!existing || original.networkDrive !== draft.networkDrive)
      setMountOption(
        rclone,
        ['NetworkMode', 'network_mode', 'network-mode', 'networkMode'],
        draft.networkDrive
      );
    if (!existing || original.readOnly !== draft.readOnly)
      setMountOption(rclone, ['ReadOnly', 'read_only', 'read-only', 'readOnly'], draft.readOnly);
  } else if (draft.operation === 'serve') {
    rclone.fs = draft.source.trim();
    rclone.type = draft.serveType;
    rclone.addr = draft.address;
  } else {
    rclone.srcFs = draft.source.trim();
    rclone.dstFs = draft.destination.trim();
  }
  if (['sync', 'copy', 'move'].includes(draft.operation)) {
    app.backupHistoryDir = draft.history.trim();
    if (draft.operation === 'sync' || draft.operation === 'copy') {
      if (draft.useVss && splitSimplePath(draft.source).remote)
        throw new Error('simple.errors.vssSource');
      app.useVss = draft.useVss;
    } else if (!existing) app.useVss = false;
  }
  if (draft.schedule !== 'custom') {
    app.autoStart = draft.schedule === 'startup';
    app.cronEnabled = draft.schedule === 'daily';
    app.watchEnabled = false;
    if (draft.schedule === 'startup') app.autoStartOncePerDay = draft.oncePerDay;
    if (draft.schedule === 'daily') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error('simple.errors.time');
      const [hour, minute] = draft.time.split(':').map(Number);
      app.cronExpression = `0 ${minute} ${hour} * * *`;
    }
  }
  if (!existing) {
    app.filterProfile = DEFAULT_PROFILE_NAME;
    app.backendProfile = DEFAULT_PROFILE_NAME;
    app.vfsProfile = DEFAULT_PROFILE_NAME;
    app.runtimeRemoteProfile = DEFAULT_PROFILE_NAME;
  }
  return { ...existing, app, rclone };
}

export function splitSimplePath(path: string): { remote: string; path: string } {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\'))
    return { remote: '', path };
  const colon = path.indexOf(':');
  return colon > 0
    ? { remote: path.slice(0, colon), path: path.slice(colon + 1) }
    : { remote: '', path };
}

export function restoredHistoryName(name: string, relativePath: string): string {
  // Legacy date/UUID run directories already hold the original filename.
  if (/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}_[a-f0-9]{32}\//.test(relativePath)) return name;
  const restored = name.replace(
    /_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}(?=(?:\.[^./]+)?$)/,
    ''
  );
  return safeHistoryName(restored) ? restored : name;
}

/** A browser entry is a single name, never a path supplied by a remote server. */
export function safeHistoryName(name: string): boolean {
  return (
    !!name &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name) &&
    !Array.from(name).some(char => char.charCodeAt(0) < 32)
  );
}

/** Never modify a shared VFS profile belonging to other mounted disks. */
export function patchSimpleMountVfs(
  settings: RemoteSettings,
  existing: ProfileConfig | undefined,
  draft: SimpleTaskDraft,
  profile: ProfileConfig
): Partial<RemoteConfigSections> {
  if (draft.operation !== 'mount') return {};
  const originalName = getAppCfg(existing)?.vfsProfile ?? DEFAULT_PROFILE_NAME;
  const inherited = (settings['vfsConfigs'] as RemoteConfigSections['vfsConfigs'])?.[originalName];
  if (!inherited) return {};
  const original = simpleMountOptions(existing, settings);
  if (original.readOnly === draft.readOnly && original.networkDrive === draft.networkDrive)
    return {};
  const readAliases = ['ReadOnly', 'read_only', 'read-only', 'readOnly'];
  const networkAliases = ['NetworkMode', 'network_mode', 'network-mode', 'networkMode'];
  const updated = { ...inherited };
  let changed = false;
  for (const [names, value, before] of [
    [readAliases, draft.readOnly, original.readOnly],
    [networkAliases, draft.networkDrive, original.networkDrive],
  ] as const) {
    if (value === before) continue;
    for (const key of names)
      if (Object.hasOwn(updated, key)) {
        updated[key] = value;
        changed = true;
      }
  }
  if (!changed) return {};
  const base = draft.name.trim() + ' (disk)';
  let name = base;
  for (let n = 2; Object.hasOwn(settings['vfsConfigs'] ?? {}, name); n++) name = base + ' ' + n;
  profile.app = { ...profile.app, vfsProfile: name };
  return {
    vfsConfigs: {
      ...(settings['vfsConfigs'] as RemoteConfigSections['vfsConfigs']),
      [name]: updated,
    },
  };
}
