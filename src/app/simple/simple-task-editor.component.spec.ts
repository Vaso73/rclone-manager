import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { MatIconRegistry } from '@angular/material/icon';
import { provideTranslateService } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SimpleTaskEditorComponent } from './simple-task-editor.component';
import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { WindowsVssService } from '../services/operations/windows-vss.service';
import { MountManagementService } from '../services/operations/mount-management.service';
import { RemoteManagementService } from '../services/remote/remote-management.service';
import { NotificationService } from '../services/ui/notification.service';
import { FilePickerResult } from '@app/types';

describe('Simple editor asynchronous folder selection', () => {
  const picker = vi.fn();
  const backend = signal('Local');
  beforeEach(() => {
    backend.set('Local');
    picker.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideTranslateService(),
        {
          provide: RemoteFacadeService,
          useValue: {
            getRemoteSettings: (): object => ({}),
            mountedRemotes: signal([]),
            isRemoteActive: (): boolean => true,
          },
        },
        {
          provide: BackendService,
          useValue: { activeBackend: backend, isWindows: (): boolean => true },
        },
        { provide: FileSystemService, useValue: { selectPathWithNautilus: picker } },
        {
          provide: WindowsVssService,
          useValue: { refresh: vi.fn(), supported: (): boolean => false },
        },
        { provide: MountManagementService, useValue: { refreshing: signal(false) } },
        { provide: RemoteManagementService, useValue: {} },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
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
  it.each(['source', 'destination', 'history'] as const)(
    'renders %s immediately after async confirmation without another click',
    async field => {
      let complete!: (result: FilePickerResult) => void;
      picker.mockReturnValue(
        new Promise<FilePickerResult>(resolve => {
          complete = resolve;
        })
      );
      const fixture = TestBed.createComponent(SimpleTaskEditorComponent);
      fixture.componentRef.setInput('remote', 'NAS');
      fixture.detectChanges();
      await fixture.whenStable();
      const controls = fixture.nativeElement.querySelectorAll(
        '.path-field button'
      ) as NodeListOf<HTMLButtonElement>;
      controls[['source', 'destination', 'history'].indexOf(field)].click();
      await Promise.resolve();
      complete({ cancelled: false, items: [], paths: ['NAS:Žlté files'] });
      await fixture.whenStable();
      const input = fixture.nativeElement.querySelector(
        'input[name="' + field + '"]'
      ) as HTMLInputElement;
      expect(input.value).toBe('NAS:Žlté files');
      expect(fixture.componentInstance.picking()).toBe(false);
    }
  );
  it('preserves an existing absolute remote source while rejecting a newly entered absolute or different storage', () => {
    const fixture = TestBed.createComponent(SimpleTaskEditorComponent);
    fixture.componentRef.setInput('remote', 'NAS');
    fixture.componentRef.setInput('task', { source: 'NAS:/existing' });
    const editor = fixture.componentInstance;
    editor.draft.operation = 'mount';
    editor.draft.source = 'NAS:/existing';
    expect(editor.sourceError()).toBe(false);
    editor.draft.source = 'NAS:/changed';
    expect(editor.sourceError()).toBe(true);
    editor.draft.source = 'Other:folder';
    expect(editor.sourceError()).toBe(true);
    editor.mountFolder = 'relative/folder';
    expect(editor.draft.source).toBe('NAS:relative/folder');
    expect(editor.sourceError()).toBe(false);
  });

  it('ignores the result after the editor is destroyed', async () => {
    let complete!: (result: FilePickerResult) => void;
    picker.mockReturnValue(
      new Promise<FilePickerResult>(resolve => {
        complete = resolve;
      })
    );
    const fixture = TestBed.createComponent(SimpleTaskEditorComponent);
    fixture.componentRef.setInput('remote', 'NAS');
    fixture.detectChanges();
    await fixture.whenStable();
    const pending = fixture.componentInstance.pick('source');
    fixture.destroy();
    complete({ cancelled: false, items: [], paths: ['NAS:late'] });
    await pending;
    expect(fixture.componentInstance.draft.source).toBe('');
  });
});
