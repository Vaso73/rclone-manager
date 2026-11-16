RClone Manager - Portable Edition v${VERSION}
==========================================
This is the portable version.
Application settings and the default rclone.conf are stored in the 'config' folder.
Managed rclone.exe and configuration paths are stored relative to this directory's
parent, so moving the entire portable folder does not retain the old drive letter.
Relative paths resolve beside the application, including when started by a shortcut.
Rclone cache, temporary files and the Windows webview profile live under 'cache'.

Updating an existing portable copy:
Before moving it, run this version once in its original directory. Internal absolute
paths are converted to relative paths; your configuration files are not overwritten.
If rclone previously used AppData, copy its configuration into config/rclone.conf
and select that file in the Local backend settings before moving the application.
Explicit external configuration/binary paths and external key files remain external;
include those files and update their paths if you want a self-contained copy.
Do not run the original and a moved copy simultaneously on the same RC port.
You can also import/export settings via the application.

System Requirements:
-------------------
- Microsoft Edge WebView2 Runtime (Required)
  (Usually pre-installed on Windows 10/11)
