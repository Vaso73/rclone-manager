import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  BATCH_OP_LABELS,
  JOB_STATUS,
  JobInfo,
  MountedRemote,
  OPERATION_TONE,
  profileOf,
} from '@app/types';
import { WorkspaceShellComponent } from '../layout/workspace-shell/workspace-shell.component';
import { TitlebarComponent } from '../layout/titlebar/titlebar.component';
import { BannerComponent } from '../layout/banners/banner.component';
import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { JobManagementService } from '../services/operations/job-management.service';
import { ModalService } from '../services/ui/modal.service';
import { NotificationService } from '../services/ui/notification.service';
import { NautilusService } from '../services/ui/nautilus.service';
import { PillDirective } from '../shared/directives/pill.directive';
import { IconService } from '../services/ui/icon.service';
import {
  SimpleTask,
  listSimpleTasks,
  simpleTaskReady,
  simpleTaskMount,
  simpleMountOptions,
} from './simple-profile.util';
import { SimpleTaskEditorComponent } from './simple-task-editor.component';
import { SimpleHistoryComponent } from './simple-history.component';

type SimplePage = 'connections' | 'drives' | 'tasks' | 'history';
@Component({
  selector: 'app-simple-workspace',
  imports: [
    WorkspaceShellComponent,
    TitlebarComponent,
    BannerComponent,
    MatButtonModule,
    MatIcon,
    MatCardModule,
    TranslatePipe,
    PillDirective,
    SimpleTaskEditorComponent,
    SimpleHistoryComponent,
    DatePipe,
    DecimalPipe,
  ],
  templateUrl: './simple-workspace.component.html',
  styleUrl: './simple-workspace.component.scss',
  host: { class: 'workspace-container' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimpleWorkspaceComponent {
  readonly facade = inject(RemoteFacadeService);
  readonly icons = inject(IconService);
  readonly ready = simpleTaskReady;
  mountOptions(task: SimpleTask): { networkDrive: boolean; readOnly: boolean } {
    return simpleMountOptions(task.config, this.facade.getRemoteSettings(task.remote));
  }
  readonly backend = inject(BackendService);
  private readonly jobs = inject(JobManagementService);
  private readonly modal = inject(ModalService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly browser = inject(NautilusService);
  readonly page = signal<SimplePage>('connections');
  readonly pages: { key: SimplePage; icon: string }[] = [
    { key: 'connections', icon: 'cloud' },
    { key: 'drives', icon: 'hard-drive' },
    { key: 'tasks', icon: 'check-list' },
    { key: 'history', icon: 'clock' },
  ];
  readonly selected = linkedSignal(() => this.facade.remoteSummaries()[0]?.name ?? '');
  readonly editor = signal<{
    remote: string;
    task?: SimpleTask;
    mount: boolean;
    backend: string;
  } | null>(null);
  readonly history = signal<SimpleTask | null>(null);
  readonly pending = signal(false);
  readonly tones = OPERATION_TONE;
  readonly allTasks = computed(() =>
    this.facade
      .remoteSummaries()
      .flatMap(remote => listSimpleTasks(remote.name, this.facade.getRemoteSettings(remote.name)))
  );
  readonly visibleTasks = computed(() =>
    this.allTasks().filter(
      task =>
        task.remote === this.selected() &&
        (this.page() === 'drives' ? task.operation === 'mount' : task.operation !== 'mount')
    )
  );
  readonly historyTasks = computed(() => this.allTasks().filter(task => !!task.history));
  readonly validEditor = computed(() => {
    const editor = this.editor();
    return editor?.backend === this.backend.activeBackend() &&
      this.facade.isRemoteActive(editor.remote)
      ? editor
      : null;
  });
  readonly validHistory = computed(() => {
    const history = this.history();
    return (
      this.historyTasks().find(
        task =>
          task.remote === history?.remote &&
          task.name === history.name &&
          task.operation === history.operation
      ) ?? null
    );
  });

  navigate(page: SimplePage): void {
    this.page.set(page);
    this.editor.set(null);
    this.history.set(null);
  }
  async addConnection(): Promise<void> {
    const scope = this.backend.activeBackend();
    try {
      const name = await firstValueFrom(this.modal.openQuickAddRemote<string>(true).afterClosed());
      if (typeof name === 'string' && scope === this.backend.activeBackend()) {
        this.selected.set(name);
        this.page.set('drives');
      }
    } catch (error) {
      this.notifications.showError(error);
    }
  }
  editConnection(): void {
    const remote = this.facade.getRemote(this.selected());
    if (remote)
      this.modal.openRemoteConfig({
        remoteName: remote.name,
        remoteType: remote.type,
        editTarget: 'remote',
        simpleSetup: true,
      });
  }
  browse(): void {
    if (this.selected()) void this.browser.openBrowserOverlay(this.selected(), '');
  }
  editDisk(remote: string): void {
    this.selected.set(remote);
    this.navigate('drives');
    const mounts = this.visibleTasks();
    if (mounts.length <= 1) this.edit(mounts[0]);
  }
  mount(task: SimpleTask): MountedRemote | undefined {
    return simpleTaskMount(task, this.facade.mountedRemotes());
  }
  edit(task?: SimpleTask): void {
    if (this.selected())
      this.editor.set({
        remote: this.selected(),
        task,
        mount: this.page() === 'drives',
        backend: this.backend.activeBackend(),
      });
  }
  latest(task: SimpleTask): JobInfo | null {
    return this.jobs.getLatestJobForRemote(task.remote, task.name, task.operation);
  }
  details(job: JobInfo): void {
    this.modal.openJobDetail(job);
  }
  active(task: SimpleTask): boolean {
    if (task.operation === 'mount') return !!this.mount(task);
    if (task.operation === 'serve')
      return this.facade
        .runningServes()
        .some(serve => serve.params.fs === task.source && profileOf(serve) === task.name);
    return this.isRunning(task);
  }
  isRunning(task: SimpleTask): boolean {
    return this.latest(task)?.status === JOB_STATUS.Running;
  }
  async stop(task: SimpleTask): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    try {
      await this.facade.stopJob(task.remote, task.operation, undefined, task.name);
    } catch (error) {
      this.notifications.showError(error);
    } finally {
      this.pending.set(false);
    }
  }
  async run(task: SimpleTask, preview: boolean): Promise<void> {
    if (this.pending() || this.active(task) || !this.ready(task)) return;
    this.pending.set(true);
    const scope = this.backend.activeBackend();
    try {
      if (!preview && task.operation !== 'check') {
        const ok = await this.notifications.confirmModal(
          'simple.tasks.run',
          this.translate.instant('simple.tasks.confirm', {
            name: task.name,
            source: task.source,
            destination: task.destination,
            action: this.translate.instant('simple.operationHelp.' + task.operation),
          }),
          'simple.tasks.run',
          'common.cancel'
        );
        if (!ok) return;
      }
      if (scope !== this.backend.activeBackend() || !this.facade.isRemoteActive(task.remote))
        return;
      if (task.operation === 'mount' || task.operation === 'serve')
        await this.facade.startJob(task.remote, task.operation, task.name);
      else
        await this.jobs.startProfileBatch(BATCH_OP_LABELS[task.operation], {
          remoteName: task.remote,
          profileName: task.name,
          source: 'dashboard',
          backendName: scope,
          dryRun: preview,
        });
    } catch (error) {
      this.notifications.showError(error);
    } finally {
      this.pending.set(false);
    }
  }
}
