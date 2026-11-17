import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { MountManagementService } from './mount-management.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { PathService } from '../infrastructure/platform/path.service';
import { NotificationService } from '../ui/notification.service';
import { BackendService } from '../infrastructure/system/backend.service';
import type { MountedRemote } from '@app/types';

describe('MountManagementService', () => {
  const mount = (fs: string, mountPoint: string): MountedRemote =>
    ({ fs, mount_point: mountPoint }) as MountedRemote;

  let invoke: ReturnType<typeof vi.fn>;
  let mountCacheUpdated: Subject<void>;
  let engineReady: Subject<void>;

  const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve));

  function create(mounts: MountedRemote[] | Promise<MountedRemote[]>): MountManagementService {
    invoke = vi.fn().mockReturnValue(Promise.resolve(mounts));
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: BackendService, useValue: { isWindows: (): boolean => true } },
        { provide: NotificationService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
        { provide: ApiClientService, useValue: { invoke } },
        {
          provide: EventListenersService,
          useValue: {
            listenToMountCacheUpdated: vi.fn().mockReturnValue(mountCacheUpdated),
            listenToRcloneEngineReady: vi.fn().mockReturnValue(engineReady),
            listenToBackendSwitched: (): Subject<string> => new Subject<string>(),
          },
        },
        {
          provide: PathService,
          useValue: { getRemoteNameFromFs: (fs: string): string => fs.split(':')[0] },
        },
      ],
    });
    return TestBed.inject(MountManagementService);
  }

  beforeEach(() => {
    mountCacheUpdated = new Subject<void>();
    engineReady = new Subject<void>();
  });

  it('loads the running mounts as soon as it exists', async () => {
    const service = create([mount('Dropbox:/a', '/mnt/a')]);
    await flush();

    expect(invoke).toHaveBeenCalledWith('get_cached_mounted_remotes', undefined);
    expect(service.mountedRemotes()).toHaveLength(1);
  });

  it('loads again when the mount cache changes or the engine is ready', async () => {
    create([]);
    await flush();
    invoke.mockClear();

    mountCacheUpdated.next();
    engineReady.next();
    await flush();

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('keeps working when the first load fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    invoke = vi.fn().mockRejectedValue(new Error('offline'));
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: BackendService, useValue: { isWindows: (): boolean => true } },
        { provide: NotificationService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
        { provide: ApiClientService, useValue: { invoke } },
        {
          provide: EventListenersService,
          useValue: {
            listenToMountCacheUpdated: vi.fn().mockReturnValue(mountCacheUpdated),
            listenToRcloneEngineReady: vi.fn().mockReturnValue(engineReady),
            listenToBackendSwitched: (): Subject<string> => new Subject<string>(),
          },
        },
        { provide: PathService, useValue: { getRemoteNameFromFs: (fs: string): string => fs } },
      ],
    });
    const service = TestBed.inject(MountManagementService);
    await flush();

    expect(service.mountedRemotes()).toEqual([]);
    error.mockRestore();
  });
  it('sends the captured mount identity and backend in one reconnect command', async () => {
    const service = create([]);
    await flush();
    invoke.mockClear();
    invoke.mockResolvedValue(undefined);
    const expected = { fs: 'NAS:folder', mount_point: 'W:', execute_id: 'mount-1' };
    await service.reconnectRemoteProfile('NAS', 'Disk', expected, 'Local');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('reconnect_mount_profile', {
      params: {
        remoteName: 'NAS',
        profileName: 'Disk',
        backendName: 'Local',
        expectedMountPoint: 'W:',
        expectedFs: 'NAS:folder',
        expectedExecuteId: 'mount-1',
      },
    });
    expect(TestBed.inject(NotificationService).showSuccess).toHaveBeenCalled();
  });
  it('propagates reconnect failure without a second mount or an unscoped retry', async () => {
    const service = create([]);
    await flush();
    invoke.mockClear();
    const error = new Error('busy');
    invoke.mockRejectedValue(error);
    await expect(
      service.reconnectRemoteProfile('NAS', 'Disk', { fs: 'NAS:', mount_point: 'W:' }, 'Local')
    ).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(NotificationService).showError).toHaveBeenCalled();
    expect(TestBed.inject(NotificationService).showSuccess).not.toHaveBeenCalled();
  });
});

describe('Mount state refresh ordering', () => {
  const invoke = vi.fn();
  const switched = new Subject<string>();
  beforeEach(() => {
    invoke.mockResolvedValue([]);
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        { provide: ApiClientService, useValue: { invoke } },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
        { provide: BackendService, useValue: { isWindows: (): boolean => true } },
        {
          provide: EventListenersService,
          useValue: {
            listenToMountCacheUpdated: (): Subject<void> => new Subject<void>(),
            listenToRcloneEngineReady: (): Subject<void> => new Subject<void>(),
            listenToBackendSwitched: (): Subject<string> => switched,
          },
        },
      ],
    });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });
  it('does not replace fresh connected state with an older empty snapshot', async () => {
    const service = TestBed.inject(MountManagementService);
    await Promise.resolve();
    let old!: (value: MountedRemote[]) => void;
    let current!: (value: MountedRemote[]) => void;
    invoke
      .mockReturnValueOnce(
        new Promise<MountedRemote[]>(resolve => {
          old = resolve;
        })
      )
      .mockReturnValueOnce(
        new Promise<MountedRemote[]>(resolve => {
          current = resolve;
        })
      );
    const first = service.getMountedRemotes(),
      second = service.getMountedRemotes();
    const disk = { fs: 'NAS:', mount_point: 'W:' };
    current([disk]);
    await second;
    old([]);
    await first;
    expect(service.mountedRemotes()).toEqual([disk]);
    expect(service.refreshing()).toBe(false);
  });
  it('discards a pending snapshot from the previous backend', async () => {
    const service = TestBed.inject(MountManagementService);
    await Promise.resolve();
    let complete!: (value: MountedRemote[]) => void;
    invoke
      .mockReturnValueOnce(
        new Promise<MountedRemote[]>(resolve => {
          complete = resolve;
        })
      )
      .mockResolvedValueOnce([]);
    const pending = service.getMountedRemotes();
    switched.next('Other');
    await Promise.resolve();
    complete([{ fs: 'Old:', mount_point: 'Z:' }]);
    await pending;
    expect(service.mountedRemotes()).toEqual([]);
  });
});
