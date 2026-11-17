import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MountedRemote } from '@app/types';
import { PillDirective } from '../shared/directives/pill.directive';
import { simpleMountPending } from './simple-profile.util';

@Component({
  selector: 'app-simple-disk-state',
  imports: [TranslatePipe, PillDirective],
  template: `
    <section class="detail-section" [class.compact]="compact()" aria-live="polite">
      @if (refreshing()) {
        <p role="status">{{ 'simple.drives.refreshing' | translate }}</p>
      } @else if (active(); as disk) {
        <div class="card-row-item">
          @if (!compact()) {
            <span>{{ 'simple.drives.current' | translate }}</span>
          }
          <strong class="truncate" [title]="disk.mount_point">{{ disk.mount_point }}</strong>
          @if (disk.settings?.volume_name; as name) {
            <span>{{ name }}</span>
          }
          @if (compact()) {
            <span aria-hidden="true">·</span><span>{{ currentType() | translate }}</span>
            <span aria-hidden="true">·</span><span>{{ currentAccess() | translate }}</span>
          } @else {
            <span appPill size="xs" tone="dim">{{ currentType() | translate }}</span>
            <span appPill size="xs" tone="dim">{{ currentAccess() | translate }}</span>
          }
        </div>
        @if (pending() !== false) {
          <div class="card-row-item">
            <span>{{
              (pending() === true ? 'simple.drives.pending' : 'simple.drives.savedSettings')
                | translate
            }}</span>
            <strong class="truncate" [title]="destination()">{{ destination() }}</strong>
            @if (volumeName()) {
              <span>{{ volumeName() }}</span>
            }
            <span appPill size="xs" tone="orange">{{
              (networkDrive() ? 'simple.drives.network' : 'simple.drives.local') | translate
            }}</span>
            <span appPill size="xs" tone="dim">{{
              (readOnly() ? 'simple.drives.readOnly' : 'simple.drives.readWrite') | translate
            }}</span>
          </div>
          @if ((disk.settings?.source ?? disk.fs) !== source()) {
            <div class="card-row-item">
              <span>{{ 'simple.drives.currentSource' | translate }}</span
              ><span class="truncate" [title]="disk.settings?.source ?? disk.fs">{{
                disk.settings?.source ?? disk.fs
              }}</span>
            </div>
          }
          <p>
            {{
              (pending() === true ? 'simple.drives.pendingHelp' : 'simple.drives.unknownHelp')
                | translate
            }}
          </p>
        }
      } @else {
        <div class="card-row-item">
          <span>{{ 'simple.drives.nextMount' | translate }}</span>
          <strong class="truncate" [title]="destination()">{{ destination() }}</strong>
          @if (volumeName()) {
            <span>{{ volumeName() }}</span>
          }
          <span appPill size="xs" tone="dim">{{
            (networkDrive() ? 'simple.drives.network' : 'simple.drives.local') | translate
          }}</span>
          <span appPill size="xs" tone="dim">{{
            (readOnly() ? 'simple.drives.readOnly' : 'simple.drives.readWrite') | translate
          }}</span>
        </div>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .detail-section {
        gap: var(--space-xs);
      }
      .card-row-item {
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-xs);
        padding: var(--space-xs) 0;
        font-size: var(--font-size-md);
      }
      .compact {
        .card-row-item {
          padding: 0;
          font-size: var(--font-size-sm);
          color: var(--dim-color);
        }
      }
      strong {
        min-width: 0;
      }
      p {
        margin: 0;
        color: var(--dim-color);
        font-size: var(--font-size-sm);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SimpleDiskStateComponent {
  readonly compact = input(false);
  readonly active = input<MountedRemote>();
  readonly refreshing = input(false);
  readonly source = input.required<string>();
  readonly destination = input.required<string>();
  readonly networkDrive = input.required<boolean>();
  readonly readOnly = input.required<boolean>();
  readonly volumeName = input<string>();
  readonly currentType = computed(() => {
    const value = this.active()?.settings?.network_mode;
    return value === true
      ? 'simple.drives.network'
      : value === false
        ? 'simple.drives.local'
        : 'simple.drives.unknownType';
  });
  readonly currentAccess = computed(() => {
    const value = this.active()?.settings?.read_only;
    return value === true
      ? 'simple.drives.readOnly'
      : value === false
        ? 'simple.drives.readWrite'
        : 'simple.drives.unknownAccess';
  });
  readonly pending = computed(() =>
    simpleMountPending(this.active(), {
      source: this.source(),
      destination: this.destination(),
      networkDrive: this.networkDrive(),
      readOnly: this.readOnly(),
      volumeName: this.volumeName(),
    })
  );
}
