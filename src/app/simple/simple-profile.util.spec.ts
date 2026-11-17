import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_NAME, ProfileConfig } from '@app/types';
import {
  SimpleTaskDraft,
  listSimpleTasks,
  patchSimpleProfile,
  restoredHistoryName,
  safeHistoryName,
  simpleSchedule,
  splitSimplePath,
  simpleMountOptions,
} from './simple-profile.util';

const draft = (changes: Partial<SimpleTaskDraft> = {}): SimpleTaskDraft => ({
  name: 'Backup',
  operation: 'sync',
  source: 'D:\\Apps',
  destination: 'NAS:mirror',
  history: 'NAS:history',
  useVss: true,
  schedule: 'manual',
  time: '18:30',
  oncePerDay: true,
  networkDrive: true,
  readOnly: false,
  serveType: 'http',
  address: '127.0.0.1:8080',
  ...changes,
});

describe('simple profile adapter', () => {
  it('preserves linked profiles, unknown flags and input objects', () => {
    const original: ProfileConfig = {
      app: { filterProfile: 'My filter', autoStartDelay: 17, cronExpression: '0 5 * * * *' },
      rclone: { srcFs: 'old', dstFs: 'old:dest', checksum: true },
    };
    const before = structuredClone(original),
      result = patchSimpleProfile(original, draft());
    expect(original).toEqual(before);
    expect(result.app).toMatchObject({
      filterProfile: 'My filter',
      autoStartDelay: 17,
      backupHistoryDir: 'NAS:history',
      useVss: true,
      autoStart: false,
      cronEnabled: false,
    });
    expect(result.rclone).toMatchObject({ srcFs: 'D:\\Apps', dstFs: 'NAS:mirror', checksum: true });
  });
  it('preserves a custom schedule and watcher without reinterpretation', () => {
    const app = {
      watchEnabled: true,
      watchDelay: 15,
      cronEnabled: true,
      cronExpression: '0 0 8 * * MON',
      autoStart: true,
    };
    expect(simpleSchedule(app).schedule).toBe('custom');
    expect(patchSimpleProfile({ app }, draft({ schedule: 'custom' })).app).toMatchObject(app);
  });
  it.each(['0 30 18 * * *', '30 18 * * *'])('recognizes a daily schedule %s', cronExpression => {
    expect(simpleSchedule({ cronEnabled: true, cronExpression })).toEqual({
      schedule: 'daily',
      time: '18:30',
    });
  });
  it.each(['', '0 60 18 * * *', '0 30 24 * * *', '15 0 8 * * *', '0 0 8 * * MON'])(
    'keeps other schedules %s',
    cronExpression => {
      expect(simpleSchedule({ cronEnabled: true, cronExpression }).schedule).toBe('custom');
    }
  );
  it('creates daily/startup settings and uses the shared default', () => {
    const result = patchSimpleProfile(undefined, draft({ schedule: 'daily', time: '07:05' }));
    expect(result.app).toMatchObject({
      cronExpression: '0 5 7 * * *',
      autoStart: false,
      filterProfile: DEFAULT_PROFILE_NAME,
    });
    expect(patchSimpleProfile(undefined, draft({ schedule: 'startup' })).app).toMatchObject({
      autoStart: true,
      autoStartOncePerDay: true,
      cronEnabled: false,
    });
  });
  it.each([{ source: '' }, { destination: '' }, { schedule: 'daily' as const, time: '25:70' }])(
    'rejects invalid input %o',
    changes => {
      expect(() => patchSimpleProfile(undefined, draft(changes))).toThrow();
    }
  );
  it('preserves existing nested mount flags until the user changes them', () => {
    const config: ProfileConfig = {
      rclone: {
        fs: 'NAS:',
        mountPoint: 'X:',
        mountOpt: { NetworkMode: false, VolName: 'My files' },
        vfsOpt: { ReadOnly: true, CacheMode: 2 },
      },
    };
    const before = structuredClone(config);
    const flags = simpleMountOptions(config);
    expect(flags).toEqual({ networkDrive: false, readOnly: true });
    const result = patchSimpleProfile(
      config,
      draft({ operation: 'mount', source: 'NAS:', destination: 'X:', ...flags })
    );
    expect(result.rclone).toEqual(config.rclone);
    expect(config).toEqual(before);
    const changed = patchSimpleProfile(
      config,
      draft({
        operation: 'mount',
        source: 'NAS:',
        destination: 'X:',
        networkDrive: true,
        readOnly: false,
      })
    );
    expect(changed.rclone?.['mountOpt']).toEqual({ NetworkMode: true, VolName: 'My files' });
    expect(changed.rclone?.['vfsOpt']).toEqual({ ReadOnly: false, CacheMode: 2 });
    expect(simpleMountOptions({})).toEqual({ networkDrive: false, readOnly: false });
  });

  it('allows snapshots only for local copy/mirror sources, not moves', () => {
    expect(() =>
      patchSimpleProfile(undefined, draft({ source: 'NAS:remote', useVss: true }))
    ).toThrow('simple.errors.vssSource');
    expect(
      patchSimpleProfile(undefined, draft({ operation: 'move', useVss: true })).app?.useVss
    ).toBe(false);
  });
  it('keeps distinct path keys for two-way sync, mount and serve', () => {
    expect(patchSimpleProfile(undefined, draft({ operation: 'bisync' })).rclone).toMatchObject({
      path1: 'D:\\Apps',
      path2: 'NAS:mirror',
    });
    expect(patchSimpleProfile(undefined, draft({ operation: 'mount' })).rclone).toMatchObject({
      fs: 'D:\\Apps',
      mountPoint: 'NAS:mirror',
      network_mode: true,
      read_only: false,
    });
    expect(
      patchSimpleProfile(undefined, draft({ operation: 'serve', destination: '' })).rclone
    ).toMatchObject({ fs: 'D:\\Apps', type: 'http', addr: '127.0.0.1:8080' });
  });
  it('lists configured tasks and marks multiple sources without flattening them', () => {
    const config = {
      rclone: { srcFs: ['D:\\One', 'D:\\Two'], dstFs: 'NAS:mirror' },
      app: { backupHistoryDir: 'NAS:history' },
    };
    const tasks = listSimpleTasks('NAS', { syncConfigs: { Backup: config, Blank: {} } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      name: 'Backup',
      multipleSources: true,
      source: 'D:\\One',
      history: 'NAS:history',
    });
    expect(config.rclone.srcFs).toEqual(['D:\\One', 'D:\\Two']);
    expect(listSimpleTasks('NAS', {})).toEqual([]);
  });
  it.each(['D:\\Apps', '/tmp/local', '\\\\server\\share'])(
    'does not mistake local paths for remote names: %s',
    path => {
      expect(splitSimplePath(path)).toEqual({ remote: '', path });
    }
  );
  it('splits remote paths only at the first colon', () => {
    expect(splitSimplePath('NAS:folder:other')).toEqual({ remote: 'NAS', path: 'folder:other' });
  });
});

describe('history names', () => {
  it.each([
    ['verzie_2026-11-17_08-30-27.066.txt', 'verzie.txt'],
    ['archive.tar_2026-11-17_08-30-27.066.gz', 'archive.tar.gz'],
    ['README_2026-11-17_08-30-27.066', 'README'],
    ['.config_2026-11-17_08-30-27.066', '.config'],
    ['unmodified.txt', 'unmodified.txt'],
  ])('restores %s as %s', (name, expected) => {
    expect(restoredHistoryName(name, 'MyApps/TestApp/' + name)).toBe(expected);
  });
  it.each(['.._2026-11-17_08-30-27.066', '._2026-11-17_08-30-27.066'])(
    'never derives a traversal name from %s',
    name => {
      expect(restoredHistoryName(name, name)).toBe(name);
    }
  );
  it('does not rename filenames from legacy run directories', () => {
    const name = 'original_2026-11-17_08-30-27.066.txt';
    expect(
      restoredHistoryName(name, '2026-11-17_08-30-27.066_f66eaab9d4c84790a8dc09c1164c8e4e/' + name)
    ).toBe(name);
  });
  it.each(['', '..', '.', '../outside', 'a/b', 'a\\b', 'a\u0000b'])(
    'rejects unsafe names %j',
    name => expect(safeHistoryName(name)).toBe(false)
  );
  it.each(['MyApps', 'verzie.txt', 'Systémové pomôcky', 'x01.txt'])(
    'allows ordinary names %s',
    name => expect(safeHistoryName(name)).toBe(true)
  );
});
