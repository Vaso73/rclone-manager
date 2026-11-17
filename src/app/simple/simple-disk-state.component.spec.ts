import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { SimpleDiskStateComponent } from './simple-disk-state.component';

describe('disk current and pending settings', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
  });
  it('shows both states until reconnect reports the new settings, then removes the pending notice', () => {
    const fixture = TestBed.createComponent(SimpleDiskStateComponent);
    const active = {
      fs: 'NAS:',
      mount_point: 'W:',
      settings: { source: 'NAS:', network_mode: false, read_only: false },
    };
    for (const [key, value] of Object.entries({
      active,
      source: 'NAS:',
      destination: 'V:',
      networkDrive: true,
      readOnly: false,
    }))
      fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    expect(fixture.componentInstance.pending()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('simple.drives.current');
    expect(fixture.nativeElement.textContent).toContain('simple.drives.pending');
    expect(fixture.nativeElement.textContent).toContain('W:');
    expect(fixture.nativeElement.textContent).toContain('V:');
    fixture.componentRef.setInput('active', {
      ...active,
      mount_point: 'V:',
      settings: { ...active.settings, network_mode: true },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.pending()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('simple.drives.pendingHelp');
    expect(fixture.nativeElement.textContent).not.toContain('simple.drives.pending');
  });
  it('retains pending/current and unknown settings in the compact row', () => {
    const fixture = TestBed.createComponent(SimpleDiskStateComponent);
    for (const [key, value] of Object.entries({
      compact: true,
      active: { fs: 'NAS:', mount_point: 'X:' },
      source: 'NAS:folder',
      destination: 'Y:',
      networkDrive: true,
      readOnly: true,
    }))
      fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('X:');
    expect(fixture.nativeElement.textContent).toContain('Y:');
    expect(fixture.nativeElement.textContent).toContain('simple.drives.unknownType');
    expect(fixture.nativeElement.textContent).toContain('simple.drives.currentSource');
    expect(fixture.nativeElement.textContent).toContain('simple.drives.pendingHelp');
    fixture.componentRef.setInput('refreshing', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('simple.drives.refreshing');
    expect(fixture.nativeElement.textContent).not.toContain('simple.drives.nextMount');
  });
  it('shows unavailable launch details explicitly and does not claim saved options are active', () => {
    const fixture = TestBed.createComponent(SimpleDiskStateComponent);
    for (const [key, value] of Object.entries({
      active: { fs: 'NAS:', mount_point: 'W:' },
      source: 'NAS:',
      destination: 'W:',
      networkDrive: true,
      readOnly: false,
    }))
      fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    expect(fixture.componentInstance.pending()).toBeUndefined();
    expect(fixture.nativeElement.textContent).toContain('simple.drives.unknownType');
    expect(fixture.nativeElement.textContent).toContain('simple.drives.savedSettings');
    expect(fixture.nativeElement.textContent).not.toContain('simple.drives.pendingHelp');
  });
});
