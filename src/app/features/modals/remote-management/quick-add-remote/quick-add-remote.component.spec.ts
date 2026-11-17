import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickAddRemoteComponent } from './quick-add-remote.component';
import { RemoteCreationOrchestrator } from '../../../../services/remote/remote-creation-orchestrator.service';
import { RemoteManagementService } from '../../../../services/remote/remote-management.service';
import { AuthStateService } from '../../../../services/security/auth-state.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { ValidatorRegistryService } from '../../../../services/ui/validation/validator-registry.service';
import { IconService } from '../../../../services/ui/icon.service';
import { PathService } from '../../../../services/infrastructure/platform/path.service';
import { BackendService } from '../../../../services/infrastructure/system/backend.service';
import { PresetValues, RemotePresetsService } from '../../../../services/remote/remote-presets';
import { createInitialInteractiveFlowState } from '../../../../services/remote/utils/interactive-flow.utils';

describe('QuickAddRemoteComponent submission', () => {
  let component: QuickAddRemoteComponent;
  const close = vi.fn();
  const notifyError = vi.fn();
  const createRemote = vi.fn();
  const submitAnswer = vi.fn();
  const flow = signal(createInitialInteractiveFlowState());
  const dialogData = { connectionOnly: false };

  beforeEach(async () => {
    close.mockReset();
    notifyError.mockReset();
    createRemote.mockReset().mockResolvedValue(true);
    submitAnswer.mockReset().mockResolvedValue(false);
    flow.set(createInitialInteractiveFlowState());
    dialogData.connectionOnly = false;
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialogRef, useValue: { close } },
        { provide: MAT_DIALOG_DATA, useValue: dialogData },
        {
          provide: RemoteCreationOrchestrator,
          useValue: {
            createRemote,
            interactiveFlowState: flow,
            isInteractiveContinueDisabled: signal(false),
            oauthHelperUrl: signal(null),
            submitInteractiveAnswer: submitAnswer,
            cancelAuth: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RemoteManagementService,
          useValue: {
            getOAuthSupportedRemotes: vi.fn().mockResolvedValue([]),
            getRemoteTypes: vi.fn().mockResolvedValue([{ name: 'sftp', description: 'SSH/SFTP' }]),
            getRemoteConfigFields: vi.fn().mockResolvedValue([
              { Name: 'host', Required: true, Default: '' },
              { Name: 'user', Required: true, Default: '' },
              { Name: 'pass', Default: '' },
            ]),
            getRemotes: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: AuthStateService,
          useValue: { isAuthInProgress: signal(false), isAuthCancelled: signal(false) },
        },
        { provide: NotificationService, useValue: { showError: notifyError } },
        {
          provide: ValidatorRegistryService,
          useValue: { createRemoteNameValidator: vi.fn().mockReturnValue(() => null) },
        },
        { provide: IconService, useValue: {} },
        PathService,
        { provide: BackendService, useValue: { isWindows: (): boolean => false } },
        { provide: RemotePresetsService, useValue: { resolvePresets: (): PresetValues => ({}) } },
      ],
    });
    component = TestBed.runInInjectionContext(() => new QuickAddRemoteComponent());
    await Promise.resolve();
    await Promise.resolve();
    component.setupFormGroup.patchValue({ name: 'new-remote', type: 'drive' });
  });

  it('creates a connection without operation profiles and passes entered SFTP fields', async () => {
    dialogData.connectionOnly = true;
    const simple = TestBed.runInInjectionContext(() => new QuickAddRemoteComponent());
    await Promise.resolve();
    await Promise.resolve();
    const { FormControl } = await import('@angular/forms');
    simple.setupFormGroup.patchValue({ name: 'NAS', type: 'sftp' });
    simple.setupFormGroup.addControl('host', new FormControl('nas.example'));
    simple.setupFormGroup.addControl('user', new FormControl('backup'));
    simple.setupFormGroup.addControl('port', new FormControl('50022'));
    simple.setupFormGroup.addControl('pass', new FormControl('example-not-a-real-password'));
    expect(simple.remoteTypes()).toContainEqual(expect.objectContaining({ value: 'sftp' }));
    await simple.onSubmit();
    expect(createRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'NAS',
        type: 'sftp',
        host: 'nas.example',
        user: 'backup',
        port: '50022',
      }),
      { showOnTray: true },
      simple.commandOptions()
    );
    expect(close).toHaveBeenCalledWith('NAS');
  });

  it('loads SFTP fields, requires the host and discards fields when the provider changes', async () => {
    dialogData.connectionOnly = true;
    const simple = TestBed.runInInjectionContext(() => new QuickAddRemoteComponent());
    await Promise.resolve();
    await Promise.resolve();
    simple.setupFormGroup.patchValue({ name: 'NAS', type: 'sftp' });
    await simple.loadConnectionFields();
    expect(simple.setupFormGroup.get('host')?.hasError('required')).toBe(true);
    await simple.onSubmit();
    expect(createRemote).not.toHaveBeenCalled();
    simple.setupFormGroup.patchValue({
      host: 'nas.example',
      user: 'backup',
      pass: 'not-a-real-password',
    });
    expect(simple.setupFormGroup.valid).toBe(true);
    vi.mocked(TestBed.inject(RemoteManagementService).getRemoteConfigFields).mockResolvedValue([]);
    simple.setupFormGroup.patchValue({ type: 'drive' });
    await simple.loadConnectionFields();
    expect(simple.setupFormGroup.get('pass')).toBeNull();
  });

  it('offers a usable Drive permission default while preserving an explicit read-only choice', async () => {
    dialogData.connectionOnly = true;
    const simple = TestBed.runInInjectionContext(() => new QuickAddRemoteComponent());
    await Promise.resolve();
    await Promise.resolve();
    vi.mocked(TestBed.inject(RemoteManagementService).getRemoteConfigFields).mockResolvedValue([
      {
        Name: 'scope',
        FieldName: 'Scope',
        Help: '',
        DefaultStr: '',
        Type: 'SpaceSepList',
        Default: [],
      },
    ] as Awaited<ReturnType<RemoteManagementService['getRemoteConfigFields']>>);
    simple.setupFormGroup.patchValue({ name: 'Cloud', type: 'drive' });
    await simple.loadConnectionFields();
    expect(simple.setupFormGroup.get('scope')?.value).toBe('drive');
    simple.setupFormGroup.patchValue({ scope: 'drive.readonly' });
    await simple.onSubmit();
    expect(createRemote).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'drive.readonly' }),
      expect.anything(),
      expect.anything()
    );
  });

  it('discards a late provider response after choosing a different type', async () => {
    dialogData.connectionOnly = true;
    const simple = TestBed.runInInjectionContext(() => new QuickAddRemoteComponent());
    await Promise.resolve();
    await Promise.resolve();
    type Fields = Awaited<ReturnType<RemoteManagementService['getRemoteConfigFields']>>;
    let resolve: (value: Fields) => void = () => {
      throw new Error('Resolver not initialized');
    };
    const promise = new Promise<Fields>(finish => {
      resolve = finish;
    });
    vi.mocked(TestBed.inject(RemoteManagementService).getRemoteConfigFields)
      .mockReturnValueOnce(promise)
      .mockResolvedValueOnce([]);
    simple.setupFormGroup.patchValue({ name: 'NAS', type: 'sftp' });
    const pending = simple.loadConnectionFields();
    simple.setupFormGroup.patchValue({ type: 'drive' });
    await simple.loadConnectionFields();
    resolve([{ Name: 'host', Required: true }] as Awaited<
      ReturnType<RemoteManagementService['getRemoteConfigFields']>
    >);
    await pending;
    expect(simple.setupFormGroup.get('host')).toBeNull();
    expect(simple.fieldsPending()).toBe(false);
  });

  it('delegates complete remote creation and closes only on explicit success', async () => {
    await component.onSubmit();
    expect(createRemote).toHaveBeenCalledWith(
      { name: 'new-remote', type: 'drive' },
      expect.objectContaining({ showOnTray: true, mountConfigs: expect.any(Object) }),
      component.commandOptions()
    );
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('passes OAuth provider overviews to the shared remote configuration step', async () => {
    const overview = { Tier: 'Tier 1', Hashes: ['md5'], Features: ['Copy'] };
    vi.mocked(TestBed.inject(RemoteManagementService).getOAuthSupportedRemotes).mockResolvedValue([
      { name: 'drive', description: 'Google Drive', overview },
    ]);
    await component.initializeComponent();
    expect(component.remoteTypes()).toEqual([{ value: 'drive', label: 'Google Drive', overview }]);
  });

  it('shows errors and retains the form when creation fails', async () => {
    const error = new Error('offline');
    createRemote.mockRejectedValue(error);
    await component.onSubmit();
    expect(notifyError).toHaveBeenCalledWith(error);
    expect(close).not.toHaveBeenCalled();
  });

  it('shows pending interactive questions without claiming completion', async () => {
    createRemote.mockImplementation(async () => {
      flow.update(state => ({ ...state, isActive: true }));
      return false;
    });
    await component.onSubmit();
    expect(component.currentStep()).toBe('interactive');
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps a failed settings finalization available for interactive retry', async () => {
    createRemote.mockImplementation(async () => {
      flow.update(state => ({
        ...state,
        isActive: true,
        question: { State: '', Option: null, Error: '' },
      }));
      throw new Error('disk full');
    });
    await component.onSubmit();
    expect(component.currentStep()).toBe('interactive');
    expect(close).not.toHaveBeenCalled();
  });

  it('blocks navigation and submission while metadata is loading or unavailable', async () => {
    component.isInitializing.set(true);
    component.nextStep();
    await component.onSubmit();
    expect(component.currentStep()).toBe('setup');
    expect(createRemote).not.toHaveBeenCalled();
    component.isInitializing.set(false);
    component.loadFailed.set(true);
    await component.onSubmit();
    expect(createRemote).not.toHaveBeenCalled();
  });

  it('requires a schedule when its automation is enabled', async () => {
    component.quickAddForm.get('operations.sync.cronEnabled')?.setValue(true);
    await component.onSubmit();
    expect(createRemote).not.toHaveBeenCalled();
  });

  it('does not infer success from an inactive interactive flow', async () => {
    await component.onInteractiveContinue(null);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes only when continuation explicitly succeeds', async () => {
    submitAnswer.mockResolvedValue(true);
    await component.onInteractiveContinue('yes');
    expect(close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('ignores repeated continuation clicks while processing', async () => {
    flow.update(state => ({ ...state, isProcessing: true }));
    await component.onInteractiveContinue('yes');
    expect(submitAnswer).not.toHaveBeenCalled();
  });
});
