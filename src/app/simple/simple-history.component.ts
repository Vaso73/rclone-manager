import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Entry } from '@app/types';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { RemoteFileOperationsService } from '../services/remote/remote-file-operations.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { NotificationService } from '../services/ui/notification.service';
import { SimpleTask, restoredHistoryName, safeHistoryName } from './simple-profile.util';

@Component({
  selector: 'app-simple-history',
  imports: [MatButtonModule, MatIcon, TranslatePipe, DatePipe, DecimalPipe],
  templateUrl: './simple-history.component.html',
  styleUrl: './simple-task-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimpleHistoryComponent implements OnDestroy {
  readonly task = input.required<SimpleTask>();
  private readonly backend = inject(BackendService);
  private readonly ops = inject(RemoteFileOperationsService);
  private readonly files = inject(FileSystemService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  readonly entries = signal<Entry[]>([]);
  readonly path = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  private generation = 0;
  constructor() {
    effect(() => {
      const root = this.task().history;
      const backend = this.backend.activeBackend();
      void this.load('', root, backend);
    });
  }
  ngOnDestroy(): void {
    ++this.generation;
  }
  async load(
    path = this.path(),
    root = this.task().history,
    backend = this.backend.activeBackend()
  ): Promise<void> {
    const generation = ++this.generation;
    this.busy.set(true);
    this.error.set('');
    this.entries.set([]);
    this.path.set(path);
    try {
      const result = await this.ops.getRemotePaths(root, path, {});
      if (generation === this.generation && backend === this.backend.activeBackend())
        this.entries.set(
          (result.list ?? [])
            .filter(e => safeHistoryName(e.Name))
            .sort((a, b) => Number(b.IsDir) - Number(a.IsDir) || a.Name.localeCompare(b.Name))
        );
    } catch {
      if (generation === this.generation) this.error.set('simple.history.unavailable');
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
  open(entry: Entry): void {
    if (entry.IsDir && safeHistoryName(entry.Name)) void this.load(this.relative(entry));
  }
  up(): void {
    void this.load(this.path().split('/').slice(0, -1).join('/'));
  }
  private relative(entry: Entry): string {
    return [this.path(), entry.Name].filter(Boolean).join('/');
  }
  async restore(entry: Entry): Promise<void> {
    if (this.busy() || entry.IsDir || !safeHistoryName(entry.Name)) return;
    const generation = this.generation,
      backend = this.backend.activeBackend(),
      root = this.task().history;
    const path = this.relative(entry),
      name = restoredHistoryName(entry.Name, path);
    this.busy.set(true);
    try {
      const target = await this.files.selectFolder();
      if (!target || generation !== this.generation || backend !== this.backend.activeBackend())
        return;
      const accepted = await this.notifications.confirmModal(
        'simple.history.restore',
        this.translate.instant('simple.history.restoreConfirm', { name, target }),
        'simple.history.restore',
        'common.cancel'
      );
      if (!accepted || generation !== this.generation || backend !== this.backend.activeBackend())
        return;
      await this.ops.transferItems(
        [{ remote: root, path, name, isDir: false }],
        target,
        '',
        'copy',
        'dashboard'
      );
      this.notifications.showSuccess(this.translate.instant('simple.history.restoreStarted'));
    } catch (error) {
      this.notifications.showError(error);
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
}
