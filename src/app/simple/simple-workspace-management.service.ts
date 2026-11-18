import { Injectable } from '@angular/core';
import { JobInfo } from '@app/types';
import { TauriBaseService } from '../services/infrastructure/platform/tauri-base.service';

export interface ConnectionRemovalReview {
  revision: string;
  dependencies: { kind: string; name: string }[];
}
export interface HistoryRestoreRequest {
  backendName: string;
  root: string;
  path: string;
  name: string;
  destination: string;
  size: number;
  modified: string;
}
export interface HistoryRestoreResult {
  jobId: number;
  destination: string;
  size: number;
  hashType: string | null;
}

/** The backend rechecks identities and dependencies before any mutation. */
@Injectable({ providedIn: 'root' })
export class SimpleWorkspaceManagementService extends TauriBaseService {
  inspectConnection(name: string, backendName: string): Promise<ConnectionRemovalReview> {
    return this.invokeCommand('inspect_connection_removal', { name, backendName });
  }
  removeConnection(name: string, backendName: string, revision: string): Promise<void> {
    return this.invokeCommand('remove_unused_connection', {
      params: { name, backendName, revision },
    });
  }
  removeRecord(job: JobInfo, backendName: string): Promise<void> {
    return this.invokeCommand('remove_finished_record', {
      params: {
        backendName,
        jobId: job.jobid,
        executeId: job.execute_id ?? null,
        startTime: job.start_time,
      },
    });
  }
  restoreHistory(params: HistoryRestoreRequest): Promise<HistoryRestoreResult> {
    return this.invokeCommand('restore_history_copy', { params });
  }
}
