import fs from 'node:fs/promises';
import path from 'node:path';
import { detectEncoding, type TextEncoding } from './encoding.js';

/** How many leading bytes are inspected to decide text vs binary. */
export const SNIFF_BYTES = 8192;

/** Extensions returned as image content blocks. SVG and BMP are deliberately absent (LLM APIs reject them). */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const IMAGE_MIME_TYPES = new Set(Object.values(IMAGE_MIME_BY_EXT));

export function imageMimeForPath(p: string): string | undefined {
  return IMAGE_MIME_BY_EXT[path.extname(p).toLowerCase()];
}

/** Identifies PNG/JPEG/GIF/WebP by magic bytes. */
export function sniffImageMime(buf: Uint8Array): string | undefined {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return 'image/gif';
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

/**
 * Length of the well-formed UTF-8 sequence starting at `i` (>= 2), or 0 when it is not one.
 * A sequence cut off by the end of a truncated sample counts as valid.
 */
function utf8SequenceLength(buf: Uint8Array, i: number, truncated: boolean): number {
  const lead = buf[i];
  let need: number;
  let lo = 0x80;
  let hi = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) need = 1;
  else if (lead >= 0xe0 && lead <= 0xef) {
    need = 2;
    if (lead === 0xe0) lo = 0xa0; // no overlong forms
    if (lead === 0xed) hi = 0x9f; // no UTF-16 surrogates
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    need = 3;
    if (lead === 0xf0) lo = 0x90;
    if (lead === 0xf4) hi = 0x8f;
  } else return 0;
  for (let k = 1; k <= need; k++) {
    if (i + k >= buf.length) return truncated ? buf.length - i : 0;
    const c = buf[i + k];
    const min = k === 1 ? lo : 0x80;
    const max = k === 1 ? hi : 0xbf;
    if (c < min || c > max) return 0;
  }
  return need + 1;
}

/**
 * isbinaryfile-style heuristic over a leading sample of a file.
 * `truncated` says the sample is a prefix of a longer file (so a cut-off UTF-8 sequence is fine).
 */
export function looksBinary(buf: Uint8Array, truncated = false): boolean {
  const n = buf.length;
  if (n === 0) return false;
  if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return false;
  if (n >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  if (n >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) return true; // %PDF-
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if ((b >= 7 && b <= 13) || b === 27 || (b >= 32 && b <= 126)) continue;
    if (b >= 0x80) {
      const len = utf8SequenceLength(buf, i, truncated);
      if (len > 0) {
        i += len - 1;
        continue;
      }
    }
    suspicious++;
  }
  return suspicious * 10 > n;
}

export type FileKind =
  | { kind: 'image'; mimeType: string }
  | { kind: 'binary' }
  | { kind: 'text'; encoding: TextEncoding };

/**
 * Classifies a file from its path and leading bytes. Images are recognized by extension, but only
 * when the bytes really are one of the supported formats (the MIME type comes from the bytes, so a
 * mislabelled .png that is really a JPEG is still sent correctly); anything else falls through to
 * the binary/text check.
 */
export function classify(filePath: string, sample: Uint8Array, truncated: boolean): FileKind {
  if (imageMimeForPath(filePath)) {
    const mimeType = sniffImageMime(sample);
    if (mimeType) return { kind: 'image', mimeType };
  }
  if (looksBinary(sample, truncated)) return { kind: 'binary' };
  return { kind: 'text', encoding: detectEncoding(sample) };
}

/** Reads the leading SNIFF_BYTES of a file. */
export async function readSample(filePath: string, bytes = SNIFF_BYTES): Promise<{ sample: Buffer; size: number }> {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(bytes, size));
    let read = 0;
    while (read < buf.length) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { sample: buf.subarray(0, read), size };
  } finally {
    await fh.close();
  }
}
