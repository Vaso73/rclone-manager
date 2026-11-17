import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettingsService } from '../services/settings/app-settings.service';
import { InterfaceModeService } from './interface-mode.service';

describe('interface mode', () => {
  const options = signal<Record<string, { value: string }>>({});
  const saveSetting = vi.fn();
  let service: InterfaceModeService;
  beforeEach(() => {
    options.set({});
    saveSetting.mockReset();
    saveSetting.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: AppSettingsService, useValue: { options, saveSetting } }],
    });
    service = TestBed.inject(InterfaceModeService);
  });
  it('preserves advanced mode for existing settings and unknown values', () => {
    expect(service.mode()).toBe('advanced');
    options.set({ 'general.interface_mode': { value: 'unknown' } });
    expect(service.simple()).toBe(false);
    expect(saveSetting).not.toHaveBeenCalled();
  });
  it('reads simple mode and saves only the display preference', async () => {
    await service.setMode('simple');
    expect(saveSetting).toHaveBeenCalledExactlyOnceWith('general', 'interface_mode', 'simple');
    options.set({ 'general.interface_mode': { value: 'simple' } });
    expect(service.simple()).toBe(true);
    await service.setMode('simple');
    expect(saveSetting).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate concurrent saves and releases the guard on failure', async () => {
    saveSetting.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('failed')), 0);
        })
    );
    const pending = service.setMode('simple');
    await service.setMode('simple');
    expect(saveSetting).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toThrow('failed');
    expect(service.saving()).toBe(false);
  });
});
