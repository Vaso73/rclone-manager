import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { JobManagementService } from '../services/operations/job-management.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { WindowsVssService } from '../services/operations/windows-vss.service';
import { RemoteFileOperationsService } from '../services/remote/remote-file-operations.service';
import { ModalService } from '../services/ui/modal.service';
import { NotificationService } from '../services/ui/notification.service';
import { NautilusService } from '../services/ui/nautilus.service';
import { RemoteManagementService } from '../services/remote/remote-management.service';
import { IconService } from '../services/ui/icon.service';
import { InterfaceModeService } from './interface-mode.service';
import { SimpleWorkspaceComponent } from './simple-workspace.component';
import { SimpleTaskEditorComponent } from './simple-task-editor.component';
import { SimpleHistoryPlacesService } from './simple-history-places.service';
import { SimpleWorkspaceManagementService } from './simple-workspace-management.service';
import { SimpleHistoryComponent } from './simple-history.component';
import { MountManagementService } from '../services/operations/mount-management.service';
import { JobInfo } from '@app/types';
import { SimpleTask } from './simple-profile.util';

describe('simple workspace actions', () => {
  const activeBackend = signal('Local');
  const settings = {
    syncConfigs: {
      Backup: {
        app: { filterProfile: 'Custom' },
        rclone: { srcFs: 'D:\\Apps', dstFs: 'NAS:mirror' },
      },
    },
  };
  const task: SimpleTask = {
    remote: 'NAS',
    name: 'Backup',
    operation: 'sync',
    source: 'D:\\Apps',
    destination: 'NAS:mirror',
    history: 'NAS:history',
    multipleSources: false,
    config: settings.syncConfigs.Backup,
  };
  const startProfileBatch = vi.fn(),
    startJob = vi.fn(),
    save = vi.fn(),
    confirm = vi.fn(),
    transfer = vi.fn();
  const selectFolder = vi.fn(),
    selectPath = vi.fn(),
    list = vi.fn(),
    refresh = vi.fn(),
    enable = vi.fn();
  const mounted = signal<
    { fs: string; mount_point: string; starter?: { kind: 'profile'; name: string } }[]
  >([]);
  const collision = vi.fn();
  const localDrives = vi.fn();
  const stopJob = vi.fn();
  const reconnect = vi.fn();
  const removeProfile = vi.fn();
  const restoreHistory = vi.fn();
  const inspectConnection = vi.fn();
  const removeConnection = vi.fn();
  const removeRecord = vi.fn();
  const refreshAll = vi.fn();
  const refreshMounts = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    activeBackend.set('Local');
    mounted.set([]);
    reconnect.mockResolvedValue(undefined);
    refreshMounts.mockResolvedValue([]);
    collision.mockReturnValue([]);
    localDrives.mockResolvedValue([
      { name: 'C:', mount_point: 'C:' },
      { name: 'D:', mount_point: 'D:' },
    ]);
    confirm.mockResolvedValue(true);
    startProfileBatch.mockResolvedValue(1);
    startJob.mockResolvedValue(undefined);
    save.mockResolvedValue(undefined);
    selectFolder.mockResolvedValue('D:\\Recovered');
    selectPath.mockResolvedValue({ cancelled: false, paths: ['D:\\Selected'] });
    list.mockResolvedValue({ list: [] });
    transfer.mockResolvedValue('started');
    restoreHistory.mockResolvedValue({
      jobId: 1,
      destination: 'D:\\Recovered\\verzie.txt',
      size: 16,
      hashType: null,
    });
    inspectConnection.mockResolvedValue({ revision: 'revision', dependencies: [] });
    removeConnection.mockResolvedValue(undefined);
    removeRecord.mockResolvedValue(undefined);
    refreshAll.mockResolvedValue(undefined);
    refresh.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SimpleWorkspaceManagementService,
          useValue: { restoreHistory, inspectConnection, removeConnection, removeRecord },
        },
        {
          provide: MountManagementService,
          useValue: {
            reconnectRemoteProfile: reconnect,
            getMountedRemotes: refreshMounts,
            refreshing: signal(false),
          },
        },
        { provide: RemoteManagementService, useValue: { getLocalDrives: localDrives } },
        { provide: IconService, useValue: { getIconName: (): string => 'cloud' } },
        {
          provide: BackendService,
          useValue: {
            activeBackend,
            isWindows: (): boolean => true,
            isLocalBackend: (): boolean => true,
          },
        },
        {
          provide: RemoteFacadeService,
          useValue: {
            refreshAll,
            loading: signal(false),
            jobs: signal([]),
            remoteSummaries: signal([{ name: 'NAS', type: 'sftp' }]),
            getRemoteSettings: (): typeof settings => settings,
            isRemoteActive: (): boolean => true,
            updateRemoteSettings: save,
            deleteTaskProfile: removeProfile,
            openRemoteInFiles: vi.fn().mockResolvedValue(undefined),
            startJob,
            stopJob,
            checkMountPathCollision: collision,
            mountedRemotes: mounted,
            runningServes: signal([]),
          },
        },
        {
          provide: JobManagementService,
          useValue: { startProfileBatch, getLatestJobForRemote: (): null => null },
        },
        {
          provide: NotificationService,
          useValue: { confirmModal: confirm, showError: vi.fn(), showSuccess: vi.fn() },
        },
        {
          provide: FileSystemService,
          useValue: { selectFolder, selectPathWithNautilus: selectPath },
        },
        {
          provide: RemoteFileOperationsService,
          useValue: { getRemotePaths: list, transferItems: transfer },
        },
        {
          provide: WindowsVssService,
          useValue: {
            refresh,
            enable,
            supported: (): boolean => true,
            status: signal({ ready: true }),
            pending: (): boolean => false,
          },
        },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
        {
          provide: ModalService,
          useValue: {
            openQuickAddRemote: (): { afterClosed: () => Observable<string> } => ({
              afterClosed: (): Observable<string> => of('NAS'),
            }),
          },
        },
        { provide: NautilusService, useValue: { openBrowserOverlay: vi.fn() } },
        { provide: InterfaceModeService, useValue: { setMode: vi.fn() } },
      ],
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('navigates in the agreed order and never mounts implicitly', () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    expect(c.pages.map(p => p.key)).toEqual(['connections', 'drives', 'tasks', 'history']);
    c.navigate('tasks');
    expect(c.page()).toBe('tasks');
    expect(startJob).not.toHaveBeenCalled();
    expect(startProfileBatch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('compares without confirmation, global changes or mounting', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.run(task, true);
    expect(startProfileBatch).toHaveBeenCalledExactlyOnceWith('Sync', {
      remoteName: 'NAS',
      profileName: 'Backup',
      source: 'dashboard',
      backendName: 'Local',
      dryRun: true,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
  });
  it('passes an explicit real-run override only after confirmation', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.run(task, false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(startProfileBatch).toHaveBeenCalledWith(
      'Sync',
      expect.objectContaining({ dryRun: false })
    );
  });
  it('does not start a cancelled real run', async () => {
    confirm.mockResolvedValue(false);
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.run(task, false);
    expect(startProfileBatch).not.toHaveBeenCalled();
    expect(c.pending()).toBe(false);
  });
  it('rejects late confirmation after changing backend', async () => {
    confirm.mockImplementation(async () => {
      activeBackend.set('Other');
      return true;
    });
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.run(task, false);
    expect(startProfileBatch).not.toHaveBeenCalled();
  });
  it('serializes double clicks while confirmation is pending', async () => {
    let answer: (value: boolean) => void = () => {
      throw new Error('not initialized');
    };
    confirm.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          answer = resolve;
        })
    );
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    const first = c.run(task, false);
    await c.run(task, false);
    answer(true);
    await first;
    expect(startProfileBatch).toHaveBeenCalledTimes(1);
  });
  it('continues after adding a connection without starting a disk or task', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.addConnection();
    expect(c.page()).toBe('drives');
    expect(c.selected()).toBe('NAS');
    expect(startJob).not.toHaveBeenCalled();
    expect(startProfileBatch).not.toHaveBeenCalled();
  });

  it('deletes only the confirmed task identity and never runs file operations', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.remove(task);
    expect(removeProfile).toHaveBeenCalledExactlyOnceWith(
      'NAS',
      'sync',
      'Backup',
      task.config,
      'Local'
    );
    expect(transfer).not.toHaveBeenCalled();
    expect(startProfileBatch).not.toHaveBeenCalled();
  });
  it('does not delete after cancellation or a backend switch during confirmation', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    confirm.mockResolvedValueOnce(false);
    await c.remove(task);
    expect(removeProfile).not.toHaveBeenCalled();
    confirm.mockImplementationOnce(async () => {
      activeBackend.set('Other');
      return true;
    });
    await c.remove(task);
    expect(removeProfile).not.toHaveBeenCalled();
  });
  it('marks only retained roots with missing connections unavailable, without dropping local archives', () => {
    const store = TestBed.inject(SimpleHistoryPlacesService);
    store.add('Local', 'Retained', 'Removed:history', 'Removed');
    store.add('Local', 'Local archive', 'D:\\History', 'Local');
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    expect(c.historyPlaces().find(place => place.name === 'Retained')?.unavailable).toBe(true);
    expect(c.historyPlaces().find(place => place.name === 'Local archive')?.unavailable).toBe(
      false
    );
  });
  it('inspects connections and refuses in-use, cancelled and stale removals', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    inspectConnection.mockResolvedValue({
      revision: 'x',
      dependencies: [{ kind: 'profile', name: 'NAS / copyConfigs / Backup' }],
    });
    await c.removeConnection('NAS');
    expect(JSON.stringify(confirm.mock.calls)).not.toContain('copyConfigs');
    expect(removeConnection).not.toHaveBeenCalled();
    inspectConnection.mockResolvedValue({ revision: 'x', dependencies: [] });
    confirm.mockResolvedValue(false);
    await c.removeConnection('NAS');
    expect(removeConnection).not.toHaveBeenCalled();
    confirm.mockImplementation(async () => {
      activeBackend.set('Other');
      return true;
    });
    await c.removeConnection('NAS');
    expect(removeConnection).not.toHaveBeenCalled();
  });
  it('removes only an unused connection with its reviewed backend and revision', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.removeConnection('NAS');
    expect(removeConnection).toHaveBeenCalledExactlyOnceWith('NAS', 'Local', 'revision');
    expect(refreshAll).toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });
  it('rejects invalid history before persisting or starting anything', async () => {
    const c = await editorFixture();
    c.draft.history = 'D:\\';
    await c.save();
    expect(c.error()).toBe('backendErrors.backup.historySameFilesystem');
    expect(save).not.toHaveBeenCalled();
    expect(startProfileBatch).not.toHaveBeenCalled();
  });
  async function editorFixture(multipleSources = false): Promise<SimpleTaskEditorComponent> {
    TestBed.overrideComponent(SimpleTaskEditorComponent, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(SimpleTaskEditorComponent);
    fixture.componentRef.setInput('remote', 'NAS');
    fixture.componentRef.setInput('task', { ...task, multipleSources });
    fixture.detectChanges();
    return fixture.componentInstance;
  }
  it('saves only the chosen profile and does not enable VSS or start a task', async () => {
    const c = await editorFixture();
    await c.save();
    expect(save).toHaveBeenCalledWith(
      'NAS',
      expect.objectContaining({
        syncConfigs: expect.objectContaining({
          Backup: expect.objectContaining({
            app: expect.objectContaining({ filterProfile: 'Custom' }),
          }),
        }),
      })
    );
    expect(enable).not.toHaveBeenCalled();
    expect(startProfileBatch).not.toHaveBeenCalled();
  });
  it('blocks editing multiple sources rather than flattening them', async () => {
    const c = await editorFixture(true);
    await c.save();
    expect(save).not.toHaveBeenCalled();
    expect(c.error()).toBe('simple.tasks.complex');
  });
  it('blocks saving after changing backend', async () => {
    const c = await editorFixture();
    activeBackend.set('Other');
    await c.save();
    expect(save).not.toHaveBeenCalled();
  });
  it('does not save a stale folder-picker result', async () => {
    const c = await editorFixture();
    selectPath.mockImplementation(async () => {
      activeBackend.set('Other');
      return { cancelled: false, paths: ['Other:path'] };
    });
    await c.pick('source');
    expect(c.draft.source).toBe(task.source);
  });

  const disk: SimpleTask = {
    ...task,
    name: 'Disk',
    operation: 'mount',
    source: 'NAS:',
    destination: 'Z:',
    config: { rclone: { fs: 'NAS:', mountPoint: 'Z:' }, app: { autoStart: true } },
  };
  async function diskEditor(): Promise<SimpleTaskEditorComponent> {
    TestBed.overrideComponent(SimpleTaskEditorComponent, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(SimpleTaskEditorComponent);
    fixture.componentRef.setInput('remote', 'NAS');
    fixture.componentRef.setInput('task', disk);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.componentInstance;
  }
  it('keeps active or previously used default profiles out of unused templates', () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    const candidate: SimpleTask = {
      ...task,
      name: 'Default',
      operation: 'serve',
      source: 'NAS:',
      destination: '',
      history: '',
      config: { app: {}, rclone: { fs: 'NAS:' } },
    };
    const active = vi.spyOn(c, 'active').mockReturnValue(false);
    const latest = vi.spyOn(c, 'latest').mockReturnValue(null);
    expect(c.isUnusedTemplate(candidate)).toBe(true);
    active.mockReturnValue(true);
    expect(c.isUnusedTemplate(candidate)).toBe(false);
    active.mockReturnValue(false);
    latest.mockReturnValue({ status: 'Completed' } as JobInfo);
    expect(c.isUnusedTemplate(candidate)).toBe(false);
  });

  it('never starts an incomplete task, even if invoked outside the disabled button', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.run({ ...task, destination: ' ' }, false);
    await c.run({ ...task, source: '' }, true);
    expect(confirm).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
    expect(startProfileBatch).not.toHaveBeenCalled();
  });
  it('opens the actual running disk root rather than a pending letter', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    mounted.set([
      { fs: 'NAS:live', mount_point: 'X:', starter: { kind: 'profile', name: 'Disk' } },
    ]);
    await c.openDisk({ ...disk, destination: 'Y:' });
    expect(TestBed.inject(RemoteFacadeService).openRemoteInFiles).toHaveBeenCalledWith(
      'NAS',
      'X:\\',
      'Disk',
      'mount'
    );
    expect(startJob).not.toHaveBeenCalled();
    expect(stopJob).not.toHaveBeenCalled();
  });
  it('does not open a disconnected disk or act while pending/refreshing', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    await c.openDisk(disk);
    mounted.set([{ fs: 'NAS:', mount_point: 'X:', starter: { kind: 'profile', name: 'Disk' } }]);
    c.pending.set(true);
    await c.openDisk(disk);
    c.pending.set(false);
    vi.spyOn(c.mounts, 'refreshing').mockReturnValue(true);
    await c.openDisk(disk);
    expect(TestBed.inject(RemoteFacadeService).openRemoteInFiles).not.toHaveBeenCalled();
  });
  it('opens the applied source in the web browser without relying on a cached local drive root', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', undefined);
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    mounted.set([
      { fs: 'NAS:live', mount_point: 'X:', starter: { kind: 'profile', name: 'Disk' } },
    ]);
    await c.openDisk({ ...disk, source: 'NAS:pending' });
    expect(TestBed.inject(NautilusService).openBrowserOverlay).toHaveBeenCalledWith('NAS', 'live');
    expect(TestBed.inject(RemoteFacadeService).openRemoteInFiles).not.toHaveBeenCalled();
  });
  it('opens the applied source in the integrated browser for a remote backend', async () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    vi.spyOn(c.backend, 'isLocalBackend').mockReturnValue(false);
    mounted.set([
      { fs: 'NAS:live', mount_point: 'X:', starter: { kind: 'profile', name: 'Disk' } },
    ]);
    await c.openDisk({ ...disk, source: 'NAS:pending' });
    expect(TestBed.inject(NautilusService).openBrowserOverlay).toHaveBeenCalledWith('NAS', 'live');
    expect(TestBed.inject(RemoteFacadeService).openRemoteInFiles).not.toHaveBeenCalled();
  });
  it('edits the clicked owner and labels defaults without changing the profile', () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    c.page.set('drives');
    c.selected.set('Other');
    c.edit(disk);
    expect(c.validEditor()?.remote).toBe('NAS');
    expect(c.driveLabel({ ...disk, name: 'Default', config: {} })).toBe('NAS');
    expect(c.driveLabel({ ...disk, name: 'default', config: {} })).toBe('NAS');
    expect(c.driveLabel({ ...disk, config: { app: { displayName: 'My disk' } } })).toBe('My disk');
    expect(disk.name).toBe('Disk');
    expect(save).not.toHaveBeenCalled();
  });
  it('adds a disk only for an existing connection without mounting or saving', () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    c.page.set('drives');
    c.addDisk('NAS');
    expect(c.validEditor()).toMatchObject({ remote: 'NAS', mount: true });
    expect(save).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
  });
  it('keeps an existing disk active after editing its desired next letter, scoped to remote and profile', () => {
    const c = TestBed.runInInjectionContext(() => new SimpleWorkspaceComponent());
    mounted.set([{ fs: 'Other:', mount_point: 'Z:', starter: { kind: 'profile', name: 'Disk' } }]);
    expect(c.active(disk)).toBe(false);
    mounted.set([
      { fs: 'NAS:path', mount_point: 'Y:', starter: { kind: 'profile', name: 'Disk' } },
    ]);
    expect(c.active(disk)).toBe(true);
    expect(c.mount(disk)?.mount_point).toBe('Y:');
    c.page.set('drives');
    c.edit(disk);
    expect(c.validEditor()?.task).toBe(disk);
    expect(startJob).not.toHaveBeenCalled();
    expect(stopJob).not.toHaveBeenCalled();
  });
  it('saves a connected disk letter, local/network mode, read-only and startup without disconnecting', async () => {
    mounted.set([{ fs: 'NAS:', mount_point: 'Z:', starter: { kind: 'profile', name: 'Disk' } }]);
    const c = await diskEditor();
    expect(c.letterUnavailable('C:')).toBe(true);
    expect(c.letterUnavailable('Z:')).toBe(false);
    c.draft.destination = 'Y:';
    c.draft.networkDrive = true;
    c.draft.readOnly = true;
    await c.save();
    expect(save).toHaveBeenCalledWith(
      'NAS',
      expect.objectContaining({
        mountConfigs: {
          Disk: expect.objectContaining({
            app: expect.objectContaining({ autoStart: true }),
            rclone: expect.objectContaining({
              mountPoint: 'Y:',
              mountOpt: { NetworkMode: true },
              vfsOpt: { ReadOnly: true },
            }),
          }),
        },
      })
    );
    expect(stopJob).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
    expect(startProfileBatch).not.toHaveBeenCalled();
  });
  it('blocks an occupied drive, a configured collision and an unavailable inventory without saving', async () => {
    const c = await diskEditor();
    c.draft.destination = 'C:';
    await c.save();
    expect(c.error()).toBe('simple.errors.drive');
    c.draft.destination = 'Y:';
    collision.mockReturnValue([{}]);
    await c.save();
    expect(c.error()).toBe('simple.errors.driveCollision');
    collision.mockReturnValue([]);
    localDrives.mockRejectedValue(new Error('offline'));
    await c.loadDrives();
    await c.save();
    expect(c.error()).toBe('simple.errors.drive');
    expect(save).not.toHaveBeenCalled();
    expect(stopJob).not.toHaveBeenCalled();
  });
  it('blocks a drive used by another live mount even when absent from OS inventory', async () => {
    mounted.set([{ fs: 'Other:', mount_point: 'Y:' }]);
    const c = await diskEditor();
    c.draft.destination = 'Y:';
    await c.save();
    expect(c.error()).toBe('simple.errors.driveCollision');
    expect(save).not.toHaveBeenCalled();
  });

  it('save for later never invokes reconnect, mount or unmount', async () => {
    mounted.set([{ fs: 'NAS:', mount_point: 'Z:', starter: { kind: 'profile', name: 'Disk' } }]);
    const c = await diskEditor();
    c.draft.destination = 'W:';
    await c.save(false);
    expect(save).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
    expect(stopJob).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
  });
  it('saves before reconnecting exactly the captured profile and mount, without a global stop/start', async () => {
    const active = {
      fs: 'NAS:',
      mount_point: 'Z:',
      starter: { kind: 'profile' as const, name: 'Disk' },
    };
    mounted.set([active]);
    const c = await diskEditor();
    c.draft.destination = 'W:';
    const calls: string[] = [];
    save.mockImplementation(async () => {
      calls.push('save');
    });
    reconnect.mockImplementation(async () => {
      calls.push('reconnect');
    });
    await c.save(true);
    expect(calls).toEqual(['save', 'reconnect']);
    expect(reconnect).toHaveBeenCalledExactlyOnceWith('NAS', 'Disk', active, 'Local');
    expect(refreshMounts).toHaveBeenCalledTimes(1);
    expect(stopJob).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
  });
  it('never reconnects after a failed save or a backend switch during saving', async () => {
    mounted.set([{ fs: 'NAS:', mount_point: 'Z:', starter: { kind: 'profile', name: 'Disk' } }]);
    const c = await diskEditor();
    save.mockRejectedValueOnce(new Error('disk full'));
    await c.save(true);
    expect(reconnect).not.toHaveBeenCalled();
    save.mockImplementation(async () => {
      activeBackend.set('Other');
    });
    await c.save(true);
    expect(reconnect).not.toHaveBeenCalled();
  });
  it('leaves saved settings and the editor available after reconnection failure and blocks double clicks', async () => {
    mounted.set([{ fs: 'NAS:', mount_point: 'Z:', starter: { kind: 'profile', name: 'Disk' } }]);
    const c = await diskEditor();
    let fail: (reason: Error) => void = () => {
      throw new Error('not initialized');
    };
    reconnect.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        })
    );
    const first = c.save(true);
    await Promise.resolve();
    await Promise.resolve();
    await c.save(true);
    fail(new Error('busy'));
    await first;
    expect(save).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(c.error()).toBe('simple.drives.savedApplyFailed');
    expect(c.busy()).toBe(false);
    expect(mounted()[0].mount_point).toBe('Z:');
    expect(startJob).not.toHaveBeenCalled();
    expect(stopJob).not.toHaveBeenCalled();
  });
  async function historyFixture(): Promise<SimpleHistoryComponent> {
    TestBed.overrideComponent(SimpleHistoryComponent, { set: { template: '', imports: [] } });
    const fixture = TestBed.createComponent(SimpleHistoryComponent);
    fixture.componentRef.setInput('task', task);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.componentInstance;
  }
  const entry = {
    ID: '',
    IsDir: false,
    MimeType: 'text/plain',
    ModTime: '2026-11-17T08:30:27Z',
    Name: 'verzie_2026-11-17_08-30-27.066.txt',
    Path: 'ignored-server-path',
    Size: 16,
  };
  it('restores by copy under the original name and preserves the archive', async () => {
    const c = await historyFixture();
    await c.restore(entry);
    expect(restoreHistory).toHaveBeenCalledExactlyOnceWith({
      backendName: 'Local',
      root: 'NAS:history',
      path: entry.Name,
      name: 'verzie.txt',
      destination: 'D:\\Recovered',
      size: 16,
      modified: entry.ModTime,
    });
    expect(transfer).not.toHaveBeenCalled();
  });
  it('never restores a traversal path', async () => {
    const c = await historyFixture();
    await c.restore({ ...entry, Name: '../outside' });
    expect(selectFolder).not.toHaveBeenCalled();
    expect(restoreHistory).not.toHaveBeenCalled();
  });
  it('does not restore after cancellation or a backend change', async () => {
    const c = await historyFixture();
    confirm.mockResolvedValue(false);
    await c.restore(entry);
    expect(restoreHistory).not.toHaveBeenCalled();
    confirm.mockImplementation(async () => {
      activeBackend.set('Other');
      return true;
    });
    await c.restore(entry);
    expect(restoreHistory).not.toHaveBeenCalled();
  });
});
