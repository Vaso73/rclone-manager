import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SimpleHistoryPlacesService,
  historyPlaceId,
  mergeHistoryPlaces,
  validHistoryRoot,
} from './simple-history-places.service';
import { LocalStorageService } from '../services/ui/state/local-storage.service';
import { SimpleTask } from './simple-profile.util';
const task = {
  remote: 'NAS',
  name: 'Backup',
  operation: 'sync',
  history: 'NAS:history',
  source: 'D:\\Apps',
  destination: 'NAS:mirror',
  multipleSources: false,
  config: { app: {}, rclone: {} },
} as SimpleTask;
describe('history locator catalog', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [LocalStorageService] });
  });
  it('retains a locator after the last task disappears and after service recreation', () => {
    const service = TestBed.inject(SimpleHistoryPlacesService);
    service.remember('Local', [task]);
    service.remember('Local', []);
    expect(service.places('Local')).toHaveLength(1);
    TestBed.resetTestingModule();
    expect(TestBed.inject(SimpleHistoryPlacesService).places('Local')[0].root).toBe('NAS:history');
  });
  it('hides reversibly per backend without changing the task or its archive setting', () => {
    const before = JSON.stringify(task);
    const service = TestBed.inject(SimpleHistoryPlacesService);
    service.remember('Local', [task]);
    const id = historyPlaceId('NAS', 'NAS:history');
    service.toggleHidden('Local', id);
    service.remember('Local', [task]);
    expect(service.places('Local')[0].hidden).toBe(true);
    expect(service.places('Other')).toEqual([]);
    expect(JSON.stringify(task)).toBe(before);
    service.toggleHidden('Local', id);
    expect(service.places('Local')[0].hidden).toBe(false);
  });
  it('adds standalone archives without creating profiles and rejects malformed roots', () => {
    const service = TestBed.inject(SimpleHistoryPlacesService);
    expect(service.add('Local', 'Older archive', 'NAS:older', 'NAS')).toBe(true);
    expect(service.add('Local', '', 'NAS:older', 'NAS')).toBe(false);
    for (const root of ['', 'relative', 'NAS:archive/../outside', 'NAS:bad\n'])
      expect(validHistoryRoot(root)).toBe(false);
    expect(validHistoryRoot('D:\\Old backups')).toBe(true);
    expect(validHistoryRoot('/backup')).toBe(true);
  });
  it('sanitizes persisted data and uses exact owner/root identity instead of display names', () => {
    expect(
      mergeHistoryPlaces([null, {}, { name: 'Bad', owner: 'NAS', root: 'relative' }], [task])
    ).toHaveLength(1);
    const places = mergeHistoryPlaces(
      [],
      [task, { ...task, remote: 'OTHER' }, { ...task, name: 'Renamed' }]
    );
    expect(places).toHaveLength(2);
    expect(places[0].name).toBe('Renamed');
  });
});
