# Changelog

All notable changes to Ambient Forge are documented in this file.

## 0.1.9 - 2026-09-01

- Made local master volume and mute updates smooth and reliable, including a true mute at 0%.
- Prevented stale master-volume messages from overriding newer changes.
- Preserved list position and control focus after Play, Stop, and volume changes.
- Improved fade-out completion to avoid abrupt source teardown and orphan runtimes.
- Added regression coverage for master-volume synchronization and validation.

## 0.1.8 - 2026-08-31

- Applied supported cloud-link normalization immediately after pasting or editing a URL.
- Normalized links when opening existing scenes while keeping saved scenes compatible.

## 0.1.7 - 2026-08-31

- Added automatic conversion of public Dropbox share links to raw media URLs.
- Applied URL normalization both when saving scenes and when starting playback.
- Added tests for Dropbox link conversion and playback compatibility.

