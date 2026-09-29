/**
 * Glob support shared by both search engines.
 *
 * Two dialects are needed and both follow ripgrep / gitignore conventions so that the built-in
 * engine returns what `rg` would:
 *  - "gitignore globs" (ignore files and filePattern overrides): a glob without a slash matches
 *    the basename at any depth, a glob with a slash is anchored to its base directory, a
 *    trailing slash means "directories only", `!` negates, and the last matching rule wins;
 *  - plain globs for the file-name `pattern` of files-mode searches.
 * In both, `*` and `?` never cross `/`, `**` spans directories, `[...]` / `[!...]` are
 * character classes, `{a,b}` is alternation, and a backslash escapes the next character.
 */

/** Characters that make a files-mode pattern a glob instead of a substring. */
const GLOB_CHARS = /[*?[\]{}]/;

export function hasGlobChars(pattern: string): boolean {
  return GLOB_CHARS.test(pattern);
}

export class GlobSyntaxError extends Error {}

const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_SPECIAL, '\\$&');
}

/** Escapes one character for use inside a regex character class. */
function escapeClassChar(c: string): string {
  return c === '\\' || c === ']' || c === '[' || c === '^' ? `\\${c}` : c;
}

/**
 * Translates a glob into an (unanchored) regex source. Throws GlobSyntaxError for an
 * unclosed `[` or `{`, with ripgrep's wording.
 */
export function globToRegexSource(glob: string): string {
  let out = '';
  let depth = 0; // open `{` groups
  const n = glob.length;
  let i = 0;
  while (i < n) {
    const c = glob[i];
    if (c === '\\') {
      if (i + 1 < n) {
        out += escapeRegex(glob[i + 1]);
        i += 2;
      } else {
        out += '\\\\';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const startsComponent = i === 0 || glob[i - 1] === '/';
        const after = i + 2;
        const endsComponent = after === n || glob[after] === '/';
        if (startsComponent && endsComponent) {
          if (after === n) {
            out += '.*';
            i = after;
          } else {
            // `**/` : zero or more whole directories (the slash is consumed).
            out += '(?:.*/)?';
            i = after + 1;
          }
          continue;
        }
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let negated = false;
      if (glob[j] === '!' || glob[j] === '^') {
        negated = true;
        j++;
      }
      let body = '';
      let first = true;
      let closed = false;
      while (j < n) {
        const d = glob[j];
        if (d === ']' && !first) {
          closed = true;
          break;
        }
        if (d === '\\' && j + 1 < n) {
          body += escapeClassChar(glob[j + 1]);
          j += 2;
        } else {
          body += d === '-' ? '-' : escapeClassChar(d);
          j++;
        }
        first = false;
      }
      if (!closed) throw new GlobSyntaxError("unclosed character class; missing ']'");
      out += `[${negated ? '^' : ''}${body}]`;
      i = j + 1;
      continue;
    }
    if (c === '{') {
      depth++;
      out += '(?:';
      i++;
      continue;
    }
    if (c === '}' && depth > 0) {
      depth--;
      out += ')';
      i++;
      continue;
    }
    if (c === ',' && depth > 0) {
      out += '|';
      i++;
      continue;
    }
    out += escapeRegex(c);
    i++;
  }
  if (depth > 0) throw new GlobSyntaxError("unclosed alternate group; missing '}'");
  return out;
}

/** Compiles a glob that must match the whole input. */
export function compileGlob(glob: string, ignoreCase = false): RegExp {
  let source: string;
  try {
    source = globToRegexSource(glob);
    return new RegExp(`^${source}$`, ignoreCase ? 'i' : '');
  } catch (err) {
    if (err instanceof GlobSyntaxError) throw err;
    throw new GlobSyntaxError((err as Error).message);
  }
}

/** Splits a '|'-separated filePattern into trimmed, non-empty globs. */
export function splitFilePatterns(filePattern: string | undefined | null): string[] {
  if (!filePattern) return [];
  return filePattern
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Converts an OS path (relative) to the forward-slash form globs are matched against. Only on
 * Windows: elsewhere a backslash is a legal file-name character and the glob escape character.
 */
export function toSlash(p: string): string {
  return process.platform === 'win32' && p.includes('\\') ? p.split('\\').join('/') : p;
}

export type RuleMatch = 'ignore' | 'whitelist' | null;

interface IgnoreRule {
  regex: RegExp;
  whitelist: boolean;
  dirOnly: boolean;
}

/**
 * Parses one gitignore-style line (the ignore crate's rules). Returns null for blank lines and
 * comments; throws GlobSyntaxError for an invalid glob.
 */
function parseRule(raw: string): IgnoreRule | null {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line.startsWith('#')) return null;
  if (!line.endsWith('\\ ')) line = line.trimEnd();
  if (line === '') return null;
  let whitelist = false;
  let absolute = false;
  if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
  } else {
    if (line.startsWith('!')) {
      whitelist = true;
      line = line.slice(1);
    }
    if (line.startsWith('/')) {
      absolute = true;
      line = line.slice(1);
    }
  }
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
    if (line.endsWith('\\')) line = line.slice(0, -1);
  }
  if (line === '') return null;
  let glob = line;
  if (!absolute && !glob.includes('/') && !glob.startsWith('**/')) glob = `**/${glob}`;
  if (glob.endsWith('/**')) glob = `${glob}/*`;
  return { regex: compileGlob(glob), whitelist, dirOnly };
}

/**
 * A set of gitignore-style rules relative to `base` (an absolute directory). The last matching
 * rule wins, exactly like git and ripgrep.
 */
export class IgnoreRules {
  private constructor(
    readonly base: string,
    private readonly rules: IgnoreRule[],
  ) {}

  /** Builds rules from an ignore file's text; invalid lines are skipped (rg warns and skips too). */
  static fromText(base: string, text: string): IgnoreRules {
    const rules: IgnoreRule[] = [];
    for (const line of text.split('\n')) {
      try {
        const rule = parseRule(line);
        if (rule) rules.push(rule);
      } catch {
        /* skip invalid glob */
      }
    }
    return new IgnoreRules(base, rules);
  }

  /** Builds rules from globs, throwing `error parsing glob '<g>': <reason>` on the first bad one. */
  static fromGlobs(base: string, globs: string[]): IgnoreRules {
    const rules: IgnoreRule[] = [];
    for (const g of globs) {
      try {
        const rule = parseRule(g);
        if (rule) rules.push(rule);
      } catch (err) {
        throw new GlobSyntaxError(`error parsing glob '${g}': ${(err as Error).message}`);
      }
    }
    return new IgnoreRules(base, rules);
  }

  get size(): number {
    return this.rules.length;
  }

  get whitelistCount(): number {
    return this.rules.filter((r) => r.whitelist).length;
  }

  /** `rel` is the forward-slash path relative to `base` (no leading './'). */
  match(rel: string, isDir: boolean): RuleMatch {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i];
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(rel)) return rule.whitelist ? 'whitelist' : 'ignore';
    }
    return null;
  }
}

export type OverrideMatch = 'include' | 'exclude' | null;

/**
 * filePattern globs with ripgrep `-g` semantics: a plain glob includes, `!glob` excludes, the
 * last matching glob wins, and when at least one including glob exists a *file* that matches
 * none of them is excluded (directories are still descended into).
 */
export class FileGlobs {
  private readonly rules: IgnoreRules;
  private readonly hasIncludes: boolean;

  constructor(globs: string[]) {
    this.rules = IgnoreRules.fromGlobs('', globs);
    // In IgnoreRules terms an including glob is a plain ("ignore") rule.
    this.hasIncludes = this.rules.size - this.rules.whitelistCount > 0;
  }

  get empty(): boolean {
    return this.rules.size === 0;
  }

  match(rel: string, isDir: boolean): OverrideMatch {
    if (this.rules.size === 0) return null;
    const m = this.rules.match(rel, isDir);
    if (m === 'ignore') return 'include';
    if (m === 'whitelist') return 'exclude';
    if (this.hasIncludes && !isDir) return 'exclude';
    return null;
  }

  /**
   * files mode: may a directory whose name matches the pattern be reported? filePattern is ANDed
   * with the pattern, so with including globs the directory itself must match one of them.
   */
  acceptsDir(rel: string): boolean {
    if (this.rules.size === 0) return true;
    const m = this.rules.match(rel, true);
    if (m === 'whitelist') return false; // excluded by '!glob'
    if (m === 'ignore') return true; // matched an including glob
    return !this.hasIncludes;
  }
}

/**
 * The files-mode name matcher: a glob when the pattern has glob characters, otherwise a
 * substring; against the basename, or against the root-relative path when the pattern contains
 * '/'. A glob pattern also matches names that literally contain it (so '[id].tsx' finds the
 * Next.js route file, not just 'i.tsx').
 */
export class NameMatcher {
  private readonly glob: RegExp | null;
  private readonly needle: string;
  private readonly ignoreCase: boolean;
  readonly usesPath: boolean;
  private readonly dirOnly: boolean;
  private readonly exactName: string;

  constructor(pattern: string, ignoreCase: boolean) {
    this.ignoreCase = ignoreCase;
    const normalized = toSlash(pattern);
    this.usesPath = normalized.includes('/');
    this.needle = ignoreCase ? normalized.toLowerCase() : normalized;
    let globSource = normalized;
    let dirOnly = false;
    if (this.usesPath) {
      while (globSource.startsWith('./')) globSource = globSource.slice(2);
      if (globSource.startsWith('/')) globSource = globSource.slice(1);
      if (globSource.endsWith('/') && globSource.length > 1) {
        globSource = globSource.slice(0, -1);
        dirOnly = true;
      }
    }
    this.dirOnly = dirOnly;
    let glob: RegExp | null = null;
    if (hasGlobChars(normalized)) {
      try {
        glob = compileGlob(globSource, ignoreCase);
      } catch {
        glob = null; // not a valid glob: literal substring only
      }
    }
    this.glob = glob;
    this.exactName = this.needle;
  }

  /**
   * `rel` is the forward-slash path relative to the search root, `name` the basename.
   */
  matches(rel: string, name: string, isDir: boolean): boolean {
    if (this.usesPath) {
      const target = `/${rel}${isDir ? '/' : ''}`;
      if (this.glob && (!this.dirOnly || isDir) && this.glob.test(rel)) return true;
      return (this.ignoreCase ? target.toLowerCase() : target).includes(this.needle);
    }
    if (this.glob && this.glob.test(name)) return true;
    return (this.ignoreCase ? name.toLowerCase() : name).includes(this.needle);
  }

  /** earlyTermination: the basename (or the path tail, for a pattern with '/') equals the pattern. */
  isExact(rel: string, name: string): boolean {
    if (this.usesPath) {
      let want = this.exactName;
      while (want.startsWith('./')) want = want.slice(2);
      if (!want.startsWith('/')) want = `/${want}`;
      const target = `/${this.ignoreCase ? rel.toLowerCase() : rel}`;
      return target.endsWith(want);
    }
    return (this.ignoreCase ? name.toLowerCase() : name) === this.exactName;
  }
}
