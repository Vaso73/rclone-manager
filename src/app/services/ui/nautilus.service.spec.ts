import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { FilePickerResult } from '@app/types';
import { NautilusService } from './nautilus.service';

describe('Nautilus standalone windows', () => {
  const context = {
    isTauri: true,
    isStandaloneEnabled: false,
    vault: { isAccessible: vi.fn(() => true) },
    invokeCommand: vi.fn(),
    getNautilusUrl: vi.fn(() => 'http://localhost/nautilus/drive/folder%20%26%20photos'),
    closeBrowserOverlay: vi.fn(),
    openBrowserOverlay: vi.fn(),
    notificationService: { showError: vi.fn() },
    translate: { instant: (key: string): string => key },
    openStandaloneWindow: NautilusService.prototype.openStandaloneWindow,
  };
  const service = context as unknown as NautilusService;

  beforeEach(() => {
    vi.clearAllMocks();
    context.isTauri = true;
    context.vault.isAccessible.mockReturnValue(true);
    context.invokeCommand.mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('opens distinct native windows for the same remote regardless of the overlay preference', async () => {
    expect(await service.openStandaloneWindow('drive', 'folder & photos')).toBe(true);
    expect(await service.openStandaloneWindow('drive', 'folder & photos')).toBe(true);
    const [first, second] = context.invokeCommand.mock.calls;
    expect(first[0]).toBe('new_window');
    expect(first[1].opts.url).toBe(
      'http://localhost/nautilus/drive/folder%20%26%20photos?standalone=nautilus'
    );
    expect(first[1].opts.label).toMatch(/^nautilus-/);
    expect(second[1].opts.label).not.toBe(first[1].opts.label);
    expect(context.openBrowserOverlay).not.toHaveBeenCalled();
    expect(context.closeBrowserOverlay).toHaveBeenCalledTimes(2);
  });

  it.each(['false', 'rejection'])(
    'keeps the source open when native creation returns %s',
    async failure => {
      if (failure === 'false') context.invokeCommand.mockResolvedValue(false);
      else context.invokeCommand.mockRejectedValue(new Error('IPC failed'));
      expect(await service.openStandaloneWindow(null, null)).toBe(false);
      expect(context.closeBrowserOverlay).not.toHaveBeenCalled();
      expect(context.openBrowserOverlay).not.toHaveBeenCalled();
      expect(context.notificationService.showError).toHaveBeenCalledWith(
        'nautilus.errors.windowOpenFailed'
      );
    }
  );

  it('preserves the overlay preference for ordinary browse requests', async () => {
    await NautilusService.prototype.newNautilusWindow.call(service, 'drive', 'folder');
    expect(context.openBrowserOverlay).toHaveBeenCalledExactlyOnceWith('drive', 'folder');
    expect(context.invokeCommand).not.toHaveBeenCalled();
  });

  it('does not open anything while the vault is locked', async () => {
    context.vault.isAccessible.mockReturnValue(false);
    expect(await service.openStandaloneWindow(null, null)).toBe(false);
    expect(context.invokeCommand).not.toHaveBeenCalled();
    expect(context.openBrowserOverlay).not.toHaveBeenCalled();
  });

  it('does not report a mobile overlay as a detached window', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
    expect(await service.openStandaloneWindow('drive', '')).toBe(false);
    expect(context.openBrowserOverlay).toHaveBeenCalledExactlyOnceWith('drive', '');
    expect(context.invokeCommand).not.toHaveBeenCalled();
  });

  it.each([true, false])('checks browser popup creation: %s', async opened => {
    context.isTauri = false;
    vi.spyOn(window, 'open').mockReturnValue(opened ? window : null);
    expect(await service.openStandaloneWindow('drive', '')).toBe(opened);
    expect(context.closeBrowserOverlay).toHaveBeenCalledTimes(opened ? 1 : 0);
  });
});

describe('Nautilus picker disposal', () => {
  it('destroys the overlay in picker mode before publishing the result, once only', () => {
    const state = signal({ isOpen: true, options: { requestId: 'picker-test' } });
    const events: string[] = [];
    const results = new Subject<FilePickerResult>();
    results.subscribe(result => {
      events.push('result');
      expect(state().isOpen).toBe(false);
      expect(result).toMatchObject({ cancelled: true, paths: [], requestId: 'picker-test' });
    });
    const context = {
      closeFilePicker: NautilusService.prototype.closeFilePicker,
      _filePickerState: state,
      _filePickerResult: results,
      pickerRequest: 1,
      isPickerOpening: true,
      pickerOverlayRef: {
        dispose: (): void => {
          expect(state().isOpen).toBe(true);
          events.push('dispose');
        },
      },
      releasePickerHistory: vi.fn(),
    };
    const service = context as unknown as NautilusService;
    service.closeFilePicker(null);
    service.closeFilePicker(null);
    expect(events).toEqual(['dispose', 'result']);
    expect(context.pickerOverlayRef).toBeNull();
    expect(context.isPickerOpening).toBe(false);
    expect(context.releasePickerHistory).toBeUndefined();
  });

  it.each([true, false])(
    'returns focus after the opener is enabled, unless another picker opened: %s',
    reopened => {
      const button = document.createElement('button');
      document.body.append(button);
      button.disabled = true;
      let frame!: FrameRequestCallback;
      const animation = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
        frame = callback;
        return 1;
      });
      const state = signal({ isOpen: true });
      const context = {
        _filePickerState: state,
        _filePickerResult: new Subject<FilePickerResult>(),
        pickerReturnFocus: button,
        pickerRequest: 1,
      };
      try {
        NautilusService.prototype.closeFilePicker.call(context as unknown as NautilusService, null);
        button.disabled = false;
        state.set({ isOpen: reopened });
        frame(0);
        expect(document.activeElement === button).toBe(!reopened);
      } finally {
        button.remove();
        animation.mockRestore();
      }
    }
  );

  it('does not let a late opening release the history of a newer request', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    const context = {
      vault: { isAccessible: (): boolean => true },
      _filePickerState: signal({ isOpen: false }),
      _filePickerResult: new Subject<FilePickerResult>(),
      pickerRequest: 0,
      isPickerOpening: false,
      pickerOverlayRef: null,
      createPickerOverlay: vi.fn(() => pending),
      navigationHistory: { openLayer: vi.fn() },
      closeFilePicker: NautilusService.prototype.closeFilePicker,
    };
    const service = context as unknown as NautilusService;
    const opening = NautilusService.prototype.openFilePicker.call(service, {
      mode: 'both',
      selection: 'folders',
    });
    service.closeFilePicker(null);
    finish();
    expect(await opening).toBe(false);
    expect(context.navigationHistory.openLayer).not.toHaveBeenCalled();
  });
});
