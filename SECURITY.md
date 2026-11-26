# Security and privacy

## Reporting a problem

Please report security issues privately through the repository's
**Security → Report a vulnerability** page rather than a public issue. Include the
browser version and steps to reproduce. There is no bug bounty.

## Design summary

- Everything runs locally. The extension makes no network requests, has no accounts,
  telemetry, analytics, remote code or AI services.
- Permissions: `storage`, `alarms`, `notifications`. No host permissions, content
  scripts, `tabs`, history, cookies, downloads or `unlimitedStorage`.
- No `web_accessible_resources` and no `externally_connectable`: websites cannot load
  extension files or message the extension.
- The service worker registers **no** `runtime.onMessage`/`onMessageExternal`/
  `onConnectExternal` listeners. Pages and the worker share state only through
  `chrome.storage.local`, which only extension pages can access.

## Audit (v1.0.0, 2026-11-26)

| Area                    | Checked                                                                                                                                                                                                                                                                                                                                                                                           | Result                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Manifest permissions    | `public/manifest.json`, enforced by `tests/project.test.js` and `scripts/verify-build.mjs`                                                                                                                                                                                                                                                                                                        | Only `storage`, `alarms`, `notifications`                                                                |
| Content security policy | `script-src 'self'; object-src 'self'` for extension pages                                                                                                                                                                                                                                                                                                                                        | No inline scripts (verified after every build), no `eval`/`new Function`, no remote scripts              |
| Extension messaging     | Build check fails if a message listener appears                                                                                                                                                                                                                                                                                                                                                   | None present                                                                                             |
| Exposed resources       | `web_accessible_resources`, `externally_connectable`                                                                                                                                                                                                                                                                                                                                              | None                                                                                                     |
| DOM rendering           | All text through `textContent`/text nodes (`h()` helper); test forbids `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`                                                                                                                                                                                                                                                           | Document text, titles and notes containing markup render as text (browser-tested with `<script>` titles) |
| Document parsing        | Extension + MIME + signature + size; PDF end marker and active-content scan; ZIP directory checks (entries, ZIP64, encryption, macros, ratio, expanded size); streaming inflate guard against archive bombs; PDF.js with `isEvalSupported: false`, `enableXfa: false`, no font loading; Mammoth's HTML never used, images never decoded; DOCX parsing in a terminable worker; 60 s limit per file | Password-protected, corrupted, macro and archive-bomb files refused (unit- and browser-tested)           |
| Notification actions    | Button and click handlers accept only our own notification ids (`dr-n:<id>`, `dr-missed`); they mark complete, snooze, or open an extension URL built with `chrome.runtime.getURL`                                                                                                                                                                                                                | No external URLs opened                                                                                  |
| Backup restore          | 5 MB limit, JSON only, format marker, migrations + per-record normalisation, preview before applying, confirmation for replace                                                                                                                                                                                                                                                                    | Invalid records skipped; no duplicates                                                                   |
| Storage                 | Only `services/storage.js` calls `chrome.storage`; data normalised on start-up, migration and restore; newer-schema data made read-only                                                                                                                                                                                                                                                           | —                                                                                                        |
| User links              | Submission links must be `http(s)`; opened with `rel="noopener noreferrer"`                                                                                                                                                                                                                                                                                                                       | —                                                                                                        |
| Dependencies            | `npm audit` (all and production)                                                                                                                                                                                                                                                                                                                                                                  | 0 known vulnerabilities on 2026-11-26                                                                    |
| Build configuration     | Source maps only in development builds; release ZIP contains only `dist/` + LICENSE                                                                                                                                                                                                                                                                                                               | —                                                                                                        |

## Privacy notes

- Deadlines, notes, settings, the document library (details, short source quotes,
  SHA-256 fingerprints) and reminder history are stored in this browser profile only.
- Original documents are not stored unless **Keep original files** is turned on (then
  in IndexedDB, in the same profile).
- Notifications show deadline titles and may appear on a lock screen depending on your
  operating system settings.
- Backup files contain your deadlines and notes in plain JSON. Keep them private.
- `localStorage` holds only the theme choice and the dashboard view preference.

## Residual risks

- A maliciously crafted PDF could still exploit an unknown bug in PDF.js; PDF.js runs in
  its own worker without eval or scripting, and is kept up to date.
- Extraction is rule-based and can be wrong; the review screen and the warning in the
  README exist because extracted deadlines must be checked against the original brief.
