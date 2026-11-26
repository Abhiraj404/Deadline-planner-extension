/**
 * Duplicate and update detection for imported documents. Pure functions.
 *
 * File names are never trusted on their own. The SHA-256 hash decides whether two
 * files are *identical*; names, module codes and titles only suggest that a new file
 * is an *updated version* of an earlier brief, which the user then confirms.
 *
 *  identical  same hash, same name          → already imported; skip by default
 *  renamed    same hash, different name     → same file under another name; skip
 *  update     different hash, strong match  → offer to review changes to the deadline
 *  similar    different hash, weak match    → mention it, but create a new deadline
 *  new        no match
 */

/** "CA2_Brief_v3 (1) FINAL.pdf" → "ca2 brief" (version noise removed). */
export function fileStem(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/[_\s]+/g, ' ')
    .replace(
      /\(\d+\)|\bcopy(?:\s+of)?\b|\b(?:v|ver|version|rev|revision)\s*\d+\b|\b(?:final|draft|updated|update|new|latest|revised|amended)\b/g,
      ' ',
    )
    .replace(/\b\d{4}[-_.]\d{2}[-_.]\d{2}\b|\b\d{1,2}[-_.]\d{1,2}[-_.]\d{2,4}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 || /\d/.test(token)),
  );
}

/** Jaccard similarity of word sets (0–1). */
export function titleSimilarity(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Numbers in a title ("CA1", "Assignment 2") distinguish different assessments. */
function titleNumbers(text) {
  return [...String(text ?? '').matchAll(/\d+/g)].map((match) => match[0]).join(',');
}

/**
 * Score how likely an existing deadline is the same assessment as a new candidate.
 * @param {{ title?: string, moduleCode?: string, dueDate?: string, fileName: string }} candidate
 * @param {object} assessment existing deadline
 * @param {object[]} documents library records (to compare file names)
 */
export function scoreMatch(candidate, assessment, documents) {
  const reasons = [];
  let score = 0;
  const linkedDocument = documents.find((record) => record.id === assessment.sourceDocument?.id);
  const stem = fileStem(candidate.fileName);
  if (
    linkedDocument &&
    stem &&
    [linkedDocument.fileName, ...linkedDocument.aliases].some((name) => fileStem(name) === stem)
  ) {
    score += 3;
    reasons.push('same file name as an earlier import');
  }
  if (candidate.moduleCode && assessment.moduleCode) {
    if (candidate.moduleCode.toUpperCase() === assessment.moduleCode.toUpperCase()) {
      score += 2;
      reasons.push('same module code');
    } else {
      score -= 4;
    }
  }
  if (candidate.title && assessment.title) {
    const similarity = titleSimilarity(candidate.title, assessment.title);
    if (titleNumbers(candidate.title) !== titleNumbers(assessment.title)) {
      score -= 3; // "CA1 Report" and "CA2 Report" are different assessments
    } else if (similarity >= 0.99) {
      score += 3;
      reasons.push('same title');
    } else if (similarity >= 0.5) {
      score += 2;
      reasons.push('similar title');
    }
  }
  if (candidate.dueDate && candidate.dueDate === assessment.dueDate) {
    score += 1;
    reasons.push('same due date');
  }
  return { score, reasons };
}

/**
 * Classify a processed file against the library.
 * @param {{ hash: string, fileName: string, candidates: object[] }} imported
 *   `candidates` are simple { title, moduleCode, dueDate } summaries of each assessment
 * @param {{ documents: object[], assessments: object[] }} library
 */
export function classifyImport(imported, { documents, assessments }) {
  const identical = documents.find((record) => record.hash === imported.hash);
  if (identical) {
    const sameName = [identical.fileName, ...identical.aliases].includes(imported.fileName);
    return {
      kind: sameName ? 'identical' : 'renamed',
      document: identical,
      assessments: assessments.filter((item) => identical.assessmentIds.includes(item.id)),
      matches: [],
    };
  }

  const matches = imported.candidates.map((candidate) => {
    let best = null;
    for (const assessment of assessments) {
      const result = scoreMatch(
        { ...candidate, fileName: imported.fileName },
        assessment,
        documents,
      );
      if (result.score >= 2 && (!best || result.score > best.score))
        best = { assessment, ...result };
    }
    if (!best) return null;
    return {
      assessmentId: best.assessment.id,
      title: best.assessment.title,
      score: best.score,
      reasons: best.reasons,
      // An update needs strong evidence: at least two independent signals.
      kind: best.score >= 4 && best.reasons.length >= 2 ? 'update' : 'similar',
    };
  });

  const kind = matches.some((match) => match?.kind === 'update')
    ? 'update'
    : matches.some(Boolean)
      ? 'similar'
      : 'new';
  return { kind, document: null, assessments: [], matches };
}

export const IMPORT_KIND_TEXT = {
  identical: 'Already imported',
  renamed: 'Same file imported before under another name',
  update: 'Looks like an updated version of an existing deadline',
  similar: 'Similar to an existing deadline',
  new: 'New document',
};
