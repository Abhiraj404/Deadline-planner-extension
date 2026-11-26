# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The version in `package.json` and
`public/manifest.json` must match (checked by the build).

## [1.0.0] - 2026-11-26

### Added

- Reminder system rebuilt around a testable reminder runner: stable alarm ids,
  reconciliation on install, update, start-up and every change; refresh alarm at local
  midnight or the next timed deadline; bounded to 400 alarms.
- Default intervals 14 / 7 / 3 / 1 days, on the deadline day, 1 hour before (timed
  deadlines only) and custom intervals; per-deadline defaults, custom set, or none.
- Notification buttons **Mark complete** and **Snooze**; click opens the deadline.
- Snooze from the popup or dashboard card menu (1 hour, 3 hours, 1 day) with undo.
- Missed-reminder summary after the browser was closed (one notice, up to 3 days back);
  duplicate prevention with stored reminder keys; reminder history in Settings.
- Toolbar badge (due soon, overdue, upcoming or off) with a full text tooltip.
- Popup: grouped list (Pinned, Overdue, Today, Tomorrow, This week, Next week, Later),
  module filter chips, card menu, shortcuts `I` (import) and `D` (dashboard),
  hour/minute countdowns for timed deadlines due within a day.
- Dashboard agenda grouped by Overdue, Today, Tomorrow, This week, Next week, Later.
- Pinned deadlines; module colour labels.
- Restore preview (merge or replace) that never creates duplicates; privacy warning on
  export; separate reset with typed confirmation; storage usage display.
- Optional demo data (add/remove independently) and synthetic demo briefs in
  `demo/briefs/`.
- Release tooling: `npm run package` (ZIP + SHA-256), third-party notices shipped with
  the extension, `npm run release:check` (installs the ZIP in headless Edge and verifies
  a real alarm → notification), GitHub Actions CI with a downloadable build artifact.
- SECURITY.md with the security and privacy audit.

### Changed

- Storage schema version 3 (adds `pinned`, `isDemo`; reminder state kept separately).
- Popup loads dialogs and menus on demand: 48 KB of JavaScript up front (was 65.5 KB).
- Reminder presets renamed ("7 days before"); "2 hours before" replaced by "1 hour before"
  (existing custom values are kept).

### Fixed

- Details dialog no longer fails for records written by an older version without the
  Stage 2 list fields.
- Agenda date ranges are correct when pinned deadlines are listed first.
- Reset now clears storage before optional file storage, so it cannot be blocked.

### Removed

- Superseded merge helpers (`mergeAssessments`, `mergeDocuments`), the unused
  `attachDocument` service method and the editor's metadata-only document link.

## [0.2.0] - 2026-11-26

### Added

- PDF (PDF.js) and DOCX (Mammoth.js) import page with validation, archive-bomb guard,
  progress and cancellation; rule-based extraction with evidence and confidence;
  review screen; SHA-256 duplicate and updated-version detection; document library;
  storage schema 2.

## [0.1.0] - 2026-11-25

### Added

- Manifest V3 extension with popup, dashboard (list, agenda, calendar), manual deadline
  management, reminders, local storage with migrations, backup/restore, themes.
