/**
 * Assessment extraction engine.
 *
 * Input: normalised document content (a list of text blocks, each with a reference
 * such as a page or paragraph number) or plain text.
 * Output: one or more assessment *candidates*. Every value comes with the line it was
 * read from and a confidence level. Nothing is saved here and nothing is guessed:
 * values the text does not state are `null`, and uncertain values are flagged so the
 * review screen can ask the user.
 *
 * No browser APIs are used, so the engine runs the same in tests, workers and pages.
 * The rules are ported from the Python Deadline Planner and extended (see
 * docs/DOCUMENT_IMPORT.md for the full list).
 */

import {
  daylightSavingNote,
  documentYears,
  findDates,
  findNearbyTime,
  findWeekdayMentions,
  nextWeekdays,
} from './date-parser.js';

export const EXTRACTION_SCHEMA_VERSION = 1;
const MAX_LIST_ITEMS = 20;
const MAX_ITEM_CHARS = 300;
const MAX_SOURCE_CHARS = 220;

// ------------------------------------------------------------------ patterns

/**
 * Phrases that classify a date. The closest phrase before the date wins; a longer
 * phrase wins a tie, so "late submission" beats "submission" and "due to" is ignored.
 */
const DATE_LABELS = [
  [
    'submission',
    'submission\\s+(?:deadline|date|closes)|final\\s+submission|submission|submit(?:ted)?(?:\\s+\\w+){0,4}\\s+(?:by|before|on)' +
      '|deadline|due(?:\\s+(?:date|by|on))?(?!\\s+to\\b)|hand(?:ed)?[\\s-]+in|closing\\s+date' +
      '|upload(?:ed)?(?:\\s+\\w+){0,4}\\s+by|upload\\s+date' +
      '|completion(?:\\s+(?:and|&)\\s+(?:upload|submission))?\\s+date',
  ],
  [
    'presentation',
    'presentations?|viva(?:\\s+voce)?|demonstrations?|demos?|pitch(?:es)?|interviews?',
  ],
  ['late_submission', 'late\\s+submissions?|extensions?|penalt(?:y|ies)|grace\\s+period'],
  [
    'feedback',
    'feedback|(?:results?|grades?|marks?)(?:\\s+will\\s+be|\\s+are)?(?:\\s+(?:released|returned|published|available))?',
  ],
  [
    'release',
    'release(?:d)?(?:\\s+date)?|issue(?:d)?(?:\\s+date)?|published|date\\s+of\\s+issue|handed\\s+out|available\\s+from',
  ],
  ['exam', 'exam(?:ination)?s?|class\\s+tests?|in-class\\s+tests?|quiz(?:zes)?'],
  ['revision', 'revision(?:\\s+(?:week|session|lecture|class|day))?|review\\s+session'],
];
const LABEL_PATTERNS = DATE_LABELS.map(([name, source]) => [
  name,
  new RegExp(`\\b(?:${source})\\b`, 'gi'),
]);

export const DATE_LABEL_NAMES = {
  submission: 'Submission',
  presentation: 'Presentation',
  late_submission: 'Late submission',
  feedback: 'Feedback',
  release: 'Release',
  exam: 'Examination',
  revision: 'Revision',
  other: 'Other date',
};

const FIELD_LABEL = '\\s*(?:[:\\-–—]|\\t)\\s*';
const TITLE_PATTERNS = [
  new RegExp(
    `^(?:assessment|assignment|project|coursework)\\s+(?:title|name)${FIELD_LABEL}(?<value>.+)$`,
    'i',
  ),
  new RegExp(`^title${FIELD_LABEL}(?<value>.+)$`, 'i'),
];
const TITLE_FALLBACK =
  /^(?<value>(?:CA|continuous\s+assessment|assignment|assessment|project|coursework|lab(?:oratory)?(?:\s+report)?)\s*\d{1,2}\b.{0,120})$/i;
/** A short line that starts a new assessment inside a multi-assessment brief. */
const ASSESSMENT_HEADING =
  /^(?:CA|continuous\s+assessment|assignment|assessment|project|coursework|lab(?:oratory)?(?:\s+report)?|part)\s*(?:\d{1,2}|[A-D])\b(?!\s*(?:title|name|type)\b)(?![^:]*:\s*\S.*\d{4})/i;
const MODULE_NAME = new RegExp(
  `^(?:module|subject|course)(?:\\s+(?:title|name))?${FIELD_LABEL}(?<value>.+)$`,
  'i',
);
const MODULE_CODE_LABELLED = new RegExp(
  `\\b(?:module|subject|course)\\s+code${FIELD_LABEL}(?<value>[A-Z]{2,6}[\\s-]?[A-Z]?\\d{3,5}[A-Z]?)\\b`,
  'i',
);
const MODULE_CODE_INLINE = /\b(?<value>[A-Z]{2,6}\d{3,5}[A-Z]?)\b/;
/** Table-layout words that follow "Module" in outlines ("MODULE  PER WEEK"), not names. */
const MODULE_GENERIC =
  /^(?:per\s+week|format|code|leader|co-?ordinator|descriptor|overview|outline|details?|information|handbook|aims?|content)$/i;
/** "CA2", "CA 1", "Continuous Assessment 3". */
const CA_TOKEN = /\b(?:CA|continuous\s+assessment)\s*\d{1,2}\b/i;
/** Lines above a CA heading that name the institution or programme, not the module. */
const NOT_A_MODULE =
  /\b(?:department|school|faculty|institute|university|college|bsc|ba|msc|meng|beng|programme|lecturer|semester)\b|@|:/i;
const GROUP_PROJECT =
  /\bgroup\s+(?:project|work|assignment|report|CA)\b|\bgroup[\s-]+based\b|\bteam\s+project\b/i;
const DATES_TBC =
  /\b(?:exact\s+)?dates?\b.{0,20}\b(?:to\s+be\s+(?:confirmed|announced|decided)|tbc|tba|tbd)\b/i;

const PERCENT = '(?<value>\\d{1,3}(?:[.,]\\d+)?)\\s*%';
const WEIGHT_PATTERNS = [
  [
    'high',
    new RegExp(
      `\\b(?:assessment\\s+)?weight(?:ing)?(?:${FIELD_LABEL}|\\s+(?:is|of)\\s+|\\s+)${PERCENT}`,
      'gi',
    ),
  ],
  [
    'high',
    new RegExp(
      `${PERCENT}\\s+(?:of|towards)\\s+(?:the\\s+)?(?:overall\\s+|final\\s+|total\\s+)?(?:module|course|final|overall)\\s*(?:grade|mark|result|assessment)?\\b`,
      'gi',
    ),
  ],
  ['medium', new RegExp(`\\bworth\\s+${PERCENT}`, 'gi')],
  // "Web Patterns – CA1 – 30%", "CA2 (30%)", "Marks awarded: (30%)"
  [
    'medium',
    new RegExp(
      `\\b(?:CA|continuous\\s+assessment)\\s*\\d{1,2}\\s*(?:[–—-]|\\()\\s*${PERCENT}`,
      'gi',
    ),
  ],
  ['medium', new RegExp(`\\bmarks?\\s+awarded\\s*:?\\s*\\(?\\s*${PERCENT}`, 'gi')],
];

const NUMBER = '(?:\\d{1,2},\\d{3}|\\d{3,5})';
const WORD_COUNT_PATTERNS = [
  new RegExp(
    `\\b(?:word\\s+(?:count|limit)|length)\\s*(?:[:\\-–]|is|of)?\\s*(?:approx(?:\\.|imately)?\\s+|max(?:imum)?(?:\\s+of)?\\s+|up\\s+to\\s+|between\\s+)?` +
      `(?<low>${NUMBER})(?:\\s*(?:-|–|to|and)\\s*(?<high>${NUMBER}))?(?:\\s*words?)?`,
    'i',
  ),
  new RegExp(
    `\\b(?<low>${NUMBER})(?:\\s*(?:-|–|to)\\s*(?<high>${NUMBER}))?\\s*(?:-\\s*)?words?\\b`,
    'i',
  ),
];

const SUBMISSION_METHOD_LABELLED = new RegExp(
  `^(?:submission\\s+(?:method|platform|format|via)|how\\s+to\\s+submit|submit\\s+via)${FIELD_LABEL}(?<value>.+)$`,
  'i',
);
const SUBMISSION_METHOD_INLINE =
  /\b(?:submit(?:ted)?|upload(?:ed)?|hand(?:ed)?[\s-]*in|submissions?)\b[^.\n]{0,40}?\b(?:via|through|on|to|using|in)\s+(?<value>(?:the\s+)?(?:Moodle|Brightspace|Blackboard|Canvas|Turnitin|(?:Microsoft\s+)?Teams|GitHub|GitLab|Google\s+Classroom|e-?mail|in\s+person|hard\s+copy|[A-Z][\w-]*\s+(?:portal|dropbox|page))(?:\s+(?:assignment\s+)?(?:link|page|dropbox|portal))?)/i;

const PRESENTATION_WORD = /\b(?:presentations?|viva|demo(?:nstration)?s?|pitch(?:es)?)\b/i;
const DURATION =
  /\b(?<value>\d{1,3})(?:\s*(?:-|–|to)\s*(?<high>\d{1,3}))?[\s-]*(?:minutes?|mins?)\b/i;
const GROUP_SIZE_PATTERNS = [
  [
    'high',
    new RegExp(
      `\\b(?:group|team)\\s+size${FIELD_LABEL}(?<low>\\d{1,2})(?:\\s*(?:-|–|to|or)\\s*(?<high>\\d{1,2}))?`,
      'i',
    ),
  ],
  [
    'medium',
    /\b(?:groups?|teams?)\s+of\s+(?:up\s+to\s+)?(?<low>\d{1,2})(?:\s*(?:-|–|to|or)\s*(?<high>\d{1,2}))?\b/i,
  ],
  [
    'medium',
    /\b(?<low>\d{1,2})(?:\s*(?:-|–|to)\s*(?<high>\d{1,2}))?[\s-]*(?:person|member|student)s?\s+(?:groups?|teams?)\b/i,
  ],
];
const INDIVIDUAL =
  /\b(?:individual|individually|on\s+your\s+own)\b(?:\s+(?:assessment|assignment|work|project|submission))?/i;

const ASSESSMENT_TYPE_LABEL = new RegExp(
  `^(?:assessment|assignment)\\s+type${FIELD_LABEL}(?<value>.+)$`,
  'i',
);
const TYPE_KEYWORDS = [
  ['exam', /\b(?:exam(?:ination)?|class\s+test|in-class\s+test|quiz|mcq)\b/i],
  ['presentation', /\b(?:presentation|pitch|viva|demo(?:nstration)?|poster)\b/i],
  [
    'group-project',
    /\bgroup\s+(?:project|work|assignment|report|CA)\b|\bgroup[\s-]+based\b|\bteam\s+project\b/i,
  ],
  ['lab', /\b(?:lab(?:oratory)?|practical)\b/i],
  [
    'assignment',
    /\b(?:essay|report|assignment|coursework|project|portfolio|reflection|CA\s*\d)\b/i,
  ],
];

const SECTION_HEADINGS = {
  deliverables:
    /^(?:deliverables?|what\s+(?:to|you\s+(?:must|should|need\s+to))\s+submit|submission\s+(?:requirements|contents|checklist)|you\s+must\s+submit|required\s+submissions?)\b/i,
  markingCriteria:
    /^(?:marking\s+(?:criteria|scheme|rubric|breakdown|guide)|assessment\s+criteria|grading\s+(?:criteria|rubric)|rubric|mark\s+allocation|marks?\s+breakdown|marks?\s+(?:will\s+be\s+|are\s+)?awarded\s+as\s+follows)\b/i,
  instructions:
    /^(?:instructions?|important(?:\s+(?:information|notes?))?|notes?|guidelines?|submission\s+instructions|academic\s+integrity|plagiarism|general\s+information)\b/i,
};
const BULLET = /^\s*(?:[-*•▪◦●·]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/i;
const INSTRUCTION_LINE = /^(?:important|note|n\.b\.?|please\s+note)\b\s*[:\-–]?/i;

// ------------------------------------------------------------------ helpers

function clip(text, limit = MAX_ITEM_CHARS) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Turn the input into lines, each remembering where it came from.
 * Accepts a string, or `{ blocks: [{ text, kind, ref, location }] }`.
 */
export function toLines(content) {
  const blocks =
    typeof content === 'string' || content === null || content === undefined
      ? String(content ?? '')
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((text, index) => ({
            text,
            kind: 'line',
            ref: { line: index + 1 },
            location: `Line ${index + 1}`,
          }))
      : (content.blocks ?? []);
  const lines = [];
  for (const block of blocks) {
    for (const part of String(block.text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')) {
      lines.push({
        text: part.trim(),
        kind: block.kind ?? 'paragraph',
        ref: block.ref ?? null,
        location: block.location ?? null,
      });
    }
  }
  return lines;
}

function source(line) {
  return { text: clip(line.text, MAX_SOURCE_CHARS), location: line.location, ref: line.ref };
}

function field(value, line, confidence, extra = {}) {
  return { value, confidence, source: source(line), ...extra };
}

/** A blank form field such as "Title: ________" or "Name: ....". */
function isPlaceholder(value) {
  const letters = value.replace(/[_.…\s\-–—]+/g, '');
  return letters.length === 0 || (/_{3,}|\.{4,}/.test(value) && letters.length < 3);
}

function labelled(lines, patterns) {
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = pattern.exec(line.text);
      const value = match?.groups.value.trim().replace(/^[\s.]+|[\s.]+$/g, '');
      if (value && !isPlaceholder(value)) return { value, line };
    }
  }
  return null;
}

const SEPARATOR = /\s+[–—-]+\s*|\s*[–—-]+\s+/;
const DROP_PART =
  /^(?:released?|issued?|due|deadline|sem(?:ester)?\b|stage\s+\d|year\s+\d)|\b(?:19|20)\d{2}\b/i;

/**
 * The heading most briefs open with: "Web Patterns – CA1 – 30% – The DAO Pattern",
 * "Cloud Foundations CA2 - Project Marks awarded: (30%)", or "Web Services" on one line
 * and "CA2 - Group Based (worth 45%)" on the next. Gives a module name and a title.
 */
function headerFields(lines) {
  const nonEmpty = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.text);
  for (const [position, { line }] of nonEmpty.slice(0, 15).entries()) {
    const text = line.text;
    if (text.includes('\t') || text.length > 140) continue;
    const token = CA_TOKEN.exec(text);
    if (!token) continue;

    let module = null;
    const before = text
      .slice(0, token.index)
      .replace(/[\s–—\-:|,]+$/, '')
      .trim();
    if (before && /[a-z]{3}/i.test(before) && before.length <= 60 && !NOT_A_MODULE.test(before)) {
      module = field(before, line, 'medium');
    } else if (!before && position > 0) {
      const above = nonEmpty[position - 1].line;
      const name = above.text
        .replace(/\s*[–—-]\s*(?:stage|year|semester|sem|level)\s*\d+.*$/i, '')
        .trim();
      if (
        name.length >= 3 &&
        name.length <= 60 &&
        /[a-z]{3}/i.test(name) &&
        !above.text.includes('\t') &&
        !NOT_A_MODULE.test(name) &&
        !CA_TOKEN.test(name)
      ) {
        module = field(name, above, 'medium');
      }
    }

    const parts = text
      .slice(token.index + token[0].length)
      .split(SEPARATOR)
      .map((part) =>
        part
          .replace(/\(\s*(?:worth\s*)?\d{1,3}\s*%\s*\)/gi, '')
          .replace(/\b(?:worth|marks?\s+awarded)\s*:?\s*(?:\d{1,3}\s*%)?/gi, '')
          .replace(/\b\d{1,3}\s*%/g, '')
          .replace(/^[\s:()\-–—]+|[\s:(\-–—]+$/g, '')
          .trim(),
      )
      .filter((part) => part && !DROP_PART.test(part));
    const tokenText = token[0].replace(/\s+/g, ' ');
    const title =
      parts.length > 0
        ? [tokenText, ...parts].join(' – ')
        : module
          ? `${module.value} ${tokenText}`
          : tokenText;
    return { title: field(clip(title, 200), line, 'medium'), module };
  }
  return null;
}

/** Find the label for a date: closest phrase before it, or the line above (tables). */
function classify(lines, lineIndex, start, end) {
  const text = lines[lineIndex].text;
  let context = text.slice(Math.max(0, start - 120), start);
  if (!context.trim() && lineIndex > 0) context = lines[lineIndex - 1].text;
  let best = null;
  for (const [name, pattern] of LABEL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of context.matchAll(pattern)) {
      const rank = [match.index + match[0].length, match[0].length];
      if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) {
        best = { rank, name };
      }
    }
  }
  if (best) return best.name;
  const after = text.slice(end, end + 60);
  for (const [name, pattern] of LABEL_PATTERNS) {
    pattern.lastIndex = 0;
    if (name !== 'submission' && pattern.test(after)) return name;
  }
  return 'other';
}

// ------------------------------------------------------------------ field extractors

function extractDates(lines, { referenceDate, timeZone }) {
  const all = [];
  const invalid = [];
  const perLine = lines.map((line) => findDates(line.text, { referenceDate }));
  const years = documentYears(perLine.flatMap((result) => result.dates));

  perLine.forEach(({ dates, invalid: bad }, index) => {
    const line = lines[index];
    for (const item of bad) invalid.push({ text: item.text, source: source(line) });
    for (const item of dates) {
      const label = classify(lines, index, item.start, item.end);
      const time = findNearbyTime(line.text, item.start, item.end, dates);
      const notes = [...item.notes];
      let confidence = item.confidence;
      if (time?.midnight) {
        notes.push('"Midnight" read as 23:59 on this date. Check the brief.');
        if (confidence === 'high') confidence = 'medium';
      }
      let suggestions = item.suggestions;
      if (item.yearMissing) {
        // Prefer years the document itself mentions, after the next occurrence.
        const monthDay = suggestions[0]?.slice(5);
        if (monthDay) {
          const extra = years
            .map((year) => `${year}-${monthDay}`)
            .filter((date) => !suggestions.includes(date) && !Number.isNaN(Date.parse(date)));
          suggestions = [...suggestions, ...extra].slice(0, 3);
        }
      }
      const dst = daylightSavingNote(item.value, time?.time ?? null, timeZone);
      if (dst) {
        notes.push(dst);
        confidence = 'low';
      }
      all.push({
        value: item.value,
        time: time?.time ?? null,
        matchedText: item.text,
        label,
        confidence,
        notes,
        alternatives: item.alternatives,
        suggestions,
        yearMissing: item.yearMissing,
        weekdayOnly: false,
        source: source(line),
        lineIndex: index,
      });
    }

    // "Due by Friday at 5 PM": a weekday with no date. Only reported for submission
    // wording, and only as a suggestion based on the reference date.
    if (dates.length === 0 && referenceDate) {
      for (const mention of findWeekdayMentions(line.text)) {
        const label = classify(lines, index, mention.start, mention.end);
        if (label !== 'submission') continue;
        const time = findNearbyTime(line.text, mention.start, mention.end, []);
        all.push({
          value: null,
          time: time?.time ?? null,
          matchedText: mention.text,
          label,
          confidence: 'low',
          notes: ['Only a weekday is given. The suggested dates are based on the import date.'],
          alternatives: [],
          suggestions: nextWeekdays(mention.weekday, referenceDate, 2),
          yearMissing: false,
          weekdayOnly: true,
          source: source(line),
          lineIndex: index,
        });
      }
    }
  });
  return { dates: all, invalid };
}

function moduleFields(lines, header = null) {
  const labelledModule = labelled(lines, [MODULE_NAME]);
  const module =
    labelledModule && !MODULE_GENERIC.test(labelledModule.value) ? labelledModule : null;
  let moduleName = module ? null : (header?.module ?? null);
  let moduleCode = null;
  if (module) {
    let name = module.value;
    const inside = MODULE_CODE_INLINE.exec(name);
    if (inside && inside.index === 0) {
      // "Module: COMP3010 Software Engineering" carries the code inside the name.
      name = name.slice(inside[0].length).replace(/^[\s:\-–—]+/, '') || name;
    }
    moduleName = field(name, module.line, 'high');
  }
  for (const line of lines) {
    const match = MODULE_CODE_LABELLED.exec(line.text);
    if (match) {
      moduleCode = field(match.groups.value.replace(/\s+/g, '').toUpperCase(), line, 'high');
      break;
    }
  }
  if (!moduleCode && module) {
    const inline = MODULE_CODE_INLINE.exec(module.value);
    if (inline) moduleCode = field(inline.groups.value, module.line, 'medium');
  }
  return { moduleName, moduleCode };
}

function weighting(lines) {
  const found = new Map();
  for (const line of lines) {
    for (const [confidence, pattern] of WEIGHT_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.text.matchAll(pattern)) {
        const number = Number(match.groups.value.replace(',', '.'));
        if (number > 0 && number <= 100 && !found.has(number))
          found.set(number, { line, confidence });
      }
    }
  }
  if (found.size === 0) return null;
  const [[value, { line, confidence }]] = found;
  if (found.size === 1) return field(value, line, confidence);
  // Several percentages usually describe marking criteria, not the weighting.
  return field(value, line, 'low', {
    alternatives: [...found.keys()].sort((a, b) => a - b),
    notes: ['Several percentages were found. Check which one is the weighting.'],
  });
}

function wordCount(lines) {
  for (const [index, pattern] of WORD_COUNT_PATTERNS.entries()) {
    for (const line of lines) {
      const match = pattern.exec(line.text);
      if (!match) continue;
      const low = Number(match.groups.low.replace(',', ''));
      const high = match.groups.high ? Number(match.groups.high.replace(',', '')) : null;
      if (low < 50 || (high !== null && high < low)) continue;
      const format = (n) => n.toLocaleString('en-IE');
      return field(
        high ? `${format(low)}–${format(high)} words` : `${format(low)} words`,
        line,
        index === 0 ? 'high' : 'medium',
        {
          minimum: high ? low : null,
          maximum: high ?? low,
        },
      );
    }
  }
  return null;
}

function submissionMethod(lines) {
  const explicit = labelled(lines, [SUBMISSION_METHOD_LABELLED]);
  if (explicit) return field(clip(explicit.value, 120), explicit.line, 'high');
  for (const line of lines) {
    const match = SUBMISSION_METHOD_INLINE.exec(line.text);
    if (match) {
      const value = match.groups.value.replace(/^the\s+/i, '').trim();
      return field(value.charAt(0).toUpperCase() + value.slice(1), line, 'medium');
    }
  }
  return null;
}

function presentationDuration(lines) {
  for (const line of lines) {
    if (!PRESENTATION_WORD.test(line.text) && !/^duration\b/i.test(line.text)) continue;
    const match = DURATION.exec(line.text);
    if (!match) continue;
    const low = Number(match.groups.value);
    const high = match.groups.high ? Number(match.groups.high) : null;
    if (low < 1 || low > 240) continue;
    return field(
      high ? `${low}–${high} minutes` : `${low} minutes`,
      line,
      /^duration\b/i.test(line.text) ? 'high' : 'medium',
      {
        minutes: high ?? low,
      },
    );
  }
  return null;
}

function groupSize(lines) {
  for (const [confidence, pattern] of GROUP_SIZE_PATTERNS) {
    for (const line of lines) {
      const match = pattern.exec(line.text);
      if (!match) continue;
      const low = Number(match.groups.low);
      const high = match.groups.high ? Number(match.groups.high) : null;
      if (low < 1 || low > 20 || (high !== null && (high < low || high > 20))) continue;
      return field(high ? `${low}–${high} students` : `${low} students`, line, confidence, {
        minimum: low,
        maximum: high ?? low,
      });
    }
  }
  for (const line of lines) {
    if (INDIVIDUAL.test(line.text))
      return field('Individual', line, 'medium', { minimum: 1, maximum: 1 });
  }
  return null;
}

/** Map a phrase to a built-in category id. */
export function categoryFromText(text) {
  for (const [category, pattern] of TYPE_KEYWORDS) if (pattern.test(text)) return category;
  return null;
}

function assessmentType(lines, titleField) {
  const explicit = labelled(lines, [ASSESSMENT_TYPE_LABEL]);
  if (explicit) {
    const category = categoryFromText(explicit.value);
    if (category) return field(category, explicit.line, 'high', { label: explicit.value });
  }
  const fromTitle = titleField ? categoryFromText(titleField.value) : null;
  if (!fromTitle || fromTitle === 'assignment') {
    // "This Group CA covers…", "Group Project -(Design…)" near the top of the brief.
    const group = lines.slice(0, 30).find((line) => GROUP_PROJECT.test(line.text));
    if (group) return field('group-project', group, 'medium', { label: clip(group.text, 80) });
  }
  if (fromTitle)
    return {
      value: fromTitle,
      confidence: 'medium',
      source: titleField.source,
      label: titleField.value,
    };
  return null;
}

function sections(lines) {
  const result = { deliverables: [], markingCriteria: [], instructions: [] };
  let current = null;
  for (const line of lines) {
    if (!line.text) continue;
    const heading = Object.keys(SECTION_HEADINGS).find((name) =>
      SECTION_HEADINGS[name].test(line.text),
    );
    if (heading && line.text.length <= 80) {
      current = heading;
      const remainder = line.text.split(/[:\-–]\s*/);
      if (remainder.length >= 2 && remainder.slice(1).join(' ').trim().length > 3) {
        result[current].push(field(clip(remainder.slice(1).join(' ')), line, 'medium'));
      }
      continue;
    }
    if (current === null) continue;
    const isBullet = BULLET.test(line.text) || line.kind === 'listItem';
    const looksLikeHeading =
      (line.kind === 'heading' || (line.text.length <= 60 && line.text.endsWith(':'))) && !isBullet;
    if (looksLikeHeading) {
      current = null;
      continue;
    }
    if (result[current].length < MAX_LIST_ITEMS) {
      const item = clip(line.text.replace(BULLET, '').replace(/\t+/g, ' — '));
      result[current].push(
        field(item, line, isBullet || line.kind === 'tableRow' ? 'high' : 'medium'),
      );
    }
  }
  for (const line of lines) {
    if (INSTRUCTION_LINE.test(line.text) && result.instructions.length < MAX_LIST_ITEMS) {
      const value = clip(line.text.replace(INSTRUCTION_LINE, '').trim() || line.text);
      if (!result.instructions.some((item) => item.value === value)) {
        result.instructions.push(field(value, line, 'medium'));
      }
    }
  }
  return result;
}

const stripLineIndex = ({ lineIndex: _lineIndex, ...rest }) => rest;

/** The extraction for one assessment (the whole document, or one section of it). */
function extractCandidate(lines, allDates, shared, key) {
  const warnings = [];
  const titleMatch = labelled(lines, TITLE_PATTERNS);
  let title = titleMatch ? field(titleMatch.value, titleMatch.line, 'high') : null;
  if (!title && shared.header?.title) title = shared.header.title;
  if (!title) {
    // Table rows ("CA 1 – 15%<tab>CA 1 – 20%") are marking schemes, not titles.
    const rows = lines.slice(0, 40).filter((line) => !line.text.includes('\t'));
    const fallback = labelled(rows, [TITLE_FALLBACK]);
    if (fallback) title = field(fallback.value, fallback.line, 'medium');
  }

  const dates = allDates.map(stripLineIndex);
  const submissions = dates.filter((item) => item.label === 'submission');
  const distinct = new Set(
    submissions.map((item) => (item.value ? item.value : `?${item.matchedText}`)),
  );
  let submissionDeadline = null;
  if (distinct.size === 1) {
    submissionDeadline = submissions[0];
    if (!submissionDeadline.value)
      warnings.push('The submission date is incomplete. Choose or enter the full date.');
  } else if (distinct.size > 1) {
    warnings.push('Several possible submission dates were found. Choose the correct one.');
  } else if (dates.length) {
    warnings.push('Dates were found, but none is labelled as the submission deadline.');
  } else {
    warnings.push('No submission date was found.');
  }
  const times = new Set(submissions.map((item) => item.time).filter(Boolean));
  let submissionTime = null;
  if (submissionDeadline?.time) {
    submissionTime = {
      value: submissionDeadline.time,
      confidence: submissionDeadline.confidence === 'high' ? 'high' : 'medium',
      source: submissionDeadline.source,
    };
  } else if (times.size > 1) {
    warnings.push('Several submission times were found.');
  }
  if (submissionDeadline && submissionDeadline.value && !submissionDeadline.time) {
    warnings.push(
      'No submission time was found. The deadline will be the end of the day unless you add a time.',
    );
  }

  const presentationDates = dates.filter((item) => item.label === 'presentation');
  const otherDates = dates.filter(
    (item) => item.label !== 'submission' && item.label !== 'presentation',
  );
  const found = sections(lines);
  const needsConfirmation = !(
    submissionDeadline?.value &&
    submissionDeadline.confidence === 'high' &&
    distinct.size === 1
  );

  return {
    key,
    title,
    moduleName: shared.moduleName,
    moduleCode: shared.moduleCode,
    assessmentType: assessmentType(lines, title),
    weighting: weighting(lines),
    submissionDeadline,
    submissionTime,
    deadlineCandidates: submissions,
    submissionMethod: submissionMethod(lines) ?? shared.submissionMethod,
    wordCount: wordCount(lines),
    presentation: {
      dates: presentationDates,
      duration: presentationDuration(lines),
    },
    groupSize: groupSize(lines),
    deliverables: found.deliverables,
    markingCriteria: found.markingCriteria,
    instructions: [
      ...found.instructions,
      ...shared.instructions.filter(
        (item) => !found.instructions.some((own) => own.value === item.value),
      ),
    ].slice(0, MAX_LIST_ITEMS),
    otherDates,
    needsConfirmation,
    warnings,
  };
}

/** Split a brief that describes several assessments ("CA1 …", "CA2 …") into sections. */
function splitAssessments(lines, dates) {
  const headings = [];
  lines.forEach((line, index) => {
    if (!line.text || line.text.length > 100) return;
    if (ASSESSMENT_HEADING.test(line.text) && (line.kind === 'heading' || line.text.length <= 80)) {
      headings.push(index);
    }
  });
  const distinctHeadings = new Set(headings.map((index) => lines[index].text.toLowerCase()));
  if (headings.length < 2 || distinctHeadings.size < 2) return null;
  const segments = headings.map((start, i) => ({ start, end: headings[i + 1] ?? lines.length }));
  const withDeadline = segments.filter((segment) =>
    dates.some(
      (item) =>
        item.label === 'submission' &&
        item.lineIndex >= segment.start &&
        item.lineIndex < segment.end,
    ),
  );
  // The same date repeated in two sections ("Part 5 … Submission Date") is one deadline.
  const distinctDeadlines = new Set(
    dates
      .filter((item) => item.label === 'submission')
      .map((item) => item.value ?? item.matchedText),
  );
  return withDeadline.length >= 2 && distinctDeadlines.size >= 2 ? segments : null;
}

/**
 * Extract assessment candidates from a document.
 *
 * @param {string | { blocks: object[] }} content
 * @param {object} [options]
 * @param {string} [options.referenceDate] YYYY-MM-DD, used only to *suggest* years
 *   for dates written without one. Defaults to no suggestions.
 * @param {string} [options.timeZone] for daylight-saving checks (default Europe/Dublin)
 */
export function extractAssessments(
  content,
  { referenceDate = null, timeZone = 'Europe/Dublin' } = {},
) {
  const lines = toLines(content);
  const { dates, invalid } = extractDates(lines, { referenceDate, timeZone });
  const header = headerFields(lines);
  const modules = moduleFields(lines, header);
  const warnings = invalid.map(
    (item) =>
      `“${item.text}” is not a real date and was ignored (${item.source.location ?? 'document'}).`,
  );
  const tbc = lines.find((line) => DATES_TBC.test(line.text));
  if (tbc) {
    warnings.push(
      `The document says dates are still to be confirmed (${tbc.location ?? 'document'}). Check for an updated brief.`,
    );
  }

  const segments = splitAssessments(lines, dates);
  let assessments;
  if (segments) {
    const firstStart = segments[0].start;
    const preamble = lines.slice(0, firstStart);
    const shared = {
      ...modules,
      submissionMethod: submissionMethod(preamble),
      instructions: sections(preamble).instructions,
    };
    assessments = segments.map((segment, index) => {
      const segmentLines = lines.slice(segment.start, segment.end);
      const segmentDates = dates.filter(
        (item) => item.lineIndex >= segment.start && item.lineIndex < segment.end,
      );
      const candidate = extractCandidate(
        segmentLines,
        segmentDates,
        shared,
        `assessment-${index + 1}`,
      );
      if (!candidate.title || candidate.title.confidence !== 'high') {
        candidate.title = field(
          clip(lines[segment.start].text.replace(/[:\s]+$/, ''), 200),
          lines[segment.start],
          'medium',
        );
        candidate.assessmentType ??= assessmentType(segmentLines, candidate.title);
      }
      return candidate;
    });
    warnings.push(
      `This document appears to describe ${assessments.length} assessments. Review each one.`,
    );
  } else {
    assessments = [
      extractCandidate(
        lines,
        dates,
        { ...modules, header, submissionMethod: null, instructions: [] },
        'assessment-1',
      ),
    ];
  }

  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    assessments,
    moduleName: modules.moduleName,
    moduleCode: modules.moduleCode,
    allDates: dates.map(stripLineIndex),
    invalidDates: invalid,
    warnings,
    stats: { lines: lines.filter((line) => line.text).length, dates: dates.length },
  };
}

// ------------------------------------------------------------------ confidence

/**
 * Plain-language confidence used in the UI. The categories describe evidence, not
 * probability: "High confidence" means the value was labelled explicitly and nothing
 * contradicted it; "Needs review" means it was inferred, ambiguous or incomplete;
 * "Unknown" means the document did not state it.
 */
export function confidenceCategory(fieldValue) {
  if (!fieldValue || (fieldValue.value === null && !fieldValue.suggestions?.length))
    return 'unknown';
  if (fieldValue.value === null) return 'review';
  return fieldValue.confidence === 'high' && !(fieldValue.alternatives?.length > 0)
    ? 'high'
    : 'review';
}

export const CONFIDENCE_LABELS = {
  high: 'High confidence',
  review: 'Needs review',
  unknown: 'Unknown',
};

/** Overall confidence for a candidate: worst of title, deadline and weighting. */
export function overallConfidence(candidate) {
  if (!candidate.submissionDeadline && candidate.deadlineCandidates.length === 0) return 'unknown';
  if (candidate.needsConfirmation) return 'review';
  const parts = [candidate.title, candidate.submissionDeadline].map(confidenceCategory);
  return parts.includes('unknown') || parts.includes('review') ? 'review' : 'high';
}
