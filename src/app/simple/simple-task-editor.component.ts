import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  DestroyRef,
  Component,
  OnInit,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MountedRemote, REMOTE_CONFIG_KEYS } from '@app/types';
import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { WindowsVssService } from '../services/operations/windows-vss.service';
import { MountManagementService } from '../services/operations/mount-management.service';
import { simpleHistoryError } from './simple-history-path.util';
import { SimpleDiskStateComponent } from './simple-disk-state.component';
import { RemoteManagementService } from '../services/remote/remote-management.service';
import { NotificationService } from '../services/ui/notification.service';
import { getAppCfg, getRcloneCfg } from '../shared/utils/profile-config.util';
import {
  SIMPLE_OPERATIONS,
  SimpleOperation,
  SimpleTask,
  SimpleTaskDraft,
  patchSimpleProfile,
  simpleSchedule,
  simpleMountOptions,
  simpleTaskMount,
  patchSimpleMountVfs,
  simpleMountPending,
  simpleVolumeName,
  splitSimplePath,
} from './simple-profile.util';

@Component({
  selector: 'app-simple-task-editor',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIcon,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    TranslatePipe,
    SimpleDiskStateComponent,
  ],
  templateUrl: './simple-task-editor.component.html',
  styleUrl: './simple-task-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimpleTaskEditorComponent implements OnInit {
  readonly facade = inject(RemoteFacadeService);
  readonly vss = inject(WindowsVssService);
  readonly backend = inject(BackendService);
  private readonly files = inject(FileSystemService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  readonly picking = signal(false);
  get mountFolder(): string {
    return splitSimplePath(this.draft.source).path;
  }
  set mountFolder(path: string) {
    this.draft.source = this.remote() + ':' + path;
  }
  historyError(): string {
    return ['sync', 'copy', 'move'].includes(this.draft.operation)
      ? simpleHistoryError(
          this.draft.source,
          this.draft.destination,
          this.draft.history,
          this.backend.isWindows()
        )
      : '';
  }
  sourceError(): boolean {
    if (this.draft.operation !== 'mount') return false;
    const path = splitSimplePath(this.draft.source);
    return (
      path.remote !== this.remote() ||
      (/^[\\/]/.test(path.path) && this.draft.source !== this.task()?.source) ||
      path.path.split(/[\\/]/).includes('..')
    );
  }
  private pickerRequest = 0;
  private readonly remotes = inject(RemoteManagementService);
  readonly mounts = inject(MountManagementService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  readonly remote = input.required<string>();
  readonly task = input<SimpleTask>();
  readonly operation = input<SimpleOperation>('sync');
  readonly saved = output<void>();
  readonly cancelled = output<void>();
  readonly operations = SIMPLE_OPERATIONS.filter(op => op !== 'mount');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly applying = signal(false);
  private scope = '';
  readonly driveLetters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(90 - i) + ':');
  readonly occupiedLetters = signal<string[]>([]);
  readonly checkingDrives = signal(false);
  readonly drivesUnavailable = signal(false);
  mountLocation: 'letter' | 'folder' = 'letter';

  mounted(): MountedRemote | undefined {
    const task = this.task();
    return task ? simpleTaskMount(task, this.facade.mountedRemotes()) : undefined;
  }
  currentMount(): string | undefined {
    return this.mounted()?.mount_point;
  }
  needsReconnect(): boolean {
    return (
      this.draft.operation === 'mount' &&
      !!this.mounted() &&
      simpleMountPending(this.mounted(), this.draft) !== false
    );
  }
  letterUnavailable(letter: string): boolean {
    return (
      this.occupiedLetters().includes(letter) &&
      this.currentMount()?.slice(0, 2).toUpperCase() !== letter
    );
  }
  changeMountLocation(location: 'letter' | 'folder'): void {
    this.mountLocation = location;
    this.draft.destination = '';
  }
  async loadDrives(): Promise<void> {
    this.checkingDrives.set(true);
    this.drivesUnavailable.set(false);
    try {
      const drives = await this.remotes.getLocalDrives();
      if (this.scope === this.backend.activeBackend())
        this.occupiedLetters.set(
          drives.map(d => (d.mount_point || d.name).slice(0, 2).toUpperCase())
        );
    } catch {
      this.drivesUnavailable.set(true);
    } finally {
      this.checkingDrives.set(false);
    }
  }
  draft: SimpleTaskDraft = {
    name: '',
    volumeName: '',
    operation: 'sync',
    source: '',
    destination: '',
    history: '',
    useVss: false,
    schedule: 'manual',
    time: '18:00',
    oncePerDay: true,
    networkDrive: true,
    readOnly: false,
    serveType: 'http',
    address: '127.0.0.1:8080',
  };

  ngOnInit(): void {
    this.scope = this.backend.activeBackend();
    const task = this.task();
    const app = getAppCfg(task?.config);
    const rc = getRcloneCfg(task?.config);
    this.draft = {
      ...this.draft,
      operation: task?.operation ?? this.operation(),
      name: task?.displayName ?? task?.name ?? '',
      volumeName: simpleVolumeName(task?.config),
      source: task?.source ?? (this.operation() === 'mount' ? this.remote() + ':' : ''),
      destination: task?.destination ?? '',
      history: task?.history ?? '',
      useVss: app?.useVss ?? false,
      ...simpleSchedule(app),
      oncePerDay: app?.autoStartOncePerDay ?? !task,
      ...simpleMountOptions(task?.config, this.facade.getRemoteSettings(this.remote())),
      serveType: typeof rc?.type === 'string' ? rc.type : 'http',
      address: typeof rc?.addr === 'string' ? rc.addr : '127.0.0.1:8080',
    };
    this.mountLocation =
      !this.draft.destination || /^[a-z]:[\\/]?$/i.test(this.draft.destination)
        ? 'letter'
        : 'folder';
    if (this.draft.operation === 'mount' && this.mountLocation === 'letter')
      this.draft.destination = this.draft.destination.slice(0, 2).toUpperCase();
    if (this.draft.operation === 'mount' && this.backend.isWindows()) void this.loadDrives();
    void this.vss.refresh();
  }

  async pick(field: 'source' | 'destination' | 'history'): Promise<void> {
    if (this.picking() || this.busy()) return;
    const request = ++this.pickerRequest;
    this.picking.set(true);
    try {
      const result = await this.files.selectPathWithNautilus({
        mode:
          this.draft.operation === 'mount' && field === 'source'
            ? 'remote'
            : field === 'history' && splitSimplePath(this.draft.destination).remote
              ? 'remote'
              : 'both',
        allowedRemotes:
          this.draft.operation === 'mount' && field === 'source'
            ? [this.remote()]
            : field === 'history' && splitSimplePath(this.draft.destination).remote
              ? [splitSimplePath(this.draft.destination).remote]
              : undefined,
        selection: 'folders',
        multi: false,
        initialLocation:
          this.draft[field] || (field === 'history' ? this.draft.destination : undefined),
      });
      if (this.destroyRef.destroyed || request !== this.pickerRequest) return;
      if (!result.cancelled && result.paths[0] && this.scope === this.backend.activeBackend()) {
        if (
          this.draft.operation === 'mount' &&
          field === 'source' &&
          splitSimplePath(result.paths[0]).remote !== this.remote()
        ) {
          this.error.set('simple.errors.mountSource');
          return;
        }
        this.draft[field] = result.paths[0];
      }
      this.changeDetector.markForCheck();
    } catch (error) {
      if (!this.destroyRef.destroyed) this.notifications.showError(error);
    } finally {
      if (!this.destroyRef.destroyed && request === this.pickerRequest) this.picking.set(false);
    }
  }

  async enableVss(): Promise<void> {
    try {
      await this.vss.enable();
    } catch (error) {
      this.notifications.showError(error);
    }
  }

  async save(reconnect = false): Promise<void> {
    if (this.busy()) return;
    this.error.set('');
    if (this.scope !== this.backend.activeBackend() || !this.facade.isRemoteActive(this.remote())) {
      this.error.set('simple.errors.scope');
      return;
    }
    if (this.task()?.multipleSources) {
      this.error.set('simple.tasks.complex');
      return;
    }
    if (this.sourceError()) {
      this.error.set('simple.errors.mountSource');
      return;
    }
    const historyError = this.historyError();
    if (historyError) {
      this.error.set(historyError);
      return;
    }
    const name = this.task()?.name ?? this.draft.name.trim();
    if (
      !this.draft.name.trim() ||
      Array.from(this.draft.name).some(char => char.charCodeAt(0) < 32)
    ) {
      this.error.set('simple.errors.name');
      return;
    }
    const key = REMOTE_CONFIG_KEYS[this.draft.operation];
    const profiles = this.facade.getRemoteSettings(this.remote())[key] ?? {};
    if (!this.task() && Object.hasOwn(profiles, name)) {
      this.error.set('simple.errors.duplicate');
      return;
    }
    if (
      this.task() &&
      ((this.draft.operation !== 'mount' &&
        this.draft.name !== (this.task()?.displayName ?? this.task()?.name)) ||
        this.draft.operation !== this.task()?.operation)
    ) {
      this.error.set('simple.errors.name');
      return;
    }
    if (this.draft.operation === 'mount') {
      const destination = this.draft.destination.trim();
      if (
        this.backend.isWindows() &&
        this.mountLocation === 'letter' &&
        (!/^[A-Z]:$/.test(destination) ||
          this.checkingDrives() ||
          this.drivesUnavailable() ||
          this.letterUnavailable(destination))
      ) {
        this.error.set('simple.errors.drive');
        return;
      }
      if (
        this.facade.checkMountPathCollision(destination, this.remote(), this.task()?.name).length
      ) {
        this.error.set('simple.errors.driveCollision');
        return;
      }
      const normalize = (path: string): string => {
        const value = path.replace(/[\\/]+$/, '');
        return this.backend.isWindows() ? value.replace(/\\/g, '/').toLowerCase() : value;
      };
      if (
        this.facade
          .mountedRemotes()
          .some(
            m =>
              normalize(m.mount_point) === normalize(destination) &&
              m.mount_point !== this.currentMount()
          )
      ) {
        this.error.set('simple.errors.driveCollision');
        return;
      }
    }
    this.busy.set(true);
    const expected = this.mounted();
    let persisted = false;
    try {
      const settings = this.facade.getRemoteSettings(this.remote());
      const profile = patchSimpleProfile(
        this.task()?.config,
        this.draft,
        settings,
        reconnect && this.draft.operation === 'mount'
      );
      const vfsUpdate = patchSimpleMountVfs(settings, this.task()?.config, this.draft, profile);
      await this.facade.updateRemoteSettings(this.remote(), {
        ...vfsUpdate,
        [key]: { ...profiles, [name]: profile },
      });
      persisted = true;
      if (this.scope !== this.backend.activeBackend()) {
        this.error.set('simple.errors.scope');
        return;
      }
      if (reconnect && this.draft.operation === 'mount' && expected) {
        this.applying.set(true);
        await this.mounts.reconnectRemoteProfile(this.remote(), name, expected, this.scope);
        if (this.scope !== this.backend.activeBackend()) return;
        await this.mounts.getMountedRemotes();
      }
      if (this.scope === this.backend.activeBackend()) this.saved.emit();
    } catch (error) {
      this.error.set(
        error instanceof Error && error.message.startsWith('simple.')
          ? error.message
          : persisted && reconnect
            ? 'simple.drives.savedApplyFailed'
            : 'simple.errors.save'
      );
    } finally {
      this.applying.set(false);
      this.busy.set(false);
    }
  }

  operationHint(): string {
    return this.translate.instant('simple.operationHelp.' + this.draft.operation);
  }
}
