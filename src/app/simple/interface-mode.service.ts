import { computed, inject, Injectable, signal } from '@angular/core';
import { AppSettingsService } from '../services/settings/app-settings.service';

export type InterfaceMode = 'simple' | 'advanced';

@Injectable({ providedIn: 'root' })
export class InterfaceModeService {
  private readonly settings = inject(AppSettingsService);
  readonly saving = signal(false);
  readonly mode = computed<InterfaceMode>(() =>
    this.settings.options()?.['general.interface_mode']?.value === 'simple' ? 'simple' : 'advanced'
  );
  readonly simple = computed(() => this.mode() === 'simple');

  async setMode(mode: InterfaceMode): Promise<void> {
    if (this.saving() || mode === this.mode()) return;
    this.saving.set(true);
    try {
      await this.settings.saveSetting('general', 'interface_mode', mode);
    } finally {
      this.saving.set(false);
    }
  }
}
