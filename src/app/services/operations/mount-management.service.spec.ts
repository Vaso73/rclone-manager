import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Subject } from 'rxjs';
import { provideTranslateService } from '@ngx-translate/core';
import { MountManagementService } from './mount-management.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';
import { PathService } from '../infrastructure/platform/path.service';
import { NotificationService } from '../ui/notification.service';
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
        { provide: NotificationService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
        { provide: ApiClientService, useValue: { invoke } },
        {
          provide: EventListenersService,
          useValue: {
            listenToMountCacheUpdated: vi.fn().mockReturnValue(mountCacheUpdated),
            listenToRcloneEngineReady: vi.fn().mockReturnValue(engineReady),
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
        { provide: NotificationService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
        { provide: ApiClientService, useValue: { invoke } },
        {
          provide: EventListenersService,
          useValue: {
            listenToMountCacheUpdated: vi.fn().mockReturnValue(mountCacheUpdated),
            listenToRcloneEngineReady: vi.fn().mockReturnValue(engineReady),
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
