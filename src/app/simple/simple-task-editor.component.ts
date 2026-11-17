import {
  ChangeDetectionStrategy,
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
import { REMOTE_CONFIG_KEYS } from '@app/types';
import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { WindowsVssService } from '../services/operations/windows-vss.service';
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
  private scope = '';
  draft: SimpleTaskDraft = {
    name: '',
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
      name: task?.name ?? '',
      source: task?.source ?? (this.operation() === 'mount' ? this.remote() + ':' : ''),
      destination: task?.destination ?? '',
      history: task?.history ?? '',
      useVss: app?.useVss ?? false,
      ...simpleSchedule(app),
      oncePerDay: app?.autoStartOncePerDay ?? !task,
      ...simpleMountOptions(task?.config),
      serveType: typeof rc?.type === 'string' ? rc.type : 'http',
      address: typeof rc?.addr === 'string' ? rc.addr : '127.0.0.1:8080',
    };
    void this.vss.refresh();
  }

  async pick(field: 'source' | 'destination' | 'history'): Promise<void> {
    try {
      const result = await this.files.selectPathWithNautilus({
        mode: 'both',
        selection: 'folders',
        multi: false,
      });
      if (!result.cancelled && result.paths[0] && this.scope === this.backend.activeBackend())
        this.draft[field] = result.paths[0];
    } catch (error) {
      this.notifications.showError(error);
    }
  }

  async enableVss(): Promise<void> {
    try {
      await this.vss.enable();
    } catch (error) {
      this.notifications.showError(error);
    }
  }

  async save(): Promise<void> {
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
    const name = this.draft.name.trim();
    if (!name || Array.from(name).some(char => char.charCodeAt(0) < 32)) {
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
      (name !== this.task()?.name || this.draft.operation !== this.task()?.operation)
    ) {
      this.error.set('simple.errors.name');
      return;
    }
    this.busy.set(true);
    try {
      const profile = patchSimpleProfile(this.task()?.config, this.draft);
      await this.facade.updateRemoteSettings(this.remote(), {
        [key]: { ...profiles, [name]: profile },
      });
      if (this.scope === this.backend.activeBackend()) this.saved.emit();
    } catch (error) {
      this.error.set(
        error instanceof Error && error.message.startsWith('simple.')
          ? error.message
          : 'simple.errors.save'
      );
    } finally {
      this.busy.set(false);
    }
  }

  operationHint(): string {
    return this.translate.instant('simple.operationHelp.' + this.draft.operation);
  }
}
