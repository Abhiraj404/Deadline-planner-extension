# Development status

Last updated: 2026-11-26 · **Version 1.0.0** · Storage schema 3 ·
**Stages 1–3 complete; release candidate ready for the owner's review.** Nothing has
been committed, tagged, pushed or published (stages 2 and 3 are uncommitted local
changes on top of the Stage 1 commit `da26f40`).

## Summary of stages

| Stage | Scope                                                                                                                          | State                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 1     | Architecture, popup, dashboard, manual deadlines, storage, themes                                                              | Done (commit `da26f40`) |
| 2     | PDF/DOCX import, extraction, review, duplicates, document library                                                              | Done (uncommitted)      |
| 3     | Reminders, badge, quick actions, agenda, backup preview, demo data, polish, performance, security audit, release tooling, docs | Done (uncommitted)      |

## Stage 3 completed

- **Reminders:** pure planning (`services/reminders.js`) + injected-API runner
  (`background/reminder-runner.js`) + thin service worker. Presets 14/7/3/1 days, on the
  deadline day, 1 hour (timed only), custom intervals; per-deadline default/custom/none.
  Reconcile on install/update/start-up/changes/late alarms/refresh alarm; missed-reminder
  summary (3-day window, 10-minute grace); fired-key dedupe; one notification per
  deadline; Mark complete and Snooze buttons; click opens details; history (last 30).
  Snooze from notification or card menu with undo. Bounded to 400 alarms.
- **Badge:** due soon / overdue / upcoming / off, colour plus full text tooltip; updated
  on every change and at local midnight or the next timed deadline.
- **Popup:** grouped list (Pinned, Overdue, Today, Tomorrow, This week, Next week, Later),
  module chips, card menu (edit, pin, snooze, details), shortcuts N, /, I, D, countdowns.
  Dialog and menu code load on first use.
- **Dashboard:** timeframe agenda, pinned first, module colours, details pin button.
- **Data:** restore preview (merge/replace, no duplicates by id or content), export
  privacy warning, typed-confirmation reset, storage usage, demo data add/remove,
  synthetic demo briefs in `demo/briefs/`.
- **Model:** schema 3 (`pinned`, `isDemo`), separate `reminderState` key.
- **Release:** `npm run package` (ZIP + SHA-256, single top-level folder), third-party
  notices shipped in the extension, version sync check, `npm run release:check`,
  GitHub Actions CI (`.github/workflows/ci.yml`) with an artifact. No auto-publishing.
- **Docs:** README (portfolio), SECURITY, CHANGELOG, RELEASE_NOTES, ARCHITECTURE, AGENTS.

### Bugs fixed in Stage 3

- Details dialog crashed for records lacking Stage 2 list fields (found by the Stage 1
  browser test).
- Agenda "Next week" range label wrong when pinned items were first.
- Reset could stop if IndexedDB was slow to open; storage is now reset first and the
  file store open has an `onblocked` handler.
- `suppliedFields` counted `false` as user-supplied (made `pinned` a confirmed field).
- Test-only: dialogs did not finish closing in background tabs during the release test;
  the test now brings the tab to the front.

## Verification (2026-11-26, v1.0.0)

- `npm run check`: ESLint and Prettier clean; **16 test files, 218 tests passing**;
  build verification passed (manifest paths, pages, permissions, CSP, no inline/remote
  code, no message listeners, version sync, notices present, popup/dashboard cannot
  reach PDF.js or Mammoth).
- `npm audit`: 0 vulnerabilities (all and production).
- **Fresh source copy** (tracked + untracked, non-ignored files only, no
  `node_modules`): `npm ci`, `npm test` (218 passed), `npm run build` (verified).
- **Release ZIP** `release/deadline-reminder-v1.0.0.zip`: 696.5 KB, 32 files, no source
  maps, no personal data (scanned), SHA-256 in the `.sha256` file.
- **Release check** (`npm run release:check`, headless Microsoft Edge 158, ZIP extracted
  with Windows Expand-Archive, fresh profile): 19/19 checks — permissions; demo data via
  Settings; badge text and tooltip; refresh alarm; no overflow at 200% zoom and 320 px;
  grouped popup; card-menu snooze created a snooze alarm; completion cancelled alarms;
  undo restored; **a real `chrome.alarms` alarm fired and `chrome.notifications` created
  the notification**; history recorded; restore preview showed 0 new / 9 skipped and
  created no duplicates; removing demo data kept the real deadline; reset after typing
  RESET; alarms cancelled; no console errors.
- `npm run smoke:import`: 32/32 checks (unchanged from Stage 2) on the 1.0.0 build.
- `npm run smoke`: Stage 1 UI flow, no console errors.

### Performance (before → after Stage 3; synthetic data; Windows, Node 26, Edge 158 headless)

| Measure                            | v0.2.0       | v1.0.0          | Notes                                                  |
| ---------------------------------- | ------------ | --------------- | ------------------------------------------------------ |
| Popup JS loaded up front           | 65.5 KB      | **48.4 KB**     | dialogs/menus lazy-loaded (75.4 KB before that change) |
| Dashboard JS up front              | 88.3 KB      | 106.2 KB        | + agenda groups, menus, settings tools                 |
| Import page JS up front            | 85.8 KB      | 87.0 KB         |                                                        |
| `dist/` total                      | 2,181 KB     | 2,282 KB        | + 77 KB third-party notices                            |
| Release ZIP                        | —            | 696.5 KB        |                                                        |
| Popup load (median of 5)           | 37 ms        | 31–42 ms        | run-to-run noise is larger than the change             |
| Dashboard load (median of 5)       | —            | 26–27 ms        |                                                        |
| Popup / dashboard JS heap          | —            | 2.3 MB / 4.7 MB | `performance.memory`, Chromium only                    |
| PDF 50 pages (Edge)                | 114 ms       | 111 ms          |                                                        |
| DOCX 2,400 paragraphs (Edge)       | 88 ms        | 82 ms           |                                                        |
| Node: PDF 1/10/50/100 pages        | 3/8/34/64 ms | 3/9/35/65 ms    | `npm run measure`                                      |
| Node: DOCX 20/500/2,400 paragraphs | 5/10/32 ms   | 5/10/33 ms      |                                                        |
| Storage after import test          | 25.3 KB      | 25.6 KB         | ≈3.8 KB per library record                             |
| Service worker                     | event-driven | event-driven    | no timers/polling; one refresh alarm                   |

Limitations: headless timings, small synthetic files, one machine; not comparable to a
real toolbar popup on a slower device.

### Browser compatibility

| Browser                                                             | Result                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Microsoft Edge 158 (headless, Windows)                              | All automated browser checks pass                                                                                                  |
| Google Chrome                                                       | **Not tested** — not installed in this environment (also, Chrome 137+ ignores `--load-extension`, so the automated tests use Edge) |
| Real toolbar popup window, visible OS notifications, screen readers | **Not tested** (headless environment)                                                                                              |

## Known limitations

- Reminders require the browser to run; alarms may be minutes late; missed reminders
  older than 3 days are dropped.
- No OCR; DOCX headers/footers/footnotes not read; English, Irish/UK-style rules.
- One browser profile, no sync; unpacked install only.
- Module colours are automatic (hash-based), not user-chosen.
- Notifications show deadline titles (possible lock-screen visibility).

## Before publishing (owner actions)

1. Review and commit (suggested commit message in the session summary).
2. Test once in Google Chrome by hand (Load unpacked → add a deadline with a 2-minute
   custom reminder → confirm the notification and its buttons).
3. Approve the MIT licence (already in `LICENSE`; dependencies are Apache-2.0, BSD-2,
   MIT/ISC — compatible; notices shipped).
4. Create the GitHub release with `release/deadline-reminder-v1.0.0.zip` and `.sha256`.

## Next (not started)

Optional local OCR, reminders for presentation/exam dates, Firefox port, Chrome Web
Store listing. Keep manual deadline management fully usable without document import.
