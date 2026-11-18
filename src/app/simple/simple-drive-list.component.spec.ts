import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon, MatIconRegistry } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { provideTranslateService, TranslatePipe } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteSettings, MountedRemote } from '@app/types';
import { SimpleWorkspaceComponent } from './simple-workspace.component';
import { SimpleDiskStateComponent } from './simple-disk-state.component';
import { PillDirective } from '../shared/directives/pill.directive';
import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { MountManagementService } from '../services/operations/mount-management.service';
import { JobManagementService } from '../services/operations/job-management.service';
import { ModalService } from '../services/ui/modal.service';
import { NotificationService } from '../services/ui/notification.service';
import { NautilusService } from '../services/ui/nautilus.service';
import { SimpleReorderDirective } from './simple-reorder.directive';
import { SimpleWorkspaceManagementService } from './simple-workspace-management.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { LocalStorageService } from '../services/ui/state/local-storage.service';
import { IconService } from '../services/ui/icon.service';

describe('All connected disks with the actual workspace template', () => {
  const remotes = signal([
    { name: 'Drive', type: 'drive' },
    { name: 'NAS', type: 'sftp' },
    { name: 'Mini', type: 'sftp' },
  ]);
  const mounted = signal<MountedRemote[]>([]);
  const refreshing = signal(false);
  const start = vi.fn(),
    stop = vi.fn(),
    open = vi.fn(),
    save = vi.fn();
  const config = (source: string, point: string, name?: string): RemoteSettings => ({
    mountConfigs: {
      Default: {
        app: name ? { displayName: name } : {},
        rclone: { fs: source, mountPoint: point },
      },
    },
  });
  const settings: Record<string, RemoteSettings> = {
    Drive: config('Drive:', 'Z:'),
    NAS: {
      ...config('NAS:', 'V:'),
      mountConfigs: {
        Default: { rclone: { fs: 'NAS:', mountPoint: 'V:', mountOpt: { NetworkMode: true } } },
        Photos: { app: { displayName: 'Fotky' }, rclone: { fs: 'NAS:photos', mountPoint: 'W:' } },
      },
    },
    Mini: config('Mini:', 'Y:'),
  };
  beforeEach(() => {
    const order = new Map<string, unknown>();
    vi.resetAllMocks();
    remotes.set([
      { name: 'Drive', type: 'drive' },
      { name: 'NAS', type: 'sftp' },
      { name: 'Mini', type: 'sftp' },
    ]);
    refreshing.set(false);
    mounted.set([
      {
        fs: 'Drive:',
        mount_point: 'Z:',
        starter: { kind: 'profile', name: 'Default' },
        settings: { source: 'Drive:', network_mode: false, read_only: false },
      },
      {
        fs: 'NAS:',
        mount_point: 'X:',
        starter: { kind: 'profile', name: 'Default' },
        settings: { source: 'NAS:', network_mode: false, read_only: false },
      },
      { fs: 'Mini:', mount_point: 'Y:', starter: { kind: 'profile', name: 'Default' } },
    ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: SimpleWorkspaceManagementService, useValue: {} },
        { provide: FileSystemService, useValue: {} },
        {
          provide: LocalStorageService,
          useValue: {
            getScoped: (_scope: string, key: string, fallback: unknown): unknown =>
              order.get(key) ?? fallback,
            setScoped: (_scope: string, key: string, value: unknown): Map<string, unknown> =>
              order.set(key, value),
          },
        },
        provideHttpClient(),
        provideTranslateService(),
        {
          provide: RemoteFacadeService,
          useValue: {
            remoteSummaries: remotes,
            loading: signal(false),
            jobs: signal([]),
            getRemoteSettings: (name: string): RemoteSettings => settings[name] ?? {},
            mountedRemotes: mounted,
            runningServes: signal([]),
            isRemoteActive: (name: string): boolean => remotes().some(r => r.name === name),
            startJob: start,
            stopJob: stop,
            openRemoteInFiles: open,
            updateRemoteSettings: save,
          },
        },
        {
          provide: BackendService,
          useValue: {
            activeBackend: (): string => 'Local',
            isWindows: (): boolean => true,
            isLocalBackend: (): boolean => true,
          },
        },
        { provide: MountManagementService, useValue: { refreshing } },
        { provide: JobManagementService, useValue: { getLatestJobForRemote: (): null => null } },
        { provide: ModalService, useValue: {} },
        {
          provide: NotificationService,
          useValue: { confirmModal: vi.fn().mockResolvedValue(false), showError: vi.fn() },
        },
        { provide: NautilusService, useValue: { openBrowserOverlay: vi.fn() } },
        { provide: IconService, useValue: { getIconName: (): string => 'cloud' } },
      ],
    });
    TestBed.overrideComponent(SimpleWorkspaceComponent, {
      set: {
        imports: [
          MatCardModule,
          MatButtonModule,
          MatIcon,
          CdkMenuModule,
          TranslatePipe,
          DatePipe,
          DecimalPipe,
          PillDirective,
          SimpleDiskStateComponent,
          SimpleReorderDirective,
        ],
        schemas: [NO_ERRORS_SCHEMA],
      },
    });
    vi.spyOn(TestBed.inject(MatIconRegistry), 'getNamedSvgIcon').mockImplementation(() =>
      of(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    );
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    delete settings['Drive']['syncConfigs'];
    delete settings['NAS']['copyConfigs'];
    vi.restoreAllMocks();
  });
  function findButton(parent: ParentNode, label: string): HTMLButtonElement {
    const button = Array.from(parent.querySelectorAll('button')).find(
      b =>
        b.textContent?.includes(label) ||
        b.getAttribute('aria-label')?.includes(label) ||
        b.getAttribute('title')?.includes(label)
    );
    if (!button) throw new Error('Missing action: ' + label);
    return button;
  }
  async function create(): Promise<
    ReturnType<typeof TestBed.createComponent<SimpleWorkspaceComponent>>
  > {
    const fixture = TestBed.createComponent(SimpleWorkspaceComponent);
    fixture.componentInstance.navigate('drives');
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }
  it('keeps disconnected compact metadata in text while retaining all mount settings', async () => {
    mounted.set([]);
    const f = TestBed.createComponent(SimpleWorkspaceComponent);
    f.componentInstance.navigate('drives');
    f.detectChanges();
    await f.whenStable();
    const state = f.nativeElement.querySelector('app-simple-disk-state');
    expect(state.querySelectorAll('.app-pill').length).toBe(0);
    expect(state.textContent).toContain('Z:');
    expect(state.textContent).toContain('simple.drives.local');
    expect(state.textContent).toContain('simple.drives.readWrite');
  });
  it('renders all owners and multiple profiles together without selecting a connection or changing configuration', async () => {
    const before = structuredClone(settings);
    const fixture = await create();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.drive-row')).toHaveLength(4);
    expect(element.querySelector('.connection-picker')).toBeNull();
    expect(element.textContent).toContain('Fotky');
    expect(element.querySelector('[aria-label="NAS"]')?.textContent).toContain('X:');
    expect(element.querySelector('[aria-label="NAS"]')?.textContent).toContain('V:');
    expect(element.querySelector('[aria-label="Mini"]')?.textContent).toContain(
      'simple.drives.unknownType'
    );
    expect(settings).toEqual(before);
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('shows only valid connect/disconnect/open actions and edits the clicked owner', async () => {
    const fixture = await create();
    const element = fixture.nativeElement as HTMLElement;
    const drive = element.querySelector('[aria-label="Drive"]') as HTMLElement;
    const photos = element.querySelector('[aria-label="Fotky"]') as HTMLElement;
    expect(drive.textContent).toContain('simple.drives.disconnect');
    expect(drive.textContent).toContain('simple.drives.open');
    expect(photos.textContent).toContain('simple.drives.disconnected');
    expect(photos.textContent).not.toContain('simple.drives.open');
    const button = findButton(photos, 'simple.drives.settings');
    button.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.validEditor()).toMatchObject({
      remote: 'NAS',
      task: { name: 'Photos' },
    });
    expect(start).not.toHaveBeenCalled();
  });
  it('keeps exact disk identity for open and disconnect', async () => {
    const fixture = await create();
    const row = fixture.nativeElement.querySelector('[aria-label="NAS"]') as HTMLElement;
    findButton(row, 'simple.drives.open').click();
    await fixture.whenStable();
    expect(TestBed.inject(NautilusService).openBrowserOverlay).toHaveBeenCalledWith('NAS', '');
    expect(open).not.toHaveBeenCalled();
    findButton(row, 'simple.drives.disconnect').click();
    await fixture.whenStable();
    expect(stop).toHaveBeenCalledWith('NAS', 'mount', undefined, 'Default');
  });
  it('selects the new disk owner from the add menu without mounting', async () => {
    const fixture = await create();
    const add = fixture.nativeElement.querySelector('.page-actions button') as HTMLButtonElement;
    add.click();
    await fixture.whenStable();
    const menu = document.querySelector('.material-context-menu') as HTMLElement;
    findButton(menu, 'Mini').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.validEditor()).toMatchObject({ remote: 'Mini', mount: true });
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('does not claim disconnection or allow power/open actions during refresh', async () => {
    refreshing.set(true);
    const fixture = await create();
    const rows = fixture.nativeElement.querySelectorAll('.drive-row') as NodeListOf<HTMLElement>;
    expect(rows[0].textContent).toContain('simple.drives.refreshing');
    expect(
      Array.from(rows[0].querySelectorAll('button'))
        .filter(
          b =>
            b.textContent?.includes('simple.drives.open') ||
            b.textContent?.includes('simple.drives.disconnect')
        )
        .every(b => b.disabled)
    ).toBe(true);
  });
  it('keeps the no-connection empty state usable', async () => {
    remotes.set([]);
    const fixture = await create();
    expect(fixture.nativeElement.querySelectorAll('.drive-row')).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('simple.connections.first');
  });
  function taskProfiles(): void {
    settings['Drive']['syncConfigs'] = {
      Default: { rclone: { srcFs: 'Drive:' } },
      Cross: {
        app: { simpleCreated: true, backupHistoryDir: 'NAS:history' },
        rclone: { srcFs: 'D:\\Apps', dstFs: 'NAS:mirror' },
      },
    };
    settings['NAS']['copyConfigs'] = {
      Download: {
        app: { simpleCreated: true },
        rclone: { srcFs: 'NAS:photos', dstFs: 'D:\\Photos' },
      },
    };
  }
  it('filters cards by actual source/target, keeps templates separate, and operates on the stored profile owner', async () => {
    taskProfiles();
    const fixture = await create();
    fixture.componentInstance.navigate('tasks');
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.taskConnections().map(r => r.name)).toEqual(['NAS']);
    expect(element.querySelectorAll('.connection-choice')).toHaveLength(1);
    expect(element.querySelectorAll('.task-row')).toHaveLength(2);
    expect(fixture.componentInstance.selected()).toBe('NAS');
    const cross = Array.from(element.querySelectorAll('.task-row')).find(row =>
      row.textContent?.includes('Cross')
    );
    if (!cross) throw new Error('Missing cross-owner task');
    findButton(cross, 'simple.tasks.edit').click();
    fixture.detectChanges();
    expect(fixture.componentInstance.validEditor()?.remote).toBe('Drive');
    expect(fixture.componentInstance.validEditor()?.task?.name).toBe('Cross');
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('offers every connection when creating the first task, even when no selector cards are visible', async () => {
    const fixture = await create();
    fixture.componentInstance.navigate('tasks');
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.connection-choice')).toHaveLength(0);
    findButton(element, 'simple.tasks.add').click();
    fixture.detectChanges();
    await fixture.whenStable();
    const menu = document.querySelector('.material-context-menu') as HTMLElement;
    expect(menu.textContent).toContain('Drive');
    expect(menu.textContent).toContain('NAS');
    expect(menu.textContent).toContain('Mini');
    findButton(menu, 'Mini').click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.validEditor()?.remote).toBe('Mini');
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('reorders live rows from keyboard handles and preserves transfer configuration and selected identity', async () => {
    const before = structuredClone(settings);
    const fixture = await create();
    const element = fixture.nativeElement as HTMLElement;
    const first = element.querySelector('.drive-row') as HTMLElement;
    (first.querySelector('.reorder-handle') as HTMLButtonElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      Array.from(element.querySelectorAll('.drive-row')).map(row => row.getAttribute('aria-label'))
    ).toEqual(['NAS', 'Drive', 'Fotky', 'Mini']);
    fixture.componentInstance.navigate('connections');
    fixture.detectChanges();
    await fixture.whenStable();
    (element.querySelector('.reorder-handle') as HTMLButtonElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.connections().map(r => r.name)).toEqual([
      'NAS',
      'Drive',
      'Mini',
    ]);
    expect(settings).toEqual(before);
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('keeps archive browsing and run records reachable in compact history rows', async () => {
    taskProfiles();
    const fixture = await create();
    fixture.componentInstance.navigate('history');
    fixture.componentInstance.historyView.set('locations');
    fixture.detectChanges();
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.history-navigation .connection-choice')).toHaveLength(3);
    expect(element.querySelectorAll('.history-row')).toHaveLength(1);
    expect(element.textContent).toContain('NAS:history');
    findButton(
      element.querySelector('.history-row') as HTMLElement,
      'simple.manage.browseArchive'
    ).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.validHistory()?.name).toBe('Cross');
    expect(element.querySelector('app-simple-history')).not.toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('hides the last removed task connection and selects a remaining valid card', async () => {
    taskProfiles();
    settings['NAS']['copyConfigs'] = {
      Download: {
        app: { simpleCreated: true },
        rclone: { srcFs: 'Mini:photos', dstFs: 'D:\\Photos' },
      },
    };
    const fixture = await create();
    fixture.componentInstance.navigate('tasks');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.taskConnections().map(r => r.name)).toEqual(['NAS', 'Mini']);
    fixture.componentInstance.selected.set('Mini');
    fixture.detectChanges();
    delete settings['NAS']['copyConfigs'];
    remotes.update(value => [...value]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.taskConnections().map(r => r.name)).toEqual(['NAS']);
    expect(fixture.componentInstance.selected()).toBe('NAS');
    expect(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.connection-choice')
    ).toHaveLength(1);
  });
});
