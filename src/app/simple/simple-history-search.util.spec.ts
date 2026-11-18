import { describe, expect, it, vi } from 'vitest';
import { createMinimalEntry, Entry } from '@app/types';
import { historyVersion, searchHistory, validArchiveStamp } from './simple-history-search.util';
const entry = (name: string): Entry => ({
  ...createMinimalEntry(name),
  Name: name,
  ModTime: '2026-11-18T08:00:00Z',
  Size: 16,
});
describe('history version identity', () => {
  it('keeps relative paths while reading current timestamp suffixes', () => {
    const v = historyVersion(entry('verzie_2026-11-18_08-30-27.066.txt'), 'MyApps/TestApp');
    expect(v).toMatchObject({
      name: 'verzie.txt',
      originalPath: 'MyApps/TestApp/verzie.txt',
      archived: '2026-11-18_08-30-27.066',
    });
  });
  it('reads nested and root-level legacy run archives without merging different sources', () => {
    const root = '2026-11-17_08-30-27.066_' + 'a'.repeat(32);
    expect(historyVersion(entry('verzie.txt'), root)?.originalPath).toBe('verzie.txt');
    expect(historyVersion(entry('verzie.txt'), root + '/MyApps/TestApp')?.originalPath).toBe(
      'MyApps/TestApp/verzie.txt'
    );
    expect(
      historyVersion(entry('file_2026-11-18_08-30-27.066.txt'), 'source-2')?.originalPath
    ).toBe('source-2/file.txt');
  });
  it('preserves unknown names and rejects traversal, directories and unknown sizes', () => {
    expect(historyVersion(entry('unknown.txt'), 'Apps')?.archived).toBe('');
    for (const name of ['../bad', 'a\\b', '..', 'a\n'])
      expect(historyVersion(entry(name), '')).toBeNull();
    expect(historyVersion({ ...entry('file'), Size: -1 }, '')).toBeNull();
    expect(historyVersion({ ...entry('folder'), IsDir: true }, '')).toBeNull();
  });
});
describe('archive timestamps are civil labels, not guessed UTC times', () => {
  it('accepts leap days and rejects impossible timestamps without stripping unknown names', () => {
    expect(validArchiveStamp('2024-02-29_23-59-59.999')).toBe(true);
    expect(validArchiveStamp('2026-02-29_23-59-59.999')).toBe(false);
    expect(validArchiveStamp('2026-01-01_24-00-00.000')).toBe(false);
    const name = 'file_2026-02-30_10-20-30.000.txt';
    expect(historyVersion(entry(name), 'Apps')).toMatchObject({ name, archived: '' });
  });
});
describe('bounded archive search', () => {
  it('does not list anything for an empty query or pre-cancelled search', async () => {
    const list = vi.fn().mockResolvedValue({ list: [] });
    await searchHistory('', list, () => false, vi.fn());
    await searchHistory('file', list, () => true, vi.fn());
    expect(list).not.toHaveBeenCalled();
  });
  it('finds only matching files, ignores hostile paths and reports progress', async () => {
    const list = vi.fn(async (path: string) => ({
      list: path
        ? [entry('Žltý_2026-11-18_08-30-27.066.txt'), entry('../bad')]
        : [{ ...entry('Apps'), IsDir: true }],
    }));
    const progress = vi.fn();
    const result = await searchHistory('žltý', list, () => false, progress);
    expect(result.versions).toHaveLength(1);
    expect(result.partial).toBe(false);
    expect(result.folders).toBe(2);
    expect(list.mock.calls.map(args => args[0])).toEqual(['', 'Apps']);
    expect(progress).toHaveBeenCalled();
  });
  it('does not schedule further requests or publish late results after cancellation', async () => {
    let cancelled = false;
    const list = vi.fn(async () => {
      cancelled = true;
      return { list: [entry('file')] };
    });
    const update = vi.fn();
    const result = await searchHistory('file', list, () => cancelled, update);
    expect(result.versions).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.partial).toBe(true);
  });
  it('distinguishes partial errors and resource limits from a complete empty result', async () => {
    const list = vi.fn(async (path: string) => {
      if (path) throw new Error('unavailable');
      return { list: [{ ...entry('folder'), IsDir: true }] };
    });
    expect(await searchHistory('file', list, () => false, vi.fn())).toMatchObject({
      partial: true,
      errors: 1,
    });
    expect(
      await searchHistory('file', list, () => false, vi.fn(), { folders: 1, entries: 100 })
    ).toMatchObject({ partial: true, folders: 1 });
  });
});
