# Working on Deadline Reminder

Rules for contributors and coding agents. Read [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md)
first to see what is done and what is next, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for how the code fits together.

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
7. **Lightweight.** No UI frameworks. Production dependencies need a clear reason. Heavy
   libraries (PDF.js, Mammoth, JSZip) must be loaded only on the import path, never on
   the popup's or the manual form's startup path.

## Code rules

- Plain JavaScript ES modules. Pure logic goes in `models/`, `services/` (pure parts) or
  `utils/`, with tests. DOM code goes in `components/` or the page folders.
- Only `services/storage.js` calls `chrome.storage`. Only the service worker calls
  `chrome.alarms` and `chrome.notifications`.
- Build DOM with `h()` from `utils/dom.js`. Never use `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval` or `new Function`.
- Dates: keep `YYYY-MM-DD` strings; use `utils/dates.js`. Never `new Date('YYYY-MM-DD')`.
- Changing the stored shape: bump `CURRENT_SCHEMA_VERSION`, add a migration in
  `services/migrations.js`, and add a test.
- Use design tokens from `styles/tokens.css`; no hard-coded colours in components.
- Accessibility: label every control, keep visible focus, do not rely on colour alone,
  respect reduced motion.
- Comments explain why, not what. Keep them short.

## Before you finish

```powershell
npm run check
```

This runs ESLint, Prettier (check), Vitest and the production build with output
verification. If you changed UI, also load `dist/` as an unpacked extension (or run
`npm run smoke` where Edge is available) and look at the popup and dashboard in light
and dark themes. Do not claim browser testing you did not do.

Update DEVELOPMENT_STATUS.md with what changed and what is next.

## Do not

- Start a new development stage unless asked.
- Modify the original Deadline Planner (Python) repository or copy its data or secrets.
- Commit `dist/`, `node_modules/`, `smoke-output/`, `.pem` keys or backups with real data.
