import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BackendService } from '../services/infrastructure/system/backend.service';
import { RemoteFileOperationsService } from '../services/remote/remote-file-operations.service';
import { FileSystemService } from '../services/operations/file-system.service';
import { NotificationService } from '../services/ui/notification.service';
import { HistoryPlace } from './simple-history-places.service';
import {
  SimpleWorkspaceManagementService,
  HistoryRestoreResult,
} from './simple-workspace-management.service';
import { HistoryVersion, searchHistory } from './simple-history-search.util';

@Component({
  selector: 'app-simple-history-wizard',
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    MatButtonModule,
    MatIcon,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './simple-history-wizard.component.html',
  styleUrl: './simple-history-wizard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimpleHistoryWizardComponent implements OnDestroy {
  readonly places = input.required<HistoryPlace[]>();
  readonly initialPlace = input('');
  readonly browse = output<HistoryPlace>();
  readonly backend = inject(BackendService);
  private readonly ops = inject(RemoteFileOperationsService);
  private readonly files = inject(FileSystemService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly management = inject(SimpleWorkspaceManagementService);
  readonly selectedPlace = signal('');
  readonly place = computed(() => this.places().find(place => place.id === this.selectedPlace()));
  readonly step = signal(0);
  readonly busy = signal(false);
  readonly restoring = signal(false);
  readonly versions = signal<HistoryVersion[]>([]);
  readonly selectedFile = signal('');
  readonly selectedPath = signal('');
  readonly partial = signal(false);
  readonly searched = signal(false);
  readonly folders = signal(0);
  readonly result = signal<HistoryRestoreResult | null>(null);
  readonly error = signal('');
  readonly filesFound = computed(() =>
    [...new Set(this.versions().map(version => version.originalPath))].sort((a, b) =>
      a.localeCompare(b)
    )
  );
  readonly fileVersions = computed(() =>
    this.versions()
      .filter(version => version.originalPath === this.selectedFile())
      .sort(
        (a, b) =>
          b.archived.localeCompare(a.archived) || b.entry.ModTime.localeCompare(a.entry.ModTime)
      )
  );
  readonly chosen = computed(() =>
    this.fileVersions().find(version => version.path === this.selectedPath())
  );
  query = '';
  readonly destination = signal('');
  private generation = 0;
  private scope = '';
  private requestedPlace = '';
  modifiedDate(value: string): string | null {
    return Number.isFinite(Date.parse(value)) ? value : null;
  }
  archiveDate(value: string): string {
    const parts = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(value);
    return parts
      ? `${parts[3]}.${parts[2]}.${parts[1]} ${parts[4]}:${parts[5]}:${parts[6]}`
      : value;
  }
  constructor() {
    effect(() => {
      const backend = this.backend.activeBackend(),
        places = this.places(),
        requested = this.initialPlace();
      if (
        backend !== this.scope ||
        requested !== this.requestedPlace ||
        !places.some(place => place.id === this.selectedPlace())
      ) {
        this.requestedPlace = requested;
        this.scope = backend;
        this.generation++;
        this.busy.set(false);
        this.restoring.set(false);
        this.step.set(0);
        this.resetSelection();
        this.selectedPlace.set(
          places.find(place => place.id === requested)?.id ?? places[0]?.id ?? ''
        );
      }
    });
  }
  ngOnDestroy(): void {
    this.generation++;
  }
  choosePlace(id: string): void {
    this.cancelSearch();
    this.selectedPlace.set(id);
    this.resetSelection();
  }
  private resetSelection(): void {
    this.versions.set([]);
    this.selectedFile.set('');
    this.selectedPath.set('');
    this.searched.set(false);
    this.partial.set(false);
    this.folders.set(0);
    this.result.set(null);
    this.error.set('');
  }
  cancelSearch(): void {
    const wasBusy = this.busy();
    this.generation++;
    this.busy.set(false);
    if (wasBusy) this.partial.set(true);
  }
  async search(): Promise<void> {
    const place = this.place();
    if (!place || place.unavailable || !this.query.trim() || this.busy()) return;
    const generation = ++this.generation,
      backend = this.backend.activeBackend();
    const cancelled = (): boolean =>
      generation !== this.generation || backend !== this.backend.activeBackend();
    this.busy.set(true);
    this.error.set('');
    this.versions.set([]);
    this.selectedFile.set('');
    this.selectedPath.set('');
    this.partial.set(false);
    this.searched.set(false);
    this.folders.set(0);
    const found = await searchHistory(
      this.query,
      path => this.ops.getRemotePaths(place.root, path, {}, 'dashboard'),
      cancelled,
      partial => {
        if (!cancelled()) {
          this.versions.set(partial.versions);
          this.folders.set(partial.folders);
        }
      }
    );
    if (!cancelled()) {
      this.versions.set(found.versions);
      this.partial.set(found.partial);
      this.searched.set(true);
      this.busy.set(false);
      if (found.errors) this.error.set('simple.manage.searchPartial');
    }
  }
  chooseFile(path: string): void {
    this.selectedFile.set(path);
    this.selectedPath.set(this.fileVersions()[0]?.path ?? '');
  }
  next(): void {
    if (this.busy() || this.restoring()) return;
    if (this.step() === 0 && this.place() && !this.place()?.unavailable) this.step.set(1);
    else if (this.step() === 1 && this.selectedFile()) this.step.set(2);
    else if (this.step() === 2 && this.chosen()) this.step.set(3);
  }
  back(): void {
    if (!this.restoring()) {
      this.cancelSearch();
      this.result.set(null);
      this.error.set('');
      this.step.update(step => Math.max(0, step - 1));
    }
  }
  async chooseDestination(): Promise<void> {
    const generation = this.generation,
      backend = this.backend.activeBackend();
    const path = await this.files.selectFolder(false, this.destination() || undefined, true);
    if (path && generation === this.generation && backend === this.backend.activeBackend())
      this.destination.set(path);
  }
  async restore(): Promise<void> {
    const place = this.place(),
      version = this.chosen();
    if (!place || place.unavailable || !version || !this.destination().trim() || this.restoring())
      return;
    const backendName = this.backend.activeBackend(),
      generation = this.generation,
      destination = this.destination().trim();
    this.restoring.set(true);
    this.error.set('');
    this.result.set(null);
    try {
      const accepted = await this.notifications.confirmModal(
        'simple.manage.restoreCopy',
        this.translate.instant('simple.manage.restoreReview', {
          name: version.name,
          path: version.originalPath,
          version: version.archived
            ? this.archiveDate(version.archived)
            : this.translate.instant('simple.manage.archiveTimeUnknown'),
          source: version.path,
          root: place.root,
          target: destination,
        }),
        'simple.manage.restoreCopy',
        'common.cancel',
        { preserveLines: true }
      );
      if (
        !accepted ||
        backendName !== this.backend.activeBackend() ||
        generation !== this.generation
      )
        return;
      const result = await this.management.restoreHistory({
        backendName,
        root: place.root,
        path: version.path,
        name: version.name,
        destination,
        size: version.entry.Size,
        modified: version.entry.ModTime,
      });
      if (backendName === this.backend.activeBackend() && generation === this.generation)
        this.result.set(result);
    } catch (error) {
      if (generation === this.generation) {
        this.error.set('simple.manage.restoreFailed');
        this.notifications.showError(error);
      }
    } finally {
      if (generation === this.generation) this.restoring.set(false);
    }
  }
  async openResult(): Promise<void> {
    const path = this.result()?.destination;
    if (path) await this.files.openInFiles(path);
  }
}
