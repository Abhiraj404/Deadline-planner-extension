# Working on Deadline Reminder

Rules for contributors and coding agents. Read [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md)
first to see what is done and what is next, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how the code fits together, and [docs/DOCUMENT_IMPORT.md](docs/DOCUMENT_IMPORT.md)
before touching document import or extraction.

## Principles

1. **Manual deadlines are first-class.** Every feature must work for a deadline created
   by hand with no document. Document import is optional and must never be required.
2. **One model, one store.** Manual and imported deadlines use the same object and the
   same `assessments` array. Do not add a second storage path. `sourceType` is the only
   difference.
3. **Never invent data.** Unknown values stay `null`. Do not default a weighting, a time
   or a module.
4. **Never overwrite confirmed data silently.** Fields in `confirmedFields` change only
   when the user explicitly approves.
5. **Local-first and private.** No network requests, analytics, accounts or remote code.
6. **Minimal permissions.** Currently `storage`, `alarms`, `notifications`. Adding one
   needs a written reason in DEVELOPMENT_STATUS.md and the README permissions table, and
   an update to `scripts/verify-build.mjs` and `tests/project.test.js`.
7. **Lightweight.** No UI frameworks. Production dependencies need a clear reason. PDF.js
   and Mammoth are imported only by `src/documents/loaders.js` and
   `src/documents/docx-worker.js`; the popup and dashboard must never reach them
   (enforced by `tests/project.test.js` and `scripts/verify-build.mjs`).
8. **Never save unconfirmed extractions.** Extracted values reach storage only through
   `services/imports.js` after the user presses Confirm. Ambiguous dates (no year,
   day/month order, weekday only, several candidates) must never be pre-selected.
9. **Documents are untrusted.** Validate before parsing (`documents/file-checks.js`), keep
   limits configurable, never render document content as HTML, never run macros or
   scripts, never fetch external resources.

## Code rules

- Plain JavaScript ES modules. Pure logic goes in `models/`, `services/` (pure parts) or
  `utils/`, with tests. DOM code goes in `components/` or the page folders.
- Only `services/storage.js` calls `chrome.storage`. Only the service worker (through
  `background/reminder-runner.js`) calls `chrome.alarms`, `chrome.notifications` and
  `chrome.action`. Reminder planning stays pure in `services/reminders.js`.
- No runtime messaging: pages and the worker communicate through storage only. The
  build fails if a message listener, `web_accessible_resources` or
  `externally_connectable` appears.
- Build DOM with `h()` from `utils/dom.js`. Never use `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval` or `new Function`.
- Dates: keep `YYYY-MM-DD` strings; use `utils/dates.js`. Never `new Date('YYYY-MM-DD')`.
- Changing the stored shape: bump `CURRENT_SCHEMA_VERSION`, add a migration in
  `services/migrations.js`, and add a test.
- Use design tokens from `styles/tokens.css`; no hard-coded colours in components.
- Accessibility: label every control, keep visible focus, do not rely on colour alone,
  respect reduced motion.
- Comments explain why, not what. Keep them short.
- The extraction engine (`src/extraction/`) stays pure: no DOM, storage, alarms or
  network. New rules need a case in `tests/extraction.test.js` (or the shared fixtures in
  `tests/fixtures/extraction-cases.json`) and an entry in docs/DOCUMENT_IMPORT.md.
- Every extracted value must carry its `source` (text and page/paragraph location).
- Test documents are synthetic only (`scripts/lib/synthetic-documents.mjs`). Never add
  real college documents to the repository.

## Before you finish

```powershell
npm run check
```

This runs ESLint, Prettier (check), Vitest and the production build with output
verification. If you changed UI, also load `dist/` as an unpacked extension (or run
`npm run smoke` and `npm run fixtures && npm run smoke:import` where Edge is available)
and look at the popup, dashboard and import page in light and dark themes. Do not claim
browser testing you did not do.

Update DEVELOPMENT_STATUS.md with what changed and what is next.

## Releasing

1. Bump the version in **both** `package.json` and `public/manifest.json` (semantic
   versioning; the build fails if they differ) and add a CHANGELOG.md entry.
2. `npm run notices` if production dependencies changed.
3. `npm run check`, then `npm run release:check` (packages the ZIP and installs it in
   headless Edge).
4. Update RELEASE_NOTES.md. Tagging, pushing and publishing are done by the owner.

## Do not

- Start a new development stage unless asked.
- Modify the original Deadline Planner (Python) repository or copy its data or secrets.
- Commit `dist/`, `node_modules/`, `smoke-output/`, `fixtures-output/`, `.pem` keys,
  backups with real data, or real assessment documents.
