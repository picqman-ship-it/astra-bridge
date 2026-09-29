import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { classify, SNIFF_BYTES } from '../files/detect.js';
import { decodeBuffer, encodeText, isValidUtf8 } from '../files/encoding.js';
import { mapFsError } from '../files/errors.js';
import { countLineBreaks, splitLines, truncateLine } from '../files/lines.js';
import { intWithDefault } from '../files/schema.js';
import { validatePath } from '../security/paths.js';
import { defineTool, ToolError, type ToolContext, type ToolDef } from '../types.js';
import { FUZZY_THRESHOLD, FUZZY_TIMEOUT_MS, FuzzyTimeoutError, highlightDifferences, runFuzzySearch, type FuzzyMatch } from './fuzzy.js';

export const MAX_EDIT_BYTES = 50 * 1024 * 1024;
export const MAX_FUZZY_BYTES = 2 * 1024 * 1024;
const PREVIEW_CONTEXT_LINES = 10;
const FOUND_TEXT_CAP = 2000;
const CLOSEST_MATCH_CAP = 300;
const DIFF_CONTEXT_CAP = 300;
const MAX_LISTED_LINES = 20;

const IDENTICAL = 'old_string and new_string are identical — nothing to change';

/** The file's first line ending ('\r\n', '\r' or '\n'); '\n' when it has none. */
export function detectLineEnding(content: string): '\r\n' | '\r' | '\n' {
  const i = content.search(/[\r\n]/);
  if (i < 0 || content[i] === '\n') return '\n';
  return content[i + 1] === '\n' ? '\r\n' : '\r';
}

export function normalizeLineEndings(text: string, eol: string): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

/** Start offsets of non-overlapping occurrences (the same ones split/join replaces), at most `limit`. */
export function findOccurrences(content: string, needle: string, limit = Infinity): number[] {
  const out: number[] = [];
  let pos = content.indexOf(needle);
  while (pos !== -1 && out.length < limit) {
    out.push(pos);
    pos = content.indexOf(needle, pos + needle.length);
  }
  return out;
}

/** Number of non-overlapping occurrences, counted without storing them. */
export function countOccurrences(content: string, needle: string): number {
  let n = 0;
  for (let pos = content.indexOf(needle); pos !== -1; pos = content.indexOf(needle, pos + needle.length)) n++;
  return n;
}

/** [start, end) offsets of one match in the decoded file content. */
export type Span = [number, number];

/**
 * Line-ending-insensitive search, used only when the exact search finds nothing in a file that
 * contains '\r': in a file with MIXED line endings, old_string normalized to the first-seen ending
 * cannot match a region that uses another style. Matches are non-overlapping in a view of the
 * content where every line ending is '\n'; the spans are returned in original offsets. All matches
 * are counted, but only the first `limit` spans are returned.
 */
export function findOccurrencesIgnoringLineEndings(
  content: string,
  needle: string,
  limit = Infinity,
): { count: number; spans: Span[] } {
  const norm = content.replace(/\r\n?/g, '\n');
  const query = needle.replace(/\r\n?/g, '\n');
  // origin[k] = offset in `content` of norm[k] (a '\r\n' pair is one norm character).
  const origin = new Int32Array(norm.length + 1);
  let i = 0;
  for (let k = 0; k < norm.length; k++) {
    origin[k] = i;
    i += content.charCodeAt(i) === 13 && content.charCodeAt(i + 1) === 10 ? 2 : 1;
  }
  origin[norm.length] = content.length;
  const starts = findOccurrences(norm, query, limit);
  const count = starts.length < limit ? starts.length : countOccurrences(norm, query);
  return { count, spans: starts.map((p): Span => [origin[p], origin[p + query.length]]) };
}

/** Replaces every span (ascending, non-overlapping) with `replacement`. */
export function applySpans(content: string, spans: Span[], replacement: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const [s, e] of spans) {
    parts.push(content.slice(last, s), replacement);
    last = e;
  }
  parts.push(content.slice(last));
  return parts.join('');
}

/** 1-based line numbers of the given (ascending) offsets. */
function lineNumbersAt(content: string, offsets: number[]): number[] {
  const out: number[] = [];
  let line = 1;
  let i = 0;
  for (const off of offsets) {
    for (; i < off; i++) {
      const c = content.charCodeAt(i);
      if (c === 13 || (c === 10 && (i === 0 || content.charCodeAt(i - 1) !== 13))) line++; // \r\n counts once
    }
    out.push(line);
  }
  return out;
}

const countTextLines = (s: string) => s.split(/\r\n|\r|\n/).length;

/** Desktop Commander's post-edit preview: ~10 lines of context around the first change. */
export function buildPreview(newContent: string, changePos: number, replacement: string): string {
  const lines = splitLines(newContent);
  const total = lines.length;
  const changeStart = countLineBreaks(newContent.slice(0, changePos));
  const changeLines = countTextLines(replacement);
  const from = Math.max(0, changeStart - PREVIEW_CONTEXT_LINES);
  const to = Math.min(total, changeStart + changeLines + PREVIEW_CONTEXT_LINES);
  const shown = Math.max(0, to - from);
  const remaining = Math.max(0, total - to);
  const where = from === 0 ? 'start' : `line ${from}`;
  return `[Reading ${shown} lines from ${where} (total: ${total} lines, ${remaining} remaining)]\n\n${lines
    .slice(from, to)
    .map(truncateLine)
    .join('\n')}`;
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated, ${text.length - max} more chars]`;
}

/** The diff with very long unchanged context trimmed (the changed middle is always kept whole). */
function compactDiff(expected: string, actual: string): string {
  const diff = highlightDifferences(expected, actual);
  const open = diff.indexOf('{-');
  const close = diff.lastIndexOf('+}');
  let prefix = diff.slice(0, open);
  let suffix = diff.slice(close + 2);
  if (prefix.length > DIFF_CONTEXT_CAP) prefix = `…${prefix.slice(prefix.length - DIFF_CONTEXT_CAP)}`;
  if (suffix.length > DIFF_CONTEXT_CAP) suffix = `${suffix.slice(0, DIFF_CONTEXT_CAP)}…`;
  return prefix + diff.slice(open, close + 2) + suffix;
}

export function editTools(ctx: ToolContext): ToolDef[] {
  const editBlock = defineTool({
    name: 'edit_block',
    description:
      'Replace exact text in a file: old_string must match the file exactly (whitespace and indentation included; ' +
      "line endings are normalized to the file's own). By default exactly one occurrence must exist; set " +
      'expected_replacements to replace that many — if the count differs nothing is changed and the matching (1-based) ' +
      'line numbers are reported. Include enough surrounding lines to make old_string unique, and keep edits small ' +
      '(at most fileWriteLineLimit lines, default 50). Without an exact match, a fuzzy search reports the most similar text ' +
      'and a {-expected-}{+found+} diff but changes nothing (fuzzy search only for files up to 2MB). Preserves encoding ' +
      '(UTF-8, UTF-8 BOM, UTF-16) and returns a preview of the edited lines. Text files up to 50MB. ' +
      'For new files or full rewrites use write_file. Use absolute paths.',
    inputSchema: {
      file_path: z.string().describe('Absolute path of the text file to edit.'),
      old_string: z.string().describe('Exact text to find (must be non-empty).'),
      new_string: z.string().describe('Replacement text (may be empty to delete old_string).'),
      expected_replacements: intWithDefault(1, 'Exact number of occurrences to replace (default 1).', { min: 1 }),
    },
    annotations: { title: 'Edit Text Block', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async ({ file_path, old_string, new_string, expected_replacements }) => {
      const expected = expected_replacements ?? 1;
      if (typeof old_string !== 'string' || old_string === '') {
        throw new ToolError(
          'old_string must not be empty: pass the exact text to replace (with a few surrounding lines to make it unique). ' +
            'To create or fully rewrite a file, use write_file.',
        );
      }
      if (typeof new_string !== 'string') throw new ToolError('new_string must be a string (use "" to delete old_string).');
      if (!Number.isInteger(expected) || expected < 1) throw new ToolError('expected_replacements must be a positive integer.');
      if (old_string === new_string) throw new ToolError(IDENTICAL);

      const valid = await validatePath(file_path, ctx.config.getValue('allowedDirectories'));
      let st: Stats;
      let raw: Buffer;
      try {
        st = await fs.stat(valid);
        if (st.isDirectory()) throw new ToolError(`Cannot edit a directory: ${file_path}`);
        if (!st.isFile()) throw new ToolError(`Not a regular file: ${file_path}`);
        if (st.size > MAX_EDIT_BYTES) {
          throw new ToolError(
            `File too large for edit_block: ${file_path} (${st.size} bytes; the limit is 50MB). ` +
              'Use start_process with a script (sed, Python, Node) to edit very large files.',
          );
        }
        raw = await fs.readFile(valid);
      } catch (err) {
        throw mapFsError(err, file_path);
      }

      const kind = classify(valid, raw.subarray(0, SNIFF_BYTES), raw.length > SNIFF_BYTES);
      if (kind.kind === 'image') throw new ToolError(`Cannot edit image file: ${file_path}`);
      if (kind.kind === 'binary') {
        throw new ToolError(
          `Cannot edit binary file: ${file_path}. edit_block only edits text files; use start_process with a script for binary files.`,
        );
      }
      const enc = kind.encoding;
      if (enc.name === 'utf8' && !isValidUtf8(raw.subarray(enc.bomLength))) {
        throw new ToolError(
          `Cannot edit ${file_path}: it is not valid UTF-8 (legacy or unknown encoding), so rewriting it could corrupt ` +
            'characters. Use start_process with a script that handles its encoding.',
        );
      }
      const content = decodeBuffer(raw, enc);
      const eol = detectLineEnding(content);
      const needle = normalizeLineEndings(old_string, eol);
      const normalizedReplacement = normalizeLineEndings(new_string, eol);
      if (needle === normalizedReplacement) throw new ToolError(IDENTICAL);

      // Only `expected` spans are ever applied and at most MAX_LISTED_LINES are listed on a mismatch,
      // so offsets beyond that are counted, not stored (old_string 'a' in a 50MB file).
      const keep = Math.max(expected, MAX_LISTED_LINES) + 1;
      let spans: Span[] = findOccurrences(content, needle, keep).map((p): Span => [p, p + needle.length]);
      let count = spans.length < keep ? spans.length : countOccurrences(content, needle);
      let replacement = normalizedReplacement;
      if (count === 0 && content.includes('\r')) {
        ({ count, spans } = findOccurrencesIgnoringLineEndings(content, needle, keep));
        if (count > 0) {
          // Use the line ending of the matched region itself.
          const [s0, e0] = spans[0];
          const local = /\r\n|\r|\n/.exec(content.slice(s0, e0))?.[0] ?? eol;
          replacement = normalizeLineEndings(new_string, local);
          if (spans.every(([s, e]) => content.slice(s, e) === replacement)) throw new ToolError(IDENTICAL);
        }
      }

      if (count > 0 && count === expected) {
        const newContent = applySpans(content, spans, replacement);
        try {
          await fs.writeFile(valid, encodeText(newContent, enc));
        } catch (err) {
          throw mapFsError(err, file_path);
        }
        let msg = `Successfully applied ${count} edit(s) to ${file_path}\n\n${buildPreview(newContent, spans[0][0], replacement)}`;
        const limit = ctx.config.getValue('fileWriteLineLimit');
        const searchLines = countTextLines(needle);
        const replaceLines = countTextLines(replacement);
        const maxLines = Math.max(searchLines, replaceLines);
        if (maxLines > limit) {
          msg +=
            `\n\nWARNING: The ${searchLines > replaceLines ? 'search text' : 'replacement text'} has ${maxLines} lines ` +
            `(maximum: ${limit}).\nRECOMMENDATION: For large search/replace operations, consider breaking them into ` +
            'smaller chunks with fewer lines.';
        }
        return msg;
      }

      if (count > 0) {
        const lines = lineNumbersAt(content, spans.map(([s]) => s));
        const listed =
          lines.slice(0, MAX_LISTED_LINES).join(', ') + (count > MAX_LISTED_LINES ? `, … (+${count - MAX_LISTED_LINES} more)` : '');
        throw new ToolError(
          `Expected ${expected} occurrences but found ${count} in ${file_path} (at lines ${listed}). ` +
            `If you want to replace all ${count} occurrences, set expected_replacements to ${count}. ` +
            'To replace a specific occurrence, make old_string more unique by including more surrounding lines.',
        );
      }

      // No exact match: report the closest text, never apply it.
      if (raw.length > MAX_FUZZY_BYTES) {
        throw new ToolError(
          `Search content not found in ${file_path}. (The file is larger than 2MB, so no fuzzy search was run; ` +
            'use read_file or a search tool to find the exact text.)',
        );
      }
      const text = content.replace(/\r\n?/g, '\n');
      const query = needle.replace(/\r\n?/g, '\n');
      const started = performance.now();
      let match: FuzzyMatch;
      try {
        match = await runFuzzySearch(text, query, FUZZY_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof FuzzyTimeoutError) {
          throw new ToolError(
            `Search content not found in ${file_path}. Fuzzy search timed out after ${FUZZY_TIMEOUT_MS}ms; ` +
              'use read_file to find the exact text.',
          );
        }
        throw new ToolError(`Search content not found in ${file_path}. (${err instanceof Error ? err.message : String(err)})`);
      }
      const ms = Math.round(performance.now() - started);
      const maxLen = Math.max(query.length, match.value.length);
      const sim = maxLen === 0 ? 1 : 1 - match.distance / maxLen;
      if (sim >= FUZZY_THRESHOLD) {
        // Never claim 100% for text that is not an exact match.
        const pct = match.distance > 0 ? Math.min(99, Math.round(sim * 100)) : 100;
        const line = countLineBreaks(text.slice(0, match.start)) + 1;
        throw new ToolError(
          `Exact match not found, but found a similar text with ${pct}% similarity at line ${line} (found in ${ms}ms):\n\n` +
            `Differences:\n${compactDiff(query, match.value)}\n\n` +
            `Found text (copy it exactly if this is the text you meant):\n${cap(match.value, FOUND_TEXT_CAP)}`,
        );
      }
      throw new ToolError(
        `Search content not found in ${file_path}. The closest match was "${cap(match.value, CLOSEST_MATCH_CAP)}" ` +
          `with only ${Math.floor(sim * 100)}% similarity, which is below the ${Math.round(FUZZY_THRESHOLD * 100)}% threshold.`,
      );
    },
  });

  return [editBlock] as unknown as ToolDef[];
}
