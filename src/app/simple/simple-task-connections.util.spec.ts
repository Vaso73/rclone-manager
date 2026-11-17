import { describe, expect, it } from 'vitest';
import { listSimpleTasks, SimpleTask } from './simple-profile.util';
import { simpleTaskConnections, simpleTaskKey } from './simple-task-connections.util';

describe('task connection membership', () => {
  const task = (source: string | string[], target: string): SimpleTask =>
    listSimpleTasks('StoredOwner', {
      syncConfigs: { Backup: { rclone: { srcFs: source, dstFs: target } } },
    })[0];
  it('uses actual source and destination instead of the profile storage owner', () => {
    const t = task('D:\\Apps', 'NAS:mirror');
    expect(simpleTaskConnections(t, ['StoredOwner', 'NAS', 'Unused'])).toEqual(['NAS']);
    expect(simpleTaskConnections(task('NAS:source', 'D:\\Apps'), ['NAS'])).toEqual(['NAS']);
    expect(simpleTaskConnections(task('NAS:source', 'Cloud:target'), ['Cloud', 'NAS'])).toEqual([
      'Cloud',
      'NAS',
    ]);
  });
  it('includes every configured source and handles local paths and special names', () => {
    expect(
      simpleTaskConnections(task(['NAS:one', 'Cloud:two'], 'D:\\Apps'), ['NAS', 'Cloud'])
    ).toEqual(['NAS', 'Cloud']);
    expect(simpleTaskConnections(task('SFTP [a]:x', 'D:\\Apps'), ['SFTP [a]'])).toEqual([
      'SFTP [a]',
    ]);
    expect(
      simpleTaskConnections(task('D:\\Apps', '\\\\server\\share'), ['D', 'StoredOwner'])
    ).toEqual(['StoredOwner']);
    expect(simpleTaskConnections(task('/tmp/source', '/tmp/target'), [])).toEqual([]);
  });
  it('keeps local-only or legacy profiles reachable and creates collision-free stable keys', () => {
    const a = task('D:\\Apps', 'D:\\Backup');
    expect(simpleTaskConnections(a, ['StoredOwner', 'Unused'])).toEqual(['StoredOwner']);
    expect(simpleTaskKey({ ...a, remote: 'a/b', name: 'c' })).not.toBe(
      simpleTaskKey({ ...a, remote: 'a', name: 'b/c' })
    );
    expect(simpleTaskKey({ ...a, displayName: 'renamed' })).toBe(simpleTaskKey(a));
  });
});
