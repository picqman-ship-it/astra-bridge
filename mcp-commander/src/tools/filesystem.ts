import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { classify, readSample } from '../files/detect.js';
import { detectEncoding, encodeText } from '../files/encoding.js';
import { errnoCode, mapFsError } from '../files/errors.js';
import { resolveWriteTarget, validatePathNoFollow } from '../files/guard.js';
import { countFileLines, splitLines } from '../files/lines.js';
import { listDirectoryLines } from '../files/listing.js';
import { isUrlLike, readLocal, readUrl, type ReadOutcome } from '../files/read.js';
import { boolWithDefault, intWithDefault, optionalEnum, optionalInt, stringArray } from '../files/schema.js';
import { isWithin, PathNotAllowedError, validatePath } from '../security/paths.js';
import { defineTool, textResult, ToolError, type ContentBlock, type ToolContext, type ToolDef, type ToolResult } from '../types.js';

const LINE_COUNT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PARALLEL_READS = 8;

function outcomeToResult(outcome: ReadOutcome): ToolResult {
  if (outcome.kind === 'image') {
    return {
      content: [
        { type: 'text', text: outcome.label },
        { type: 'image', data: outcome.data, mimeType: outcome.mimeType },
      ],
    };
  }
  return textResult(outcome.text);
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error:\s*/, '');
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function statOrUndefined(p: string, requested: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(p);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return undefined;
    if (code === 'ENOTDIR') throw new ToolError(`Cannot write to ${requested}: a parent path component is not a directory`);
    throw mapFsError(err, requested);
  }
}

async function mkdirParents(dir: string, requested: string, verb: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'EEXIST' || code === 'ENOTDIR') {
      throw new ToolError(`Cannot ${verb} ${requested}: a parent path component is not a directory`);
    }
    throw mapFsError(err, requested);
  }
}

function isoDate(d: Date): string {
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString();
}

/** EXDEV fallback for move_file: copy (links copied as links), then remove the source. */
export async function moveAcrossDevices(src: string, dst: string): Promise<void> {
  try {
    await fs.cp(src, dst, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  } catch (err) {
    await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await fs.rm(src, { recursive: true, force: true });
}

export function filesystemTools(ctx: ToolContext): ToolDef[] {
  const allowed = () => ctx.config.getValue('allowedDirectories');

  const readFile = defineTool({
    name: 'read_file',
    description:
      'Read a text file, image or URL. Text comes back with a status header like ' +
      "'[Reading N lines from start (total: T lines, R remaining)]' and, when more lines remain, the offset to continue from. " +
      'offset is a 0-based line index; length is the max number of lines (default: the fileReadLineLimit config, 1000). ' +
      'A negative offset returns the last |offset| lines (length is ignored). Lines over 20000 characters are truncated. ' +
      'PNG/JPEG/GIF/WebP files (max 10MB) are returned as images; other binary files are detected and not dumped; ' +
      'a directory returns a short listing. Handles UTF-8, UTF-8 BOM and UTF-16 files, and LF/CRLF/CR line endings. ' +
      'With isUrl=true (or any http(s):// path) the URL is fetched (30s timeout, 10MB cap) and paginated the same way. ' +
      'Use absolute paths.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file (or an http/https URL).'),
      offset: intWithDefault(0, '0-based line to start from. Negative = read the last |offset| lines.'),
      length: optionalInt('Maximum number of lines to return (default: fileReadLineLimit config).', { min: 1 }),
      isUrl: boolWithDefault(false, 'Treat path as a URL to fetch (http:// and https:// paths are detected automatically).'),
    },
    annotations: { title: 'Read File or URL', readOnlyHint: true, openWorldHint: true },
    handler: async ({ path: p, offset, length, isUrl }) => {
      const opts = { offset: offset ?? 0, length: length ?? ctx.config.getValue('fileReadLineLimit') };
      if (isUrl || isUrlLike(p)) return outcomeToResult(await readUrl(p, opts));
      const valid = await validatePath(p, allowed());
      return outcomeToResult(await readLocal(p, valid, opts));
    },
  });

  const readMultipleFiles = defineTool({
    name: 'read_multiple_files',
    description:
      'Read up to 50 local files at once (in parallel). The first text block is a summary with one line per path ' +
      "('<path>: text/plain (text)', '<path>: <mime> (image)', '<path>: binary' or '<path>: Error - <message>'); " +
      "then each readable file follows in order, as '--- <path> contents: ---' plus exactly what read_file returns with " +
      'default offset/length (or an image block). A failing file never fails the whole call. Use absolute paths.',
    inputSchema: {
      paths: stringArray('Absolute file paths to read (1-50).', { min: 1, max: 50 }),
    },
    annotations: { title: 'Read Multiple Files', readOnlyHint: true },
    handler: async ({ paths }) => {
      if (!Array.isArray(paths) || paths.length === 0) throw new ToolError('paths must be a non-empty array of file paths.');
      if (paths.length > 50) throw new ToolError(`Too many paths (${paths.length}); read_multiple_files accepts at most 50.`);
      const length = ctx.config.getValue('fileReadLineLimit');
      const dirs = allowed();
      const results = await mapLimit(paths, MAX_PARALLEL_READS, async (p) => {
        try {
          if (isUrlLike(p)) throw new ToolError('URLs are not supported here; use read_file with the URL.');
          const valid = await validatePath(p, dirs);
          return { p, outcome: await readLocal(p, valid, { offset: 0, length }) };
        } catch (err) {
          return { p, error: errorMessage(err) };
        }
      });

      const summary: string[] = [];
      const blocks: ContentBlock[] = [];
      for (const r of results) {
        if (!r.outcome) {
          summary.push(`${r.p}: Error - ${r.error}`);
          continue;
        }
        const o = r.outcome;
        if (o.kind === 'image') {
          summary.push(`${r.p}: ${o.mimeType} (image)`);
          blocks.push({ type: 'image', data: o.data, mimeType: o.mimeType });
        } else {
          summary.push(o.kind === 'binary' ? `${r.p}: binary` : `${r.p}: text/plain (text)`);
          blocks.push({ type: 'text', text: `\n--- ${r.p} contents: ---\n${o.text}` });
        }
      }
      return { content: [{ type: 'text', text: summary.join('\n') }, ...blocks] };
    },
  });

  const writeFile = defineTool({
    name: 'write_file',
    description:
      "Write UTF-8 text to a file, creating missing parent directories. mode 'rewrite' replaces the whole file; " +
      "mode 'append' adds content to the end (no newline is inserted). If mode is omitted and the file already has " +
      'content, the write is rejected to prevent accidental data loss. Keep each call to at most fileWriteLineLimit lines ' +
      "(config, default 50): write large files in chunks, first with mode 'rewrite', then 'append'. " +
      'For changes to an existing file prefer edit_block. Use absolute paths.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file to write.'),
      content: z.string().describe('Text to write.'),
      mode: optionalEnum(
        ['rewrite', 'append'],
        "'rewrite' replaces the file, 'append' adds to its end. Required when the file already has content.",
      ),
    },
    annotations: { title: 'Write File', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async ({ path: p, content, mode }) => {
      if (typeof content !== 'string') throw new ToolError('content must be a string.');
      const dirs = allowed();
      const valid = await validatePath(p, dirs);
      const target = await resolveWriteTarget(valid, p, dirs);
      const existing = await statOrUndefined(target, p);
      if (existing?.isDirectory()) throw new ToolError(`Cannot write to ${p}: it is a directory`);
      if (existing && !existing.isFile()) throw new ToolError(`Cannot write to ${p}: not a regular file`);
      if (mode === undefined && existing && existing.size > 0) {
        throw new ToolError(
          `Write rejected to prevent accidental data loss: ${p} already exists with content (${existing.size} bytes), ` +
            "and no 'mode' was specified — the default mode 'rewrite' would REPLACE the entire file. " +
            "Retry with an explicit mode: 'append' to add your content to the end of the existing file, " +
            "or 'rewrite' to replace all existing content.",
        );
      }
      const append = mode === 'append';
      await mkdirParents(path.dirname(target), p, 'write to');
      try {
        if (append) {
          // Appending UTF-8 to a UTF-16 file would corrupt it: encode in the file's own encoding.
          let data: Buffer | string = content;
          if (existing && existing.size >= 2) {
            const { sample } = await readSample(target, 3);
            const enc = detectEncoding(sample);
            if (enc.name !== 'utf8') data = encodeText(content, enc, false);
          }
          await fs.appendFile(target, data);
        } else {
          await fs.writeFile(target, content, 'utf8');
        }
      } catch (err) {
        throw mapFsError(err, p);
      }
      // Counted like read_file counts them: a trailing newline does not start another line.
      const lines = splitLines(content).length;
      let msg = `Successfully ${append ? 'appended to' : 'wrote to'} ${p} (${lines} ${lines === 1 ? 'line' : 'lines'})`;
      const limit = ctx.config.getValue('fileWriteLineLimit');
      if (lines > limit) {
        msg +=
          `\n\n💡 Tip: this write had ${lines} lines (limit ${limit}). For large files write in chunks: ` +
          "first call with mode 'rewrite', then mode 'append' for the rest.";
      }
      return msg;
    },
  });

  const createDirectory = defineTool({
    name: 'create_directory',
    description:
      'Create a directory, including any missing parent directories (like mkdir -p). ' +
      'Succeeds without changes if it already exists. Use absolute paths.',
    inputSchema: {
      path: z.string().describe('Absolute path of the directory to create.'),
    },
    annotations: { title: 'Create Directory', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async ({ path: p }) => {
      const valid = await validatePath(p, allowed());
      let st: Stats | undefined;
      try {
        st = await fs.stat(valid);
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'ENOTDIR') throw new ToolError(`Cannot create directory ${p}: a parent path component is not a directory`);
        if (code !== 'ENOENT') throw mapFsError(err, p);
      }
      if (st?.isDirectory()) return `Directory already exists: ${p}`;
      if (st) throw new ToolError(`Cannot create directory ${p}: a file with that name already exists`);
      try {
        await fs.mkdir(valid, { recursive: true });
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'EEXIST') throw new ToolError(`Cannot create directory ${p}: a file (or broken symlink) is in the way`);
        if (code === 'ENOTDIR') throw new ToolError(`Cannot create directory ${p}: a parent path component is not a directory`);
        throw mapFsError(err, p);
      }
      return `Successfully created directory ${p}`;
    },
  });

  const listDirectory = defineTool({
    name: 'list_directory',
    description:
      "List a directory recursively, one entry per line: '[DIR] rel/path', '[FILE] rel/path' or " +
      "'[LINK] rel/path -> target' (symlinks are shown, never followed). Paths are relative to the listed directory, " +
      'sorted case-insensitively, with each directory\'s children right after it. depth 1 lists only direct children ' +
      '(default 2, max 10). Nested directories show at most 100 entries and the top level 1000 (a [WARNING] line reports ' +
      'hidden entries); the whole listing stops at 10000 entries. Unreadable subdirectories show as [DENIED]. Use absolute paths.',
    inputSchema: {
      path: z.string().describe('Absolute path of the directory to list.'),
      depth: intWithDefault(2, 'How many levels to descend: 1 = direct children only (1-10, clamped).'),
    },
    annotations: { title: 'List Directory', readOnlyHint: true },
    handler: async ({ path: p, depth }) => {
      const valid = await validatePath(p, allowed());
      const notFound = `Directory not found: ${p}`;
      let st: Stats;
      try {
        st = await fs.stat(valid);
      } catch (err) {
        throw mapFsError(err, p, notFound);
      }
      if (!st.isDirectory()) throw new ToolError(`Not a directory: ${p}`);
      const d = Math.min(10, Math.max(1, Math.trunc(depth ?? 2)));
      try {
        const label = path.basename(p.trim().replace(/[\\/]+$/, '')) || path.basename(valid) || valid;
        return (await listDirectoryLines(valid, d, undefined, label)).join('\n');
      } catch (err) {
        throw mapFsError(err, p, notFound);
      }
    },
  });

  const moveFile = defineTool({
    name: 'move_file',
    description:
      'Move or rename a file, directory or symlink (a symlink is moved itself, not its target). ' +
      'Never overwrites: fails if the destination already exists. Creates missing parent directories of the destination ' +
      'and works across filesystems. Both paths must be allowed. Use absolute paths.',
    inputSchema: {
      source: z.string().describe('Absolute path of the file/directory to move.'),
      destination: z.string().describe('Absolute path of the new location (must not exist yet).'),
    },
    annotations: { title: 'Move/Rename File', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async ({ source, destination }) => {
      const dirs = allowed();
      const src = await validatePathNoFollow(source, dirs);
      const dst = await validatePathNoFollow(destination, dirs);
      let srcSt: Stats;
      try {
        srcSt = await fs.lstat(src);
      } catch (err) {
        throw mapFsError(err, source, `Source not found: ${source}`);
      }
      let dstSt: Stats | undefined;
      try {
        dstSt = await fs.lstat(dst);
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'ENOTDIR') {
          throw new ToolError(`Cannot move to ${destination}: a parent path component is not a directory`);
        }
        if (code !== 'ENOENT') throw mapFsError(err, destination);
      }
      if (dstSt) {
        // On case-insensitive filesystems 'a.txt' -> 'A.txt' finds the source itself: allow that rename.
        const caseOnlyRename =
          src !== dst && src.toLowerCase() === dst.toLowerCase() && dstSt.ino === srcSt.ino && dstSt.dev === srcSt.dev;
        if (!caseOnlyRename) throw new ToolError(`Destination already exists: ${destination}`);
      }
      if (srcSt.isDirectory() && dst !== src && isWithin(dst, src)) {
        throw new ToolError(`Cannot move ${source} into itself (${destination})`);
      }
      await mkdirParents(path.dirname(dst), destination, 'move to');
      try {
        await fs.rename(src, dst);
      } catch (err) {
        if (errnoCode(err) !== 'EXDEV') throw mapFsError(err, source, `Source not found: ${source}`);
        try {
          await moveAcrossDevices(src, dst);
        } catch (copyErr) {
          throw mapFsError(copyErr, source, `Source not found: ${source}`);
        }
      }
      return `Successfully moved ${source} to ${destination}`;
    },
  });

  const getFileInfo = defineTool({
    name: 'get_file_info',
    description:
      "Get metadata for a file, directory or symlink (a symlink is described itself, not followed) as 'key: value' lines: " +
      'path (resolved), size, created, modified, accessed (ISO times), isDirectory, isFile, isSymbolicLink (+ symlinkTarget), ' +
      'permissions (octal, e.g. 644) and fileType (text|image|binary|directory|other). Text files under 10MB also get ' +
      'lineCount, lastLine (0-based index of the last line) and appendPosition. Use absolute paths.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file, directory or symlink.'),
    },
    annotations: { title: 'Get File Info', readOnlyHint: true },
    handler: async ({ path: p }) => {
      const dirs = allowed();
      let target: string;
      try {
        target = await validatePathNoFollow(p, dirs);
      } catch (err) {
        if (!(err instanceof PathNotAllowedError)) throw err;
        // The link itself is outside the allowed directories: describe its target if that one is allowed.
        target = await validatePath(p, dirs);
      }
      let st: Stats;
      try {
        st = await fs.lstat(target);
      } catch (err) {
        throw mapFsError(err, p);
      }
      const lines: string[] = [
        `path: ${target}`,
        `size: ${st.size}`,
        `created: ${isoDate(st.birthtime)}`,
        `modified: ${isoDate(st.mtime)}`,
        `accessed: ${isoDate(st.atime)}`,
        `isDirectory: ${st.isDirectory()}`,
        `isFile: ${st.isFile()}`,
        `isSymbolicLink: ${st.isSymbolicLink()}`,
      ];
      if (st.isSymbolicLink()) {
        lines.push(`symlinkTarget: ${await fs.readlink(target).catch(() => '?')}`);
      }
      lines.push(`permissions: ${(st.mode & 0o777).toString(8).padStart(3, '0')}`);

      let fileType = 'other';
      let lineCount: number | undefined;
      if (st.isDirectory()) fileType = 'directory';
      else if (st.isFile()) {
        try {
          const { sample } = await readSample(target);
          const kind = classify(target, sample, st.size > sample.length);
          fileType = kind.kind;
          if (kind.kind === 'text' && st.size < LINE_COUNT_MAX_BYTES) {
            lineCount = await countFileLines(target, kind.encoding);
          }
        } catch {
          fileType = 'other'; // unreadable (e.g. permissions): type unknown
        }
      }
      lines.push(`fileType: ${fileType}`);
      if (lineCount !== undefined) {
        lines.push(`lineCount: ${lineCount}`, `lastLine: ${lineCount - 1}`, `appendPosition: ${lineCount}`);
      }
      return lines.join('\n');
    },
  });

  return [readFile, readMultipleFiles, writeFile, createDirectory, listDirectory, moveFile, getFileInfo] as unknown as ToolDef[];
}
