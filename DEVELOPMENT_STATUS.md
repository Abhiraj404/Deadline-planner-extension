# Development status

Last updated: 2026-11-25 · Version 0.1.0 · **Stage 1 complete.** Stage 2 has not started.

## Stage 1: foundation, architecture and UI (done)

### Completed

- MV3 extension scaffold built with Vite 8; separate entry points for popup, dashboard
  and service worker; `dist/` is a complete unpacked extension.
- Post-build verification (`scripts/verify-build.mjs`): manifest files exist, no inline
  or remote scripts, no `eval`/`innerHTML`, only the expected permissions.
- Assessment model with `sourceType`, `sourceDocument`, `extractionConfidence`,
  `userConfirmed` and `confirmedFields`; normalisation of any input.
- Storage service: schema version 1, safe idempotent init, migration from the legacy v0
  shape, read-only protection for newer data, readable errors, change subscription,
  skip-unchanged writes.
- Manual deadlines: create (title + date only, or full form with Advanced options), edit,
  delete with undo, complete/restore with undo, checklist toggling.
- Popup: next deadline, upcoming / due soon / completed counts, quick add (title, date,
  category, Enter to submit) with Advanced options, Upcoming/Completed tabs, search,
  theme toggle, settings and dashboard links.
- Dashboard: list, agenda and calendar views; status, module, category and source
  filters; search; sorting; details dialog; settings dialog; hash routes
  (`#settings`, `#deadline=<id>`); responsive from about 320 px to wide screens.
- Categories: eight built-in plus user-defined custom categories.
- Reminders: `chrome.alarms` + `chrome.notifications`, default and per-deadline offsets,
  reminder time of day for date-only deadlines, automatic rescheduling on any change,
  notification click opens the deadline.
- Document preparation: Import Document tab and panel labelled "In development"; PDF/DOCX
  file validation (extension, signature, size, `.docm` refused); link a document to a
  new or existing deadline (metadata only); `compareWithExtraction` and
  `applyDocumentChanges` ready for Stage 2.
- Backup/restore to JSON (merge or replace), delete-all with confirmation.
- Light, dark and system themes via `light-dark()` tokens; no theme flash.
- Accessibility: labelled controls, visible focus, native modal dialogs, ARIA tabs and
  live regions, text + icon urgency, reduced-motion support, keyboard shortcuts.
- Docs: README, ARCHITECTURE, AGENTS, this file.

### Verification (2026-11-25)

- `npm test`: 10 files, 98 tests passing.
- `npm run lint` and `npm run format:check`: clean.
- `npm run build`: passes verification; `dist/` is about 116 KB (16 files).
- Browser: the built extension was loaded unpacked in **headless Microsoft Edge 158**
  via `npm run smoke` (CDP). Checked: service worker starts and initialises storage,
  quick add and validation, live updates via storage events, search, tabs, theme
  switching, add form validation, safe rendering of `<script>` text, details,
  settings, calendar/agenda, no horizontal overflow at 1280 px and 420 px, 11 alarms
  scheduled for seeded data, persistence after reopening the popup, no console errors.
  Screenshots are in `docs/screenshots/`.
- **Not tested:** the real toolbar popup window (headless mode opens the popup page in a
  tab at popup size), Google Chrome (stable Chrome 137+ ignores `--load-extension`),
  an actual notification appearing on screen, and screen-reader output.

## Known limitations

- Reminders fire only while the browser is running.
- No automatic extraction from PDF/DOCX yet (Stage 2).
- No sync between devices; use backup/restore.
- No dedicated "review and approve changes" UI yet for extracted data (the logic exists
  and is tested; the dialog is Stage 2 work).
- Notifications cannot be snoozed.

## Next: Stage 2 (not started; wait for the go-ahead)

Suggested order, based on `CHROME_EXTENSION_PLAN.md` in the original project:

1. Port `assessment_extraction.py` to `src/services/extraction/` as a pure module and run
   the original `tests/fixtures/extraction_cases.json` cases in Vitest.
2. Text readers: PDF.js for PDF (bundled locally, worker as an extension file) and a DOCX
   reader (JSZip + DOMParser or Mammoth). Load them with dynamic `import()` from the
   import panel only, so the popup and manual form never pay for them.
3. Map extraction output to the `Extraction` shape documented in `services/documents.js`.
4. Review dialog: show each difference from `compareWithExtraction` with source text and
   confidence; let the user pick fields; call `service.applyExtraction`. For new
   deadlines, prefill the manual form and create with `sourceType: 'pdf' | 'docx'`.
5. Handle scanned PDFs (no text) with a clear message and a manual fallback.
6. Decide whether to keep document files (IndexedDB) or metadata only.

Requirement to keep in every stage: the extension must remain fully usable as a manual
deadline manager with document extraction disabled.
