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
import { CdkMenuModule } from '@angular/cdk/menu';
import { MatCardModule } from '@angular/material/card';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  BATCH_OP_LABELS,
  JOB_STATUS,
  JobInfo,
  MountedRemote,
  OPERATION_TONE,
  profileOf,
  OPERATION_REGISTRY,
} from '@app/types';
import { WorkspaceShellComponent } from '../layout/workspace-shell/workspace-shell.component';
import { TitlebarComponent } from '../layout/titlebar/titlebar.component';
import { BannerComponent } from '../layout/banners/banner.component';
import { RemoteFacadeService } from '../services/facade/remote-facade.service';
import { isHeadlessMode } from '../services/infrastructure/platform/api-client.service';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { JobManagementService } from '../services/operations/job-management.service';
import { ModalService } from '../services/ui/modal.service';
import { NotificationService } from '../services/ui/notification.service';
import { MountManagementService } from '../services/operations/mount-management.service';
import { NautilusService } from '../services/ui/nautilus.service';
import { PillDirective } from '../shared/directives/pill.directive';
import { IconService } from '../services/ui/icon.service';
import {
  SimpleTask,
  listSimpleTasks,
  simpleTaskReady,
  simpleTaskMount,
  simpleMountOptions,
  simpleTaskTemplate,
  simpleVolumeName,
  splitSimplePath,
  simpleDiskLabel,
} from './simple-profile.util';
import { SimpleTaskEditorComponent } from './simple-task-editor.component';
import { SimpleDiskStateComponent } from './simple-disk-state.component';
import { SimpleHistoryComponent } from './simple-history.component';
import { SimpleCardOrderService } from './simple-card-order.service';
import { SimpleReorderDirective, SimpleCardMove } from './simple-reorder.directive';
import { simpleTaskConnections, simpleTaskKey } from './simple-task-connections.util';

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
    CdkMenuModule,
    TranslatePipe,
    PillDirective,
    SimpleTaskEditorComponent,
    SimpleHistoryComponent,
    SimpleDiskStateComponent,
    SimpleReorderDirective,
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
  ready(task: SimpleTask): boolean {
    return simpleTaskReady(task, this.backend.isWindows());
  }
  label(task: SimpleTask): string {
    return task.displayName || task.name;
  }
  volumeName = simpleVolumeName;
  jobProfile = profileOf;
  jobType(job: JobInfo): string {
    return (
      OPERATION_REGISTRY.find(op => op.key === job.job_type)?.typeLabel ??
      'simple.history.otherOperation'
    );
  }
  mountOptions(task: SimpleTask): { networkDrive: boolean; readOnly: boolean } {
    return simpleMountOptions(task.config, this.facade.getRemoteSettings(task.remote));
  }
  readonly backend = inject(BackendService);
  readonly mounts = inject(MountManagementService);
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
  private readonly cardOrder = inject(SimpleCardOrderService);
  readonly connections = computed(() =>
    this.cardOrder.sorted(
      this.backend.activeBackend(),
      'connections',
      this.facade.remoteSummaries(),
      remote => remote.name
    )
  );
  readonly taskConnections = computed(() => {
    const connections = this.connections();
    const names = connections.map(remote => remote.name);
    const used = new Set(
      this.allTasks()
        .filter(task => task.operation !== 'mount' && !this.isUnusedTemplate(task))
        .flatMap(task => simpleTaskConnections(task, names))
    );
    return connections.filter(remote => used.has(remote.name));
  });
  readonly selected = linkedSignal<string[], string>({
    source: () =>
      (this.page() === 'tasks' ? this.taskConnections() : this.connections()).map(
        remote => remote.name
      ),
    computation: (names, previous) =>
      previous && names.includes(previous.value) ? previous.value : (names[0] ?? ''),
  });
  readonly taskKey = simpleTaskKey;
  orderScope(group: string): string {
    return JSON.stringify([this.backend.activeBackend(), group]);
  }
  reorder(group: string, move: SimpleCardMove): void {
    const keys =
      group === 'connections'
        ? this.connections().map(remote => remote.name)
        : group === 'drives'
          ? this.driveTasks().map(simpleTaskKey)
          : group === 'history'
            ? this.historyTasks().map(simpleTaskKey)
            : this.visibleTasks().map(simpleTaskKey);
    this.cardOrder.move(
      this.backend.activeBackend(),
      group === 'tasks' ? JSON.stringify(['tasks', this.selected()]) : group,
      keys,
      move.from,
      move.to
    );
  }
  addTask(remote: string): void {
    if (this.pending() || !this.facade.isRemoteActive(remote)) return;
    this.editor.set({ remote, mount: false, backend: this.backend.activeBackend() });
  }
  readonly editor = signal<{
    remote: string;
    task?: SimpleTask;
    mount: boolean;
    backend: string;
  } | null>(null);
  readonly history = signal<SimpleTask | null>(null);
  readonly expanded = signal<string | null>(null);
  toggleTask(task: SimpleTask): void {
    this.expanded.update(value => (value === simpleTaskKey(task) ? null : simpleTaskKey(task)));
  }
  readonly pending = signal(false);
  readonly tones = OPERATION_TONE;
  taskIcon(task: SimpleTask): string {
    return (
      OPERATION_REGISTRY.find(operation => operation.key === task.operation)?.icon ?? 'operations'
    );
  }
  readonly allTasks = computed(() =>
    this.facade
      .remoteSummaries()
      .flatMap(remote => listSimpleTasks(remote.name, this.facade.getRemoteSettings(remote.name)))
  );
  readonly driveTasks = computed(() =>
    this.cardOrder.sorted(
      this.backend.activeBackend(),
      'drives',
      this.allTasks().filter(task => task.operation === 'mount'),
      simpleTaskKey
    )
  );
  readonly matchingTasks = computed(() =>
    this.allTasks().filter(
      task =>
        simpleTaskConnections(
          task,
          this.connections().map(remote => remote.name)
        ).includes(this.selected()) &&
        (this.page() === 'drives' ? task.operation === 'mount' : task.operation !== 'mount')
    )
  );
  readonly visibleTasks = computed(() =>
    this.cardOrder.sorted(
      this.backend.activeBackend(),
      JSON.stringify(['tasks', this.selected()]),
      this.matchingTasks().filter(task => !this.isUnusedTemplate(task)),
      simpleTaskKey
    )
  );
  readonly templates = computed(() =>
    this.allTasks().filter(task => task.operation !== 'mount' && this.isUnusedTemplate(task))
  );

  isUnusedTemplate(task: SimpleTask): boolean {
    return simpleTaskTemplate(task) && !this.active(task) && !this.latest(task);
  }

  async remove(task: SimpleTask): Promise<void> {
    if (this.pending() || this.active(task)) return;
    const backend = this.backend.activeBackend();
    this.pending.set(true);
    try {
      const accepted = await this.notifications.confirmModal(
        'simple.tasks.delete',
        this.translate.instant('simple.tasks.deleteConfirm', {
          name: this.label(task),
          remote: task.remote,
          operation: this.translate.instant('simple.operations.' + task.operation),
        }),
        'simple.tasks.delete',
        'common.cancel'
      );
      if (!accepted || backend !== this.backend.activeBackend() || this.active(task)) return;
      await this.facade.deleteTaskProfile(
        task.remote,
        task.operation,
        task.name,
        task.config,
        backend
      );
    } catch (error) {
      this.notifications.showError(error);
    } finally {
      this.pending.set(false);
    }
  }

  readonly historyTasks = computed(() =>
    this.cardOrder.sorted(
      this.backend.activeBackend(),
      'history',
      this.allTasks().filter(task => !!task.history),
      simpleTaskKey
    )
  );
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
    const mounts = this.driveTasks().filter(task => task.remote === remote);
    if (mounts.length <= 1) this.edit(mounts[0]);
  }
  addDisk(remote: string): void {
    if (this.pending() || !this.facade.isRemoteActive(remote)) return;
    this.selected.set(remote);
    this.edit();
  }
  driveLabel = simpleDiskLabel;
  driveIcon(task: SimpleTask): string {
    const type = this.facade.remoteSummaries().find(remote => remote.name === task.remote)?.type;
    return this.icons.getIconName(type || 'hard-drive');
  }
  async openDisk(task: SimpleTask): Promise<void> {
    if (
      this.pending() ||
      this.mounts.refreshing() ||
      task.operation !== 'mount' ||
      !this.facade.isRemoteActive(task.remote)
    )
      return;
    const active = this.mount(task);
    if (!active) return;
    try {
      if (this.backend.isLocalBackend() && !isHeadlessMode()) {
        const point = /^[a-z]:$/i.test(active.mount_point)
          ? active.mount_point + '\\'
          : active.mount_point;
        await this.facade.openRemoteInFiles(task.remote, point, task.name, 'mount');
      } else {
        const path = splitSimplePath(active.settings?.source ?? active.fs);
        await this.browser.openBrowserOverlay(path.remote || task.remote, path.path);
      }
    } catch (error) {
      this.notifications.showError(error);
    }
  }
  mount(task: SimpleTask): MountedRemote | undefined {
    return simpleTaskMount(task, this.facade.mountedRemotes());
  }
  edit(task?: SimpleTask): void {
    const remote = task?.remote ?? this.selected();
    if (remote)
      this.editor.set({
        remote,
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
          task.operation === 'mount' ? 'simple.drives.connectTitle' : 'simple.tasks.run',
          this.translate.instant(
            task.operation === 'mount' ? 'simple.drives.confirm' : 'simple.tasks.confirm',
            {
              name: this.label(task),
              type: this.translate.instant(
                this.mountOptions(task).networkDrive
                  ? 'simple.drives.network'
                  : 'simple.drives.local'
              ),
              access: this.translate.instant(
                this.mountOptions(task).readOnly
                  ? 'simple.drives.readOnly'
                  : 'simple.drives.readWrite'
              ),
              source: task.source,
              destination: task.destination,
              action: this.translate.instant('simple.operationHelp.' + task.operation),
            }
          ),
          task.operation === 'mount' ? 'simple.drives.connect' : 'simple.tasks.run',
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
