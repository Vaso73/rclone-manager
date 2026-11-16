# VSS snapshot helper

The Windows desktop app keeps its existing tray, manual, startup, cron and watch behavior.
`app.useVss` optionally makes sync/copy profiles read through a fixed NTFS snapshot.
Snapshot setup is explicit: the user clicks **Enable VSS helper** and confirms Windows elevation.
Opening a profile or saving an unrelated setting never installs it.

The elevated executable installs only these embedded resources beneath
`CommonApplicationData/RCloneManagerVss/<user SID>` and an on-demand SYSTEM task.
The task has **no triggers** and never receives rclone configuration, credentials, destinations
or commands to execute. It creates/exposes/removes only its owned snapshots. The app keeps
running as the user and transfers files through its existing rclone jobs.

The task action and files are verified before use. Code files are owned by Administrators,
protected from user writes, and byte-matched to the current executable. Only the intended
user can run/read the task. A local-only, first-instance named pipe limits messages and checks
that user's identity after reading the first message. The ordinary process uses identification
security quality of service and also verifies the nonce in a SYSTEM-owned receipt before
accepting a snapshot. It never trusts a pipe response alone.

Sources must be ordinary local paths on one fixed NTFS volume. Multiple files/folders on that
volume are supported. Link following is explicitly disabled on the snapshot filesystem;
there is no fallback to a live source. VSS uses ClientAccessible without application-writer
coordination; it does not save unsaved application memory or guarantee database consistency.

The open connection leases the snapshot. Success requires acknowledged cleanup before
saving a daily-run marker. Failed/cancelled runs release it too; process loss closes the lease.
Protected receipts allow exact ID/volume/computer recovery after interruption. Ambiguous
ownership stops recovery for review; no global VSS deletion is performed. No history retention
or NAS operation is implemented by the helper.

`app.backupHistoryDir` is a separate optional root on the destination filesystem. The existing
rclone backup-dir mechanism receives a unique dated directory for each run and preserves the
original relative tree of replaced/deleted files. Multiple sources have separate source-N
subdirectories. Existing advanced backup-dir options remain usable with this field empty;
configuring both is rejected before a job is submitted. History is never pruned automatically.

`app.autoStartOncePerDay` only limits application-start triggers after a successful real run.
Manual, cron and watch runs remain available. Dry runs, failures, cancellation and unconfirmed
VSS cleanup never count as a successful day. Markers contain only a local calendar date and
are keyed by a hash of backend/profile/operation identity in the ordinary config directory.

Run `Test-VssPolicy.ps1` with PowerShell 5.1 or later. It uses synthetic state and fake CIM
inventory; on Windows it also tests a private native named pipe without creating snapshots
or scheduled tasks. Real Windows UAC, snapshot reading as the ordinary user, and GUI acceptance
remain separate end-to-end checks. The fork's Windows build runs these checks before packaging.

References: [Microsoft VSS requester security](https://learn.microsoft.com/en-us/windows/win32/vss/security-considerations-for-requestors),
[client identification after a pipe read](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient).
