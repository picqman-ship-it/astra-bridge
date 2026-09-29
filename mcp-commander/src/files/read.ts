import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../types.js';
import { classify, looksBinary, readSample, sniffImageMime, SNIFF_BYTES } from './detect.js';
import { decodeBuffer, detectEncoding } from './encoding.js';
import { mapFsError } from './errors.js';
import { formatPage, readTextPage, selectPage, splitLines } from './lines.js';
import { listDirectoryLines } from './listing.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_URL_BYTES = 10 * 1024 * 1024;
export const URL_TIMEOUT_MS = 30000;

export const DIRECTORY_NOTICE =
  'This is a directory, not a file. Use the list_directory tool instead of read_file for directories.\n\n';

export type ReadOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; text: string }
  | { kind: 'image'; mimeType: string; data: string; label: string };

export interface ReadOptions {
  offset: number;
  length: number;
  /** Test hook: files above this many bytes are streamed (default 50MB). */
  streamThreshold?: number;
}

export function binaryNotice(name: string, size: number): string {
  return (
    `Cannot read binary file as text: ${name} (${size} bytes)\n\n` +
    'Use start_process with tools like xxd, file, or a Python/Node script to inspect binary files.'
  );
}

export function isUrlLike(p: string): boolean {
  return /^https?:\/\//i.test(p.trim());
}

/** Reads a validated local path the way read_file presents it. `requested` is echoed in messages. */
export async function readLocal(requested: string, validPath: string, opts: ReadOptions): Promise<ReadOutcome> {
  try {
    const st = await fs.stat(validPath);
    if (st.isDirectory()) {
      const lines = await listDirectoryLines(validPath, 2);
      return { kind: 'text', text: DIRECTORY_NOTICE + lines.join('\n') };
    }
    if (!st.isFile()) throw new ToolError(`Not a regular file: ${requested}`);

    const { sample } = await readSample(validPath);
    const kind = classify(validPath, sample, st.size > sample.length);
    if (kind.kind === 'image') {
      if (st.size > MAX_IMAGE_BYTES) {
        throw new ToolError(`Image file too large: ${requested} (${st.size} bytes; images are limited to 10MB)`);
      }
      const data = (await fs.readFile(validPath)).toString('base64');
      return { kind: 'image', mimeType: kind.mimeType, data, label: `Image file: ${requested} (${kind.mimeType})\n` };
    }
    if (kind.kind === 'binary') {
      return { kind: 'binary', text: binaryNotice(path.basename(requested.trim()) || requested, st.size) };
    }
    const page = await readTextPage(validPath, kind.encoding, st.size, opts.offset, opts.length, opts.streamThreshold);
    return { kind: 'text', text: formatPage(page) };
  } catch (err) {
    throw mapFsError(err, requested);
  }
}

async function readBodyCapped(res: Response, cap: number): Promise<{ data: Buffer; truncated: boolean }> {
  if (!res.body) return { data: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > cap) {
      chunks.push(Buffer.from(value.buffer, value.byteOffset, cap - total));
      total = cap;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    total += value.byteLength;
  }
  return { data: Buffer.concat(chunks, total), truncated };
}

function describeFetchError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  let causeMsg = '';
  if (cause instanceof Error) {
    causeMsg = cause.message || String((cause as Error & { code?: unknown }).code ?? '') || cause.name;
  } else if (cause !== undefined && cause !== null) {
    causeMsg = String(cause);
  }
  return causeMsg && causeMsg !== msg ? `${msg} (${causeMsg})` : msg;
}

const URL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

function isTextLikeMedia(media: string): boolean {
  return (
    media.startsWith('text/') ||
    /(^|[/+.-])(json|xml|javascript|ecmascript|yaml|toml|csv|html|markdown|graphql|sql|x-sh)($|[;+.-])/.test(media)
  );
}

/**
 * Fetches an http(s) URL (no allowedDirectories check, like the original). Images come back as
 * image content; everything else is decoded and paginated exactly like a local text file.
 */
export async function readUrl(url: string, opts: ReadOptions & { timeoutMs?: number }): Promise<ReadOutcome> {
  const timeoutMs = opts.timeoutMs ?? URL_TIMEOUT_MS;
  const target = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new ToolError(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError(`Only http:// and https:// URLs are supported: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let body: { data: Buffer; truncated: boolean };
  try {
    res = await fetch(target, { signal: controller.signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw new ToolError(`Failed to fetch URL: HTTP error! Status: ${res.status}`);
    }
    body = await readBodyCapped(res, MAX_URL_BYTES);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if ((err as { name?: unknown })?.name === 'AbortError' || controller.signal.aborted) {
      throw new ToolError(`URL fetch timed out after ${timeoutMs}ms: ${target}`);
    }
    throw new ToolError(`Failed to fetch URL: ${describeFetchError(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const [mediaRaw, ...params] = contentType.split(';');
  const media = mediaRaw.trim().toLowerCase();
  const charset = params
    .map((p) => p.trim())
    .find((p) => p.toLowerCase().startsWith('charset='))
    ?.slice('charset='.length)
    .trim()
    .replace(/^"|"$/g, '');
  const { data, truncated } = body;

  if (URL_IMAGE_TYPES.has(media)) {
    const mimeType = sniffImageMime(data);
    if (mimeType) {
      if (truncated) throw new ToolError(`Image too large: ${target} (more than 10MB)`);
      return { kind: 'image', mimeType, data: data.toString('base64'), label: `Image file: ${target} (${mimeType})\n` };
    }
  }

  let text: string | undefined;
  if (charset) {
    try {
      text = new TextDecoder(charset).decode(data);
    } catch {
      text = undefined; // unknown label: fall back to BOM sniffing / UTF-8
    }
  }
  if (text === undefined) {
    if (!charset && !isTextLikeMedia(media) && looksBinary(data.subarray(0, SNIFF_BYTES), data.length > SNIFF_BYTES)) {
      return {
        kind: 'binary',
        text:
          `Cannot read binary content as text: ${target} (${data.length}${truncated ? '+' : ''} bytes, ${media || 'no content-type'})\n\n` +
          'Use start_process with tools like curl, xxd, or a Python/Node script to inspect binary content.',
      };
    }
    text = decodeBuffer(data, detectEncoding(data));
  }
  const out = formatPage(selectPage(splitLines(text), opts.offset, opts.length));
  return { kind: 'text', text: truncated ? `${out}\n\n[Response body truncated at 10MB]` : out };
}
