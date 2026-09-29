import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { errnoCode } from './errors.js';

export interface ListingCaps {
  /** Max entries shown for the root directory. */
  top: number;
  /** Max entries shown per nested directory. */
  nested: number;
  /** Max entries in the whole listing (guards against huge trees at high depth). */
  total: number;
}

export const DEFAULT_LISTING_CAPS: ListingCaps = { top: 1000, nested: 100, total: 10000 };

function byName(a: Dirent, b: Dirent): number {
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Depth-first listing: '[DIR] rel', '[FILE] rel', '[LINK] rel -> target' (links are never followed),
 * children right after their directory, entries sorted case-insensitively. depth 1 = direct children.
 * Throws the fs error when `root` itself cannot be read (callers map it to a message).
 */
export async function listDirectoryLines(
  root: string,
  depth: number,
  caps: ListingCaps = DEFAULT_LISTING_CAPS,
  rootLabel = path.basename(root) || root,
): Promise<string[]> {
  const out: string[] = [];
  let budget = caps.total;
  let cutShort = false;

  const walk = async (abs: string, rel: string, entries: Dirent[], depthLeft: number, top: boolean) => {
    entries.sort(byName);
    const cap = top ? caps.top : caps.nested;
    const shown = entries.length > cap ? entries.slice(0, cap) : entries;
    for (const entry of shown) {
      if (budget <= 0) {
        cutShort = true;
        return;
      }
      budget--;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) {
        let target = '?';
        try {
          target = await fs.readlink(childAbs);
        } catch {
          /* raced away or unreadable: still show the link */
        }
        out.push(`[LINK] ${childRel} -> ${target}`);
      } else if (entry.isDirectory()) {
        out.push(`[DIR] ${childRel}`);
        if (depthLeft > 1) {
          let sub: Dirent[];
          try {
            sub = await fs.readdir(childAbs, { withFileTypes: true });
          } catch (err) {
            const code = errnoCode(err);
            out.push(`[DENIED] ${childRel} — not accessible${code === 'EACCES' || code === 'EPERM' ? '' : ` (${code ?? 'error'})`}`);
            continue;
          }
          await walk(childAbs, childRel, sub, depthLeft - 1, false);
          if (cutShort) return;
        }
      } else {
        out.push(`[FILE] ${childRel}`);
      }
    }
    if (entries.length > cap) {
      out.push(
        `[WARNING] ${rel || rootLabel}: ${entries.length - cap} items hidden (showing first ${cap} of ${entries.length} total)`,
      );
    }
  };

  const rootEntries = await fs.readdir(root, { withFileTypes: true });
  await walk(root, '', rootEntries, depth, true);
  if (cutShort) {
    out.push(`[WARNING] Listing truncated after ${caps.total} entries. Use a smaller depth or list a subdirectory.`);
  }
  return out.length ? out : ['(empty directory)'];
}
