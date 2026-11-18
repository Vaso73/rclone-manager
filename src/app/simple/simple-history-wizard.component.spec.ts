import { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { MatIconRegistry } from '@angular/material/icon';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createMinimalEntry } from '@app/types';
import { SimpleHistoryWizardComponent } from './simple-history-wizard.component';
import { SimpleWorkspaceManagementService } from './simple-workspace-management.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { NotificationService } from '../services/ui/notification.service';
import { RemoteFileOperationsService } from '../services/remote/remote-file-operations.service';
import { HistoryPlace } from './simple-history-places.service';
import { historyVersion } from './simple-history-search.util';

describe('History wizard actual template and asynchronous actions', () => {
  const backend = signal('Local'),
    list = vi.fn(),
    picker = vi.fn(),
    confirm = vi.fn(),
    restore = vi.fn();
  const place: HistoryPlace = {
    id: 'place',
    name: 'Backup',
    owner: 'NAS',
    root: 'NAS:history',
    hidden: false,
  };
  const entry = {
    ...createMinimalEntry('file_2026-11-18_08-30-27.066.txt'),
    Size: 16,
    ModTime: '2026-11-18T08:00:00Z',
  };
  beforeEach(() => {
    backend.set('Local');
    vi.resetAllMocks();
    confirm.mockResolvedValue(true);
    list.mockResolvedValue({ list: [entry] });
    picker.mockResolvedValue('D:\\Restored');
    restore.mockResolvedValue({
      jobId: 7,
      destination: 'D:\\Restored\\file.txt',
      size: 16,
      hashType: 'md5',
    });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideTranslateService(),
        { provide: BackendService, useValue: { activeBackend: backend } },
        { provide: FileSystemService, useValue: { selectFolder: picker, openInFiles: vi.fn() } },
        { provide: NotificationService, useValue: { confirmModal: confirm, showError: vi.fn() } },
        { provide: RemoteFileOperationsService, useValue: { getRemotePaths: list } },
        { provide: SimpleWorkspaceManagementService, useValue: { restoreHistory: restore } },
      ],
    });
    vi.spyOn(TestBed.inject(MatIconRegistry), 'getNamedSvgIcon').mockImplementation(() =>
      of(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    );
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });
  async function fixture(): Promise<ComponentFixture<SimpleHistoryWizardComponent>> {
    const f = TestBed.createComponent(SimpleHistoryWizardComponent);
    f.componentRef.setInput('places', [place]);
    f.detectChanges();
    await f.whenStable();
    return f;
  }
  async function ready(): Promise<ComponentFixture<SimpleHistoryWizardComponent>> {
    const f = await fixture(),
      c = f.componentInstance;
    const version = historyVersion(entry, 'Apps');
    if (!version) throw new Error('Invalid test version');
    c.versions.set([version]);
    c.selectedFile.set('Apps/file.txt');
    c.selectedPath.set('Apps/' + entry.Name);
    c.step.set(3);
    await f.whenStable();
    return f;
  }
  it('does not list or restore on opening; search reads only the explicitly selected archive', async () => {
    const f = await fixture(),
      c = f.componentInstance;
    expect(list).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    c.query = 'file';
    await c.search();
    expect(list).toHaveBeenCalledExactlyOnceWith('NAS:history', '', {}, 'dashboard');
    expect(c.filesFound()).toEqual(['file.txt']);
  });
  it('keeps a retained missing connection visible but cannot search or restore through it', async () => {
    const f = await ready(),
      c = f.componentInstance;
    f.componentRef.setInput('places', [{ ...place, unavailable: true }]);
    c.step.set(0);
    f.detectChanges();
    await f.whenStable();
    expect(f.nativeElement.textContent).toContain('simple.manage.missingConnectionHelp');
    c.step.set(0);
    c.next();
    expect(c.step()).toBe(0);
    c.query = 'file';
    await c.search();
    c.destination.set('D:\\Restored');
    await c.restore();
    expect(confirm).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });
  it('renders native picker result immediately without another click', async () => {
    let complete!: (path: string) => void;
    picker.mockReturnValue(new Promise<string>(resolve => (complete = resolve)));
    const f = await ready();
    (f.nativeElement.querySelector('.search-controls button') as HTMLButtonElement).click();
    await Promise.resolve();
    complete('D:\\Žlté obnovené');
    await f.whenStable();
    expect((f.nativeElement.querySelector('input') as HTMLInputElement).value).toBe(
      'D:\\Žlté obnovené'
    );
  });
  it('keeps the destination on picker cancel and ignores backend changes', async () => {
    const f = await ready(),
      c = f.componentInstance;
    c.destination.set('D:\\Keep');
    picker.mockResolvedValue('');
    await c.chooseDestination();
    expect(c.destination()).toBe('D:\\Keep');
    picker.mockImplementation(async () => {
      backend.set('Other');
      return 'D:\\Stale';
    });
    await c.chooseDestination();
    expect(c.destination()).toBe('D:\\Keep');
  });
  it('cancelled confirmation performs no restore command', async () => {
    const f = await ready(),
      c = f.componentInstance;
    c.destination.set('D:\\Restored');
    confirm.mockResolvedValue(false);
    await c.restore();
    expect(restore).not.toHaveBeenCalled();
    expect(c.result()).toBeNull();
    expect(c.restoring()).toBe(false);
  });
  it('does not display success before completion and sends the exact selected version', async () => {
    let complete!: (value: unknown) => void;
    restore.mockReturnValue(new Promise(resolve => (complete = resolve)));
    const f = await ready(),
      c = f.componentInstance;
    c.destination.set('D:\\Restored');
    const pending = c.restore();
    await Promise.resolve();
    await Promise.resolve();
    expect(c.result()).toBeNull();
    expect(c.restoring()).toBe(true);
    complete({ jobId: 7, destination: 'D:\\Restored\\file (1).txt', size: 16, hashType: null });
    await pending;
    await f.whenStable();
    expect(restore).toHaveBeenCalledWith({
      backendName: 'Local',
      root: 'NAS:history',
      path: 'Apps/' + entry.Name,
      name: 'file.txt',
      destination: 'D:\\Restored',
      size: 16,
      modified: entry.ModTime,
    });
    expect(f.nativeElement.textContent).toContain('file (1).txt');
  });
  it('restores only to the destination shown in confirmation, even if state changes while pending', async () => {
    const f = await ready(),
      c = f.componentInstance;
    c.destination.set('D:\\Confirmed');
    confirm.mockImplementation(async () => {
      c.destination.set('D:\\Changed');
      return true;
    });
    await c.restore();
    expect(restore.mock.calls[0][0].destination).toBe('D:\\Confirmed');
  });
  it('backend change during confirmation cannot write a different backend', async () => {
    const f = await ready(),
      c = f.componentInstance;
    c.destination.set('D:\\Restored');
    confirm.mockImplementation(async () => {
      backend.set('Other');
      return true;
    });
    await c.restore();
    expect(restore).not.toHaveBeenCalled();
  });
  it('can restore another version after returning from a completed copy without stale success', async () => {
    const f = await ready(),
      c = f.componentInstance;
    c.destination.set('D:\\Restored');
    await c.restore();
    expect(c.result()).not.toBeNull();
    c.back();
    await f.whenStable();
    expect(c.result()).toBeNull();
    expect(c.partial()).toBe(false);
    c.next();
    await f.whenStable();
    expect(
      (f.nativeElement.querySelector('.wizard-actions button:last-child') as HTMLButtonElement)
        .disabled
    ).toBe(false);
    await c.restore();
    expect(restore).toHaveBeenCalledTimes(2);
  });
  it('resets old file choices for another archive and reports cancellation even before finding a file', async () => {
    const f = await ready(),
      c = f.componentInstance;
    c.choosePlace(place.id);
    expect(c.selectedFile()).toBe('');
    expect(c.selectedPath()).toBe('');
    expect(c.searched()).toBe(false);
    expect(c.partial()).toBe(false);
    c.busy.set(true);
    c.cancelSearch();
    expect(c.partial()).toBe(true);
  });
  it('failed restore never claims success', async () => {
    const f = await ready(),
      c = f.componentInstance;
    c.destination.set('D:\\Restored');
    restore.mockRejectedValue(new Error('checksum'));
    await c.restore();
    expect(c.result()).toBeNull();
    expect(c.error()).toBe('simple.manage.restoreFailed');
  });
});
