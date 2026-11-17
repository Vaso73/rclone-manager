import { describe, it, expect } from 'vitest';
import { simpleHistoryError, legacyArchiveDate } from './simple-history-path.util';
describe('history path validation before saving', () => {
  it('accepts sibling folders on the same filesystem and similar prefixes', () => {
    expect(simpleHistoryError('D:\\Apps', 'NAS:TEST/mirror', 'NAS:TEST/history', true)).toBe('');
    expect(simpleHistoryError('D:\\Apps', 'NAS:mirror', 'NAS:mirror-old', true)).toBe('');
  });
  it.each(['NAS:mirror', 'NAS:mirror/old', 'NAS:'])('rejects overlapping %s', history => {
    expect(simpleHistoryError('D:\\Apps', 'NAS:mirror', history, true)).toContain('historyOverlap');
  });
  it('rejects another filesystem and ambiguous paths', () => {
    expect(simpleHistoryError('D:\\Apps', 'NAS:mirror', 'D:\\', true)).toContain(
      'historySameFilesystem'
    );
    for (const path of [
      'relative',
      'NAS:../history',
      'D:history',
      'NAS:bad\npath',
      'NAS:bad\u0085path',
    ])
      expect(simpleHistoryError('D:\\Apps', 'NAS:mirror', path, true)).toContain(
        'historyPathInvalid'
      );
  });
  it('checks source overlap with Windows case/slashes and UNC shares', () => {
    expect(simpleHistoryError('D:\\APPS', 'D:\\mirror', 'd:/apps/old', true)).toContain(
      'historyOverlap'
    );
    expect(
      simpleHistoryError('C:/source', '\\\\server\\share\\mirror', '//SERVER/share/old', true)
    ).toBe('');
  });
  it('keeps Unix and remote path case sensitivity', () => {
    expect(simpleHistoryError('/source', '/Mirror', '/mirror', false)).toBe('');
    expect(simpleHistoryError('/source', 'NAS:/mirror', 'NAS:history', false)).toContain(
      'historySameFilesystem'
    );
  });
  it('keeps disabled history optional', () =>
    expect(simpleHistoryError('', '', '', true)).toBe(''));
});
describe('legacy archive labels', () => {
  it('displays the time without changing the original name or guessing a timezone', () => {
    const name = '2026-11-17_08-30-27.066_f66eaab9d4c84790a8dc09c1164c8e4e';
    expect(legacyArchiveDate(name)).toBe('17.11.2026 08:30:27');
    expect(legacyArchiveDate('MyApps')).toBe('');
    expect(legacyArchiveDate('../' + name)).toBe('');
  });
});
