# Document import and extraction

How Deadline Reminder reads PDF and Word assessment briefs. Everything runs locally in
the browser; no server or AI service is involved and nothing leaves the device.

## Supported formats

| Format         | Library                                                                | Notes                                                                                                                       |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| PDF (`.pdf`)   | [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`, Apache-2.0) | Text-based PDFs. Scanned/image-only PDFs are detected and explained; no OCR.                                                |
| Word (`.docx`) | [Mammoth.js](https://github.com/mwilliamson/mammoth.js) (BSD-2-Clause) | Paragraphs, headings, lists and tables. Headers, footers, footnotes, comments and text boxes outside the body are not read. |

Refused: `.doc`, `.docm`, `.dot`, `.dotx`, `.dotm`, `.rtf`, `.odt` and anything that is
not a real PDF or DOCX. Macros, embedded objects, scripts and external resources are
never run or loaded.

## Pipeline

```text
file → basic checks → read bytes once → SHA-256 → reader → extraction engine → review → save
```

1. **Basic checks** (`src/documents/file-checks.js`): extension, MIME type (generic
   types such as `application/octet-stream` are allowed), size limit, file signature
   (`%PDF-` within the first 1 KB; ZIP `PK\x03\x04` for DOCX). An OLE container renamed
   to `.docx` is reported as password-protected or legacy Word.
2. **Structure checks.**
   - PDF: missing `%%EOF` → "may be incomplete" warning; markers such as `/JavaScript`,
     `/Launch`, `/EmbeddedFile`, `/XFA` → "active content ignored" warning.
   - DOCX: the ZIP central directory is parsed without decompressing. Encrypted
     entries, ZIP64, more than 2,000 entries, a declared expanded size over the limit,
     a compression ratio over 200:1 for parts above 1 MB, missing Word parts and
     `vbaProject.bin` (macros) are rejected. Then every part is test-inflated with the
     built-in `DecompressionStream`, counting bytes and stopping as soon as a part
     exceeds its declared size or the total exceeds the limit (archive-bomb guard,
     even when headers lie).
3. **Hash**: SHA-256 with Web Crypto (`crypto.subtle.digest`).
4. **Read**:
   - PDF.js runs in its own bundled worker with `isEvalSupported: false`,
     `enableXfa: false`, `disableFontFace: true` and no network fetching. Text items are
     grouped into lines by baseline, ordered left to right, with a tab for wide gaps so
     table columns stay apart. Page numbers are kept. Empty pages are listed; a document
     with pages but under 20 characters of text is treated as scanned.
   - Mammoth runs in a dedicated module worker (`docx-worker.js`). Its parsed document
     tree is walked through the `transformDocument` hook; the generated HTML is never
     used. Images are never decoded. Blocks keep a reference such as
     `Paragraph 12 · Deliverables` or `Table 1, row 3 · Marking criteria`.
5. **Extract** (`src/extraction/engine.js`): pure, no browser APIs.
6. **Review** (`src/components/import-review.js`) and **save**
   (`src/services/imports.js`). Nothing is stored before the user confirms.

Each file has a 60-second limit. Cancelling or timing out destroys the PDF.js task or
terminates the DOCX worker. Batches run two files at a time. The file is copied into
memory once; PDF.js and the worker take ownership of that buffer.

### Limits (Settings → Document import)

| Limit                   | Default | Range                                          |
| ----------------------- | ------- | ---------------------------------------------- |
| File size               | 20 MB   | 1–50 MB                                        |
| PDF pages read          | 100     | 1–500 (extra pages are skipped with a warning) |
| Characters of text read | 200,000 | 10,000–1,000,000 (truncated with a warning)    |
| Expanded DOCX size      | 50 MB   | 5–200 MB                                       |
| Files per batch         | 10      | 1–50                                           |

## Extraction rules

The engine accepts normalised content (`{ blocks: [{ text, kind, ref, location }] }`)
or plain text and returns one or more **assessment candidates**. Rules are ported from
the original Python Deadline Planner (`assessment_extraction.py`) and its shared
fixtures (`tests/fixtures/extraction-cases.json`), then extended.

| Field                                        | Rule                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title                                        | `Assessment title:` / `Title:` labels (high); otherwise a leading `CA2 …`, `Assignment 3 …` line (medium).                                                                            |
| Module name / code                           | `Module:` label; a code such as `COMP3010` at its start or a `Module code:` label.                                                                                                    |
| Assessment type                              | `Assessment type:` label (high), otherwise keywords in the title (medium): exam, presentation, group project, lab, assignment.                                                        |
| Weighting                                    | `Weighting: 40%`, `40% of the module grade` (high), `worth 40%` (medium). Several different percentages → low, with the alternatives listed.                                          |
| Submission deadline                          | Dates labelled as submission (see below). Set only when exactly one distinct submission date exists.                                                                                  |
| Submission time                              | The nearest time on the same line, within 40 characters of the date.                                                                                                                  |
| Submission method                            | `Submission method:` label (high), or "submit via/through/on Moodle, Brightspace, Turnitin, Teams, email…" (medium).                                                                  |
| Deliverables, marking criteria, instructions | Items (bullets, list items, table rows, short lines) under headings such as _Deliverables_, _Marking criteria_, _Rubric_, _Instructions_; also lines starting `Important:` / `Note:`. |
| Word count                                   | `Word count: 2,000–2,500`, `max 1500 words`, `1,500-word essay`.                                                                                                                      |
| Presentation date / duration                 | Dates labelled as presentation; `10 minutes`, `15–20 minutes` on a presentation line or after `Duration:`.                                                                            |
| Group size                                   | `Group size: 3–5`, `groups of 3 to 4`, `4-person teams`, or "individual".                                                                                                             |
| Other dates                                  | Release, feedback, late submission, examination, revision and unlabelled dates.                                                                                                       |

**Several assessments in one document:** if at least two short heading lines such as
`CA1 – …`, `Assignment 2`, `Part B` each start a section that contains its own
submission date, each section becomes a candidate. Module details and preamble
instructions are shared.

Every value carries `source: { text, location, ref }` (the line, trimmed to 220
characters, and its page or paragraph). Lists hold at most 20 items of 300 characters.

## Date parsing

Recognised forms: `04/12/2026`, `4.12.26`, `4-12-2026`, `2026-12-04`, `4 December 2026`,
`4th Dec 2026`, `Friday, 4th December 2026`, `December 4, 2026`, `4 December`
(no year) and weekday-only phrases such as `due by Friday`.

Times: `17:00`, `17.00`, `5pm`, `5 PM`, `5:30 p.m.`, `11:59 PM`, `12 noon`, `midday`,
`midnight`.

- **Day first.** Numeric dates are read day/month/year (Irish and European). When both
  readings are possible (`03/04/2027`) the US reading is offered as an alternative and
  nothing is pre-selected.
- **No invented years.** `4 December` gives `value: null` and _suggestions_: the next
  occurrence after the import date first (so a January date seen in December suggests
  next year), then years mentioned elsewhere in the document. A weekday in the text
  narrows the suggestion (`Friday 4 December` suggests the year when 4 December is a
  Friday). 29 February suggests the next leap year.
- **Weekday only.** `Due by Friday at 5 PM` suggests the next two Fridays after the import
  date and is never chosen automatically.
- **Two-digit years** become 20xx with medium confidence.
- **Invalid dates** (`31/02/2027`) are ignored and reported in the warnings.
- **Weekday mismatch** (`Monday 11 December 2026` when it is a Friday) → low confidence.
- **Midnight** is read as 23:59 on that date, with a note and medium confidence.
- **Daylight saving.** Times that do not exist (01:30 on the spring change in Dublin) or
  happen twice (autumn change) are flagged and get low confidence. The time zone is the
  one in Settings (default Europe/Dublin).

### Classifying dates

The closest classifying phrase before the date on the same line wins (a longer phrase
wins a tie, so "late submission" beats "submission"). If nothing precedes the date, the
line above is used (table layouts). Otherwise a phrase shortly after the date is used.

| Label           | Phrases                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Submission      | submission deadline/date/closes, final submission, submit … by/before/on, deadline, due, due date, due by, hand in, closing date, upload … by |
| Presentation    | presentation, viva, demonstration, demo, pitch, interview                                                                                     |
| Late submission | late submission, extension, penalty, grace period                                                                                             |
| Feedback        | feedback, results/grades/marks (will be) released/returned/published                                                                          |
| Release         | released, issue date, published, handed out, available from                                                                                   |
| Examination     | exam, examination, class test, quiz                                                                                                           |
| Revision        | revision (week/session/lecture/class), review session                                                                                         |
| Other           | anything else; "due to" is never a deadline                                                                                                   |

## Confidence indicators

Confidence describes the evidence, not a probability:

| Shown as            | Meaning                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **High confidence** | Explicitly labelled, complete and unambiguous (e.g. `Submission deadline: Friday 11 December 2026 at 17:00`).                                                                |
| **Needs review**    | Inferred from wording, ambiguous (day/month order, several percentages), incomplete (no year, weekday only), contradicted (weekday mismatch) or affected by daylight saving. |
| **Unknown**         | The document does not state it.                                                                                                                                              |

A deadline is pre-selected on the review screen only when exactly one submission date
was found with high confidence. In every other case the user must choose a candidate,
pick a suggestion, or type a date. Nothing is saved without the user pressing
**Confirm and save**.

## Duplicate prevention

| Case                                | How it is detected                                                                                                                                                                | What happens                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Identical file                      | Same SHA-256 hash as a library record                                                                                                                                             | Flagged "Duplicate"; all candidates start as _not imported_.                         |
| Renamed copy                        | Same hash, different file name                                                                                                                                                    | Flagged "Renamed copy"; saving only records the new name as an alias.                |
| Updated version                     | Different hash, and at least two signals among: same file name after removing version noise (`v2`, `(1)`, `final`, dates), same module code, same or similar title, same due date | Flagged "Updated version"; the review shows a comparison with the existing deadline. |
| Different assessment, similar title | Titles with different numbers (`CA1` vs `CA2`) or different module codes are penalised                                                                                            | Treated as new (at most a "Similar to …" note).                                      |
| Several assessments in one file     | Each candidate is matched separately                                                                                                                                              | Each can be created, updated or skipped.                                             |

In a comparison, fields the user typed or confirmed are marked "You entered this" and
are never pre-ticked. Notes, completion, checklist progress and reminders are always
kept; new deliverables, instructions and criteria are appended, never replacing
existing items. When a confirmed due date changes, reminders are rescheduled
automatically.

## Storage behaviour

- **Deadlines** use the same `assessments` list as manual ones. Imported deadlines have
  `sourceType: 'pdf' | 'docx'`, `userConfirmed: true` and `sourceDocument` pointing to
  the library record.
- **Library records** (`documents` in `chrome.storage.local`, schema version 2): id,
  SHA-256 hash, file name and aliases, type, size, import dates, extraction status
  (`complete`, `partial`, `no-text`), page/paragraph count, text length, truncation,
  processing time, warnings, linked deadline ids, previous version id and up to 60
  evidence quotes. About 4 KB per document in testing. The full text is not stored.
- **Original files** are not kept unless **Keep original files** is turned on. Then
  they are stored as Blobs in IndexedDB (`deadline-reminder-files`), can be downloaded
  from the library, and are deleted with the record or when the setting is turned off.
- Deleting document information removes the record, its evidence and any stored file.
  Linked deadlines stay and keep the file name.
- Backups include library records (without files).

## Known limitations

- No OCR: scanned or image-only PDFs give no extracted details (the user can still
  enter them; the document is kept in the library as "No readable text").
- PDF reading order is reconstructed from positions; complex multi-column layouts,
  rotated text and tables with wrapped cells may come out in an unexpected order.
- CJK and other PDFs that need CMaps, and fonts with broken Unicode maps, may extract
  poorly (CMaps are not bundled to keep the extension small).
- DOCX headers, footers, footnotes, comments and floating text boxes are not read.
- Rules are tuned for English-language briefs using Irish/UK conventions; US-style
  numeric dates are offered as an alternative, never assumed.
- Relative phrases other than weekdays ("two weeks after release", "end of week 10")
  are not resolved.
- Multi-assessment detection needs a heading line per assessment and a submission date
  in each section.
- Password-protected PDFs and DOCX files cannot be opened.
