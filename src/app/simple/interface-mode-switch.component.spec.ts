import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InterfaceModeService } from './interface-mode.service';
import { InterfaceModeSwitchComponent } from './interface-mode-switch.component';
import { NotificationService } from '../services/ui/notification.service';

describe('persistent interface mode switch', () => {
  const simple = signal(false),
    setMode = vi.fn(),
    showError = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    simple.set(false);
    setMode.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: InterfaceModeService, useValue: { simple, setMode } },
        { provide: NotificationService, useValue: { showError } },
      ],
    });
  });
  it('switches in both directions using only the persisted display preference', async () => {
    const c = TestBed.runInInjectionContext(() => new InterfaceModeSwitchComponent());
    await c.toggle();
    expect(setMode).toHaveBeenLastCalledWith('simple');
    simple.set(true);
    await c.toggle();
    expect(setMode).toHaveBeenLastCalledWith('advanced');
  });
  it('reports a failed setting write without hiding the control', async () => {
    const error = new Error('offline');
    setMode.mockRejectedValue(error);
    const c = TestBed.runInInjectionContext(() => new InterfaceModeSwitchComponent());
    await c.toggle();
    expect(showError).toHaveBeenCalledWith(error);
    expect(simple()).toBe(false);
  });
});
