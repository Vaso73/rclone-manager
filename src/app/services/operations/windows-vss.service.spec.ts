import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { NotificationService } from '../ui/notification.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { WindowsVssService, VssHelperStatus } from './windows-vss.service';

describe('Windows VSS service', () => {
  let originalTauri: PropertyDescriptor | undefined;
  let service: WindowsVssService;
  let invoke: ReturnType<typeof vi.fn>;
  let backend: {
    activeBackend: ReturnType<typeof signal<string>>;
    isLocalBackend: ReturnType<typeof signal<boolean>>;
    isWindows: ReturnType<typeof signal<boolean>>;
  };
  let notifications: { showSuccess: ReturnType<typeof vi.fn>; showError: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    originalTauri = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    invoke = vi.fn().mockResolvedValue({ ready: true, busy: false });
    backend = {
      activeBackend: signal('Local'),
      isLocalBackend: signal(true),
      isWindows: signal(true),
    };
    notifications = { showSuccess: vi.fn(), showError: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClientService, useValue: { invoke } },
        { provide: BackendService, useValue: backend },
        { provide: NotificationService, useValue: notifications },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
        {
          provide: BackendTranslationService,
          useValue: { translateBackendMessage: (error: unknown): string => String(error) },
        },
      ],
    });
    service = TestBed.inject(WindowsVssService);
  });

  afterEach(() => {
    if (originalTauri) Object.defineProperty(window, '__TAURI_INTERNALS__', originalTauri);
    else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('only reads status when refreshing and never enables anything implicitly', async () => {
    await service.refresh();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('get_vss_helper_status', undefined);
    expect(service.status()).toEqual({ ready: true, busy: false });
    expect(notifications.showSuccess).not.toHaveBeenCalled();
  });

  it.each(['remote', 'nonWindows'] as const)(
    'does not invoke native commands for %s backends',
    async kind => {
      if (kind === 'remote') backend.isLocalBackend.set(false);
      else backend.isWindows.set(false);
      await service.refresh();
      await service.enable();
      expect(invoke).not.toHaveBeenCalled();
      expect(service.status()).toBeNull();
    }
  );

  it('does not invoke the native helper in web mode', async () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    const web = TestBed.runInInjectionContext(() => new WindowsVssService());
    await web.refresh();
    await web.enable();
    expect(invoke).not.toHaveBeenCalled();
    expect(web.supported()).toBe(false);
  });

  it('discards a late status response after the backend changes', async () => {
    let resolve!: (value: VssHelperStatus) => void;
    invoke.mockReturnValueOnce(
      new Promise<VssHelperStatus>(done => {
        resolve = done;
      })
    );
    const first = service.refresh();
    backend.activeBackend.set('Remote');
    backend.isLocalBackend.set(false);
    await service.refresh();
    resolve({ ready: true, busy: false });
    await first;
    expect(service.status()).toBeNull();
  });

  it('enables only on an explicit request and blocks duplicate setup requests', async () => {
    let resolve!: (value: VssHelperStatus) => void;
    invoke.mockReturnValueOnce(
      new Promise<VssHelperStatus>(done => {
        resolve = done;
      })
    );
    const first = service.enable();
    expect(service.pending()).toBe(true);
    await service.enable();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('enable_vss_helper', undefined);
    resolve({ ready: true, busy: false });
    await first;
    expect(service.pending()).toBe(false);
    expect(service.status()?.ready).toBe(true);
    expect(notifications.showSuccess).toHaveBeenCalledOnce();
  });

  it('reports setup failures without claiming readiness and releases the busy state', async () => {
    const error = new Error('cancelled');
    invoke.mockRejectedValueOnce(error);
    await expect(service.enable()).rejects.toBe(error);
    expect(service.pending()).toBe(false);
    expect(service.status()).toBeNull();
    expect(notifications.showError).toHaveBeenCalledOnce();
    expect(notifications.showSuccess).not.toHaveBeenCalled();
  });
});
