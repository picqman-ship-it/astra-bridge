import { z } from 'zod';

/**
 * Lenient zod building blocks for tool parameters. Models (and some clients) send `null` or ""
 * for parameters they mean to omit, numbers as numeric strings, and booleans as "true"/"false";
 * all of those are accepted here. The JSON schema the SDK publishes is still the plain inner type.
 */

const blankToUndefined = (v: unknown): unknown =>
  v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v;

function intBase(bounds: { min?: number; max?: number }) {
  let n = z.coerce.number().int();
  if (bounds.min !== undefined) n = n.min(bounds.min);
  if (bounds.max !== undefined) n = n.max(bounds.max);
  return n;
}

export function optionalInt(description: string, bounds: { min?: number; max?: number } = {}) {
  return z.preprocess(blankToUndefined, intBase(bounds).optional()).describe(description);
}

export function intWithDefault(def: number, description: string, bounds: { min?: number; max?: number } = {}) {
  return z.preprocess(blankToUndefined, intBase(bounds).default(def)).describe(description);
}

export function boolWithDefault(def: boolean, description: string) {
  return z
    .preprocess((v) => {
      const b = blankToUndefined(v);
      if (typeof b === 'string') {
        const s = b.trim().toLowerCase();
        if (s === 'true') return true;
        if (s === 'false') return false;
      }
      return b;
    }, z.boolean().default(def))
    .describe(description);
}

export function optionalEnum<T extends [string, ...string[]]>(values: T, description: string) {
  return z.preprocess(blankToUndefined, z.enum(values).optional()).describe(description);
}

/** A string array that also accepts a JSON-encoded array string or a single bare string. */
export function stringArray(description: string, bounds: { min?: number; max?: number } = {}) {
  let arr = z.array(z.string());
  if (bounds.min !== undefined) arr = arr.min(bounds.min);
  if (bounds.max !== undefined) arr = arr.max(bounds.max);
  return z
    .preprocess((v) => {
      if (typeof v !== 'string') return v;
      const s = v.trim();
      if (s.startsWith('[')) {
        try {
          return JSON.parse(s);
        } catch {
          return v;
        }
      }
      return [v];
    }, arr)
    .describe(description);
}
