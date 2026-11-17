import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { NotificationService } from '../services/ui/notification.service';
import { InterfaceModeService } from './interface-mode.service';

@Component({
  selector: 'app-interface-mode-switch',
  imports: [MatButtonModule, MatIcon, TranslatePipe],
  template: `<button
    matButton
    type="button"
    data-tauri-drag-region="false"
    [attr.aria-label]="(mode.simple() ? 'simple.mode.advanced' : 'simple.mode.simple') | translate"
    [disabled]="mode.saving()"
    (click)="toggle()"
    [title]="'simple.mode.switch' | translate"
  >
    <mat-icon svgIcon="right-left"></mat-icon>
    <span>{{ (mode.simple() ? 'simple.mode.advanced' : 'simple.mode.simple') | translate }}</span>
  </button>`,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      @media (max-width: 40rem) {
        button {
          min-width: 0;
          padding-inline: var(--space-xs);
        }
        span {
          display: none;
        }
        mat-icon {
          margin: 0;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InterfaceModeSwitchComponent {
  readonly mode = inject(InterfaceModeService);
  private readonly notifications = inject(NotificationService);
  async toggle(): Promise<void> {
    try {
      await this.mode.setMode(this.mode.simple() ? 'advanced' : 'simple');
    } catch (error) {
      this.notifications.showError(error);
    }
  }
}
