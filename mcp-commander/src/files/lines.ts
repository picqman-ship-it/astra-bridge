import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createChunkDecoder, decodeBuffer, type TextEncoding } from './encoding.js';

/**
 * Line model shared by read_file, read_multiple_files, get_file_info and edit_block:
 * lines end at \r\n, \n or a lone \r; a trailing terminator does not start another line;
 * an empty file has 0 lines.
 */

export const MAX_LINE_CHARS = 20000;
/** Files above this size are streamed instead of being loaded into memory. */
export const STREAM_THRESHOLD_BYTES = 50 * 1024 * 1024;

const LINE_BREAK = /\r\n|\n|\r/;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(LINE_BREAK);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Number of line terminators in `text` (0-based line index of the position right after it). */
export function countLineBreaks(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) n++;
    else if (c === 13) {
      n++;
      if (text.charCodeAt(i + 1) === 10) i++;
    }
  }
  return n;
}

function truncationSuffix(extra: number): string {
  return `… [line truncated, ${extra} more chars]`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  let cut = MAX_LINE_CHARS;
  if (isHighSurrogate(line.charCodeAt(cut - 1))) cut--;
  return line.slice(0, cut) + truncationSuffix(line.length - cut);
}

export interface Page {
  /** Selected lines, already truncated for display. */
  lines: string[];
  total: number;
  /** Requested offset (negative = tail). */
  offset: number;
}

export function selectPage(all: string[], offset: number, length: number): Page {
  const sel = offset < 0 ? all.slice(Math.max(0, all.length + offset)) : all.slice(offset, offset + Math.max(0, length));
  return { lines: sel.map(truncateLine), total: all.length, offset };
}

/** The read_file status header + body (+ continuation hint), exactly like Desktop Commander's. */
export function formatPage(page: Page): string {
  const n = page.lines.length;
  const body = page.lines.join('\n');
  if (page.offset < 0) return `[Reading last ${n} lines (total: ${page.total} lines)]\n\n${body}`;
  const remaining = Math.max(0, page.total - (page.offset + n));
  const from = page.offset === 0 ? 'from start' : `from line ${page.offset}`;
  let out = `[Reading ${n} lines ${from} (total: ${page.total} lines, ${remaining} remaining)]\n\n${body}`;
  if (remaining > 0) {
    out += `\n\n[... ${remaining} more lines. Call read_file with offset=${page.offset + n} to continue]`;
  }
  return out;
}

/**
 * Streams a file's lines without loading it: calls onLine(index, text) for every line for which
 * want(index) is true (text is already truncated to MAX_LINE_CHARS) and returns the total line count.
 * Lines that are not wanted are only counted, never accumulated.
 */
export async function streamLines(
  filePath: string,
  encoding: TextEncoding,
  want: (index: number) => boolean,
  onLine: (index: number, text: string) => void,
): Promise<number> {
  const decoder = createChunkDecoder(encoding);
  let index = 0;
  let cur = '';
  let extra = 0;
  let wanted = want(0);
  let pendingCR = false;
  // True once the current line has any characters (tracked even for lines that are not wanted,
  // so an unterminated last line is still counted).
  let open = false;

  const append = (s: string) => {
    if (s.length === 0) return;
    open = true;
    if (!wanted) return;
    const room = MAX_LINE_CHARS - cur.length;
    if (room <= 0) {
      extra += s.length;
    } else if (s.length <= room) {
      cur += s;
    } else {
      cur += s.slice(0, room);
      extra += s.length - room;
    }
  };
  const emit = () => {
    if (wanted) {
      let text = cur;
      if (extra > 0) {
        let dropped = extra;
        if (isHighSurrogate(text.charCodeAt(text.length - 1))) {
          text = text.slice(0, -1);
          dropped++;
        }
        text += truncationSuffix(dropped);
      }
      onLine(index, text);
    }
    index++;
    cur = '';
    extra = 0;
    open = false;
    wanted = want(index);
  };
  const feed = (s: string) => {
    if (s.length === 0) return; // keep pendingCR until real text arrives
    let i = 0;
    if (pendingCR) {
      pendingCR = false;
      if (s.charCodeAt(0) === 10) i = 1;
    }
    while (i < s.length) {
      let j = i;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === 10 || c === 13) break;
        j++;
      }
      if (j > i) append(wanted ? s.slice(i, j) : ' ');
      if (j >= s.length) return;
      emit();
      if (s.charCodeAt(j) === 13) {
        if (j + 1 >= s.length) {
          pendingCR = true; // a \n may start the next chunk
          return;
        }
        i = s.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
      } else {
        i = j + 1;
      }
    }
  };

  const stream = fs.createReadStream(filePath, { start: encoding.bomLength, highWaterMark: 1 << 20 });
  for await (const chunk of stream) feed(decoder.write(chunk as Buffer));
  feed(decoder.end());
  if (open) emit();
  return index;
}

async function streamPage(filePath: string, encoding: TextEncoding, offset: number, length: number): Promise<Page> {
  if (offset < 0) {
    const n = -offset;
    const ring: string[] = [];
    const total = await streamLines(filePath, encoding, () => true, (i, text) => {
      if (ring.length < n) ring.push(text);
      else ring[i % n] = text;
    });
    const lines = total <= n ? ring : [...ring.slice(total % n), ...ring.slice(0, total % n)];
    return { lines, total, offset };
  }
  const end = offset + Math.max(0, length);
  const lines: string[] = [];
  const total = await streamLines(filePath, encoding, (i) => i >= offset && i < end, (_i, text) => lines.push(text));
  return { lines, total, offset };
}

/** Reads one page of a text file; files above `streamThreshold` bytes are streamed. */
export async function readTextPage(
  filePath: string,
  encoding: TextEncoding,
  size: number,
  offset: number,
  length: number,
  streamThreshold = STREAM_THRESHOLD_BYTES,
): Promise<Page> {
  if (size > streamThreshold) return streamPage(filePath, encoding, offset, length);
  const text = decodeBuffer(await fsp.readFile(filePath), encoding);
  return selectPage(splitLines(text), offset, length);
}

/** Counts lines of a text file (same rules as read_file). */
export async function countFileLines(filePath: string, encoding: TextEncoding): Promise<number> {
  const text = decodeBuffer(await fsp.readFile(filePath), encoding);
  return splitLines(text).length;
}
