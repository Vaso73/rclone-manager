import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageService } from '../services/ui/state/local-storage.service';
import {
  SimpleCardOrderService,
  moveSimpleCard,
  orderSimpleCards,
} from './simple-card-order.service';

describe('simple card order', () => {
  it('retains live cards when saved data is missing, invalid, stale or duplicated', () => {
    const items = ['A', 'B', 'C'];
    for (const saved of [null, {}, 9, 'B'])
      expect(orderSimpleCards(items, saved, x => x)).toEqual(items);
    expect(orderSimpleCards(items, ['B', 'B', null, 'removed', 'A'], x => x)).toEqual([
      'B',
      'A',
      'C',
    ]);
    expect(items).toEqual(['A', 'B', 'C']);
    expect(orderSimpleCards([], ['A'], String)).toEqual([]);
  });
  it('moves in either direction without losing a card and rejects unknown ids', () => {
    expect(moveSimpleCard(['A', 'B', 'C'], 'A', 'C')).toEqual(['B', 'C', 'A']);
    expect(moveSimpleCard(['A', 'B', 'C'], 'C', 'A')).toEqual(['C', 'A', 'B']);
    expect(moveSimpleCard(['A', 'B'], 'removed', 'B')).toEqual(['A', 'B']);
    expect(moveSimpleCard(['A', 'B'], 'A', 'A')).toEqual(['A', 'B']);
  });
  const saved = new Map<string, unknown>();
  beforeEach(() => {
    saved.clear();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LocalStorageService,
          useValue: {
            getScoped: (scope: string, key: string, fallback: unknown): unknown =>
              saved.get(scope + key) ?? fallback,
            setScoped: (scope: string, key: string, value: unknown): Map<string, unknown> =>
              saved.set(scope + key, value),
          },
        },
      ],
    });
  });
  it('persists across service instances, isolates backends/groups, and appends added cards', () => {
    const service = TestBed.inject(SimpleCardOrderService);
    service.move('Local', 'connections', ['A', 'B'], 'B', 'A');
    const fresh = TestBed.runInInjectionContext(() => new SimpleCardOrderService());
    expect(fresh.sorted('Local', 'connections', ['A', 'B', 'New'], String)).toEqual([
      'B',
      'A',
      'New',
    ]);
    expect(fresh.sorted('Other', 'connections', ['A', 'B'], String)).toEqual(['A', 'B']);
    expect(fresh.sorted('Local', 'history', ['A', 'B'], String)).toEqual(['A', 'B']);
    expect(fresh.sorted('Local', 'connections', ['New'], String)).toEqual(['New']);
  });
  it('does not write on no-op or invalid moves', () => {
    const service = TestBed.inject(SimpleCardOrderService);
    service.move('Local', 'connections', ['A'], 'A', 'A');
    service.move('Local', 'connections', ['A'], 'A', 'unknown');
    expect(saved.size).toBe(0);
  });
});
