import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { JobManagementService } from '../services/operations/job-management.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { WindowsVssService } from '../services/operations/windows-vss.service';
import { RemoteFileOperationsService } from '../services/remote/remote-file-operations.service';
import { ModalService } from '../services/ui/modal.service';
import { NotificationService } from '../services/ui/notification.service';
import { NautilusService } from '../services/ui/nautilus.service';
import { InterfaceModeService } from './interface-mode.service';
import { SimpleWorkspaceComponent } from './simple-workspace.component';
import { SimpleTaskEditorComponent } from './simple-task-editor.component';
import { SimpleHistoryComponent } from './simple-history.component';
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
  const mounted = signal<{ fs: string; mount_point: string }[]>([]);
  beforeEach(() => {
    vi.resetAllMocks();
    activeBackend.set('Local');
    mounted.set([]);
    confirm.mockResolvedValue(true);
    startProfileBatch.mockResolvedValue(1);
    startJob.mockResolvedValue(undefined);
    save.mockResolvedValue(undefined);
    selectFolder.mockResolvedValue('D:\\Recovered');
    selectPath.mockResolvedValue({ cancelled: false, paths: ['D:\\Selected'] });
    list.mockResolvedValue({ list: [] });
    transfer.mockResolvedValue('started');
    refresh.mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: BackendService, useValue: { activeBackend, isWindows: (): boolean => true } },
        {
          provide: RemoteFacadeService,
          useValue: {
            remoteSummaries: signal([{ name: 'NAS', type: 'sftp' }]),
            getRemoteSettings: (): typeof settings => settings,
            isRemoteActive: (): boolean => true,
            updateRemoteSettings: save,
            startJob,
            stopJob: vi.fn(),
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
    expect(transfer).toHaveBeenCalledExactlyOnceWith(
      [{ remote: 'NAS:history', path: entry.Name, name: 'verzie.txt', isDir: false }],
      'D:\\Recovered',
      '',
      'copy',
      'dashboard'
    );
  });
  it('never restores a traversal path', async () => {
    const c = await historyFixture();
    await c.restore({ ...entry, Name: '../outside' });
    expect(selectFolder).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });
  it('does not restore after cancellation or a backend change', async () => {
    const c = await historyFixture();
    confirm.mockResolvedValue(false);
    await c.restore(entry);
    expect(transfer).not.toHaveBeenCalled();
    confirm.mockImplementation(async () => {
      activeBackend.set('Other');
      return true;
    });
    await c.restore(entry);
    expect(transfer).not.toHaveBeenCalled();
  });
});
