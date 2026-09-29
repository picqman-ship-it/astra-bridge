import { StringDecoder } from 'node:string_decoder';

/**
 * Text encodings we read and write faithfully. Anything without a BOM is treated as UTF-8.
 * UTF-16BE is handled by byte-swapping into UTF-16LE, so no ICU data is needed.
 */
export type EncodingName = 'utf8' | 'utf16le' | 'utf16be';

export interface TextEncoding {
  name: EncodingName;
  /** Number of BOM bytes at the start of the file (0 when there is none). */
  bomLength: number;
}

export const UTF8: TextEncoding = { name: 'utf8', bomLength: 0 };

export function detectEncoding(head: Uint8Array): TextEncoding {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { name: 'utf8', bomLength: 3 };
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { name: 'utf16le', bomLength: 2 };
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { name: 'utf16be', bomLength: 2 };
  return UTF8;
}

function swapped(buf: Uint8Array): Buffer {
  const even = buf.length - (buf.length % 2);
  const out = Buffer.from(buf.subarray(0, even)); // copy: swap16 works in place
  return out.swap16();
}

/** Decodes a whole file buffer (BOM included) to a string without the BOM. */
export function decodeBuffer(buf: Buffer, enc: TextEncoding): string {
  const body = buf.subarray(enc.bomLength);
  if (enc.name === 'utf16le') return body.toString('utf16le');
  if (enc.name === 'utf16be') return swapped(body).toString('utf16le');
  return body.toString('utf8');
}

/** Encodes text in `enc`, re-adding the BOM when the original file had one. */
export function encodeText(text: string, enc: TextEncoding, withBom = enc.bomLength > 0): Buffer {
  if (enc.name === 'utf16le') {
    const body = Buffer.from(text, 'utf16le');
    return withBom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
  }
  if (enc.name === 'utf16be') {
    const body = Buffer.from(text, 'utf16le').swap16();
    return withBom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body;
  }
  const body = Buffer.from(text, 'utf8');
  return withBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** True when `buf` is well-formed UTF-8 (so decoding and re-encoding is lossless). */
export function isValidUtf8(buf: Uint8Array): boolean {
  try {
    strictUtf8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Incremental decoder for streamed chunks (multi-byte sequences may span chunk boundaries). */
export interface ChunkDecoder {
  write(chunk: Buffer): string;
  end(): string;
}

export function createChunkDecoder(enc: TextEncoding): ChunkDecoder {
  if (enc.name !== 'utf16be') {
    const d = new StringDecoder(enc.name);
    return { write: (c) => d.write(c), end: () => d.end() };
  }
  const d = new StringDecoder('utf16le');
  let carry: Buffer | null = null;
  return {
    write(chunk) {
      let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      if (buf.length % 2 === 1) {
        carry = Buffer.from(buf.subarray(buf.length - 1));
        buf = buf.subarray(0, buf.length - 1);
      }
      return d.write(swapped(buf));
    },
    end: () => d.end(),
  };
}
