# Deadline Reminder 1.0.0

A local-first Chromium extension for assessment deadlines: add them by hand or import
PDF/Word briefs, confirm the extracted details, and get browser reminders. No account,
server or API key.

## Install

1. Download `deadline-reminder-v1.0.0.zip` (and optionally check it against
   `deadline-reminder-v1.0.0.zip.sha256`).
2. Extract it.
3. Open `chrome://extensions` (Microsoft Edge: `edge://extensions`) and turn on
   **Developer mode**.
4. Choose **Load unpacked** and select the extracted `deadline-reminder-v1.0.0` folder
   (it contains `manifest.json`).

Try it with **Settings → Demo data**, or import the synthetic briefs in `demo/briefs/`.

## Highlights

- Manual deadlines with optional details, checklists, notes, pinning and module colours.
- PDF and DOCX import with evidence-backed extraction and a review screen; ambiguous
  dates are never chosen for you.
- Reminders 14/7/3/1 days before, on the day, 1 hour before or custom, with Snooze and
  Mark complete buttons, missed-reminder summaries and a toolbar badge.
- Agenda grouped by Today, Tomorrow, This week, Next week, Later and Overdue.
- Backup with preview and duplicate protection; separate reset; light and dark themes.

## Permissions

`storage`, `alarms`, `notifications`. No website access of any kind.

## Tested

- 218 automated tests (see CI). Headless Microsoft Edge 158: UI, document import, and
  installation from this ZIP including a real alarm creating a real notification.
- **Not tested:** Google Chrome (not available in the test environment), visible
  delivery of notifications by the operating system, screen readers.

## Important

Reminders depend on the browser running and may be a few minutes late. Extracted
deadlines must be checked against the original brief. This is not an official
deadline source.

## Licence

MIT. Third-party notices are included in the ZIP (`THIRD_PARTY_NOTICES.txt`).
