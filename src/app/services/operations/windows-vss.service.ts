import { Injectable, computed, inject, signal } from '@angular/core';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { BackendService } from '../infrastructure/system/backend.service';

export interface VssHelperStatus {
  ready: boolean;
  busy: boolean;
}

/** Native-only snapshot permission setup; never installs anything merely by loading a profile. */
@Injectable({ providedIn: 'root' })
export class WindowsVssService extends TauriBaseService {
  private readonly backend = inject(BackendService);
  private generation = 0;
  readonly supported = computed(
    () => this.isTauri && this.backend.isLocalBackend() && this.backend.isWindows()
  );
  readonly status = signal<VssHelperStatus | null>(null);
  readonly pending = signal(false);

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    if (!this.supported()) {
      this.status.set(null);
      return;
    }
    const backend = this.backend.activeBackend();
    try {
      const status = await this.invokeCommand<VssHelperStatus>('get_vss_helper_status');
      if (
        generation === this.generation &&
        this.supported() &&
        this.backend.activeBackend() === backend
      ) {
        this.status.set(status);
      }
    } catch {
      if (generation === this.generation) this.status.set(null);
    }
  }

  async enable(): Promise<void> {
    if (!this.supported() || this.pending()) return;
    this.pending.set(true);
    ++this.generation;
    const backend = this.backend.activeBackend();
    try {
      const status = await this.invokeWithNotification<VssHelperStatus>(
        'enable_vss_helper',
        undefined,
        {
          successKey: 'wizards.appOperation.vssHelperReady',
        }
      );
      if (this.supported() && this.backend.activeBackend() === backend) this.status.set(status);
    } finally {
      this.pending.set(false);
    }
  }
}
