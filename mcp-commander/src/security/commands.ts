/**
 * Command blocklist checking for start_process / interact_with_process.
 *
 * Desktop Commander splits a command line on ; && || | & and compares the first word of every
 * segment against `blockedCommands`. That is easy to walk around (`bash -c "sudo x"`, newlines,
 * `env sudo`, `s''udo`, `\sudo`, `nice sudo` ...). This version tokenizes the line the way a
 * POSIX shell would (quotes removed, escapes applied), follows command substitutions, subshells,
 * `sh -c` / `eval` payloads and common wrapper commands. It is still a guard rail, not a sandbox:
 * an interpreter (`python3 -c "os.system(...)"`) can always run anything.
 */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'mksh']);
/** Wrappers that run their (non-option) argument as a command. */
const WRAPPERS = new Set([
  'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'timeout',
  'xargs', 'sudo', 'doas', 'caffeinate', 'watch', 'chroot', 'setsid', 'unbuffer', 'strace', 'arch',
]);
/** Wrappers whose first non-option argument is a value, not the command (e.g. `timeout 5 cmd`). */
const WRAPPERS_WITH_VALUE = new Set(['timeout', 'chroot']);
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'esac']);
const NON_COMMAND_SEGMENT = new Set(['for', 'case', 'select', 'function']);

interface Parsed {
  segments: string[][];
  nested: string[];
}

function readBalancedParen(s: string, start: number): { inner: string; end: number } {
  // s[start] is the first char after "$(" (or "("); returns the index of the closing ")".
  let depth = 1;
  let i = start;
  let quote: string | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '\\') {
      i++;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return { inner: s.slice(start, i), end: i };
    }
    i++;
  }
  return { inner: s.slice(start), end: s.length };
}

function tokenize(command: string): Parsed {
  const segments: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let skipNextWord = false;

  const endWord = () => {
    if (inWord) {
      if (skipNextWord) skipNextWord = false;
      else words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
    skipNextWord = false;
  };

  const s = command;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      if (s[i + 1] === '\n') {
        i++;
        continue; // line continuation
      }
      if (i + 1 < s.length) {
        word += s[++i];
        inWord = true;
      }
      continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      word += s.slice(i + 1, end === -1 ? s.length : end);
      inWord = true;
      i = end === -1 ? s.length : end;
      continue;
    }
    if (ch === '"') {
      inWord = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          word += s[++i];
        } else if (s[i] === '$' && s[i + 1] === '(') {
          const { inner, end } = readBalancedParen(s, i + 2);
          nested.push(inner);
          word += '$';
          i = end;
        } else if (s[i] === '`') {
          const end = s.indexOf('`', i + 1);
          nested.push(s.slice(i + 1, end === -1 ? s.length : end));
          word += '$';
          i = end === -1 ? s.length : end;
        } else {
          word += s[i];
        }
        i++;
      }
      continue;
    }
    if (ch === '$' && s[i + 1] === '(') {
      const { inner, end } = readBalancedParen(s, i + 2);
      nested.push(inner);
      word += '$';
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      nested.push(s.slice(i + 1, end === -1 ? s.length : end));
      word += '$';
      inWord = true;
      i = end === -1 ? s.length : end;
      continue;
    }
    if (ch === '#' && !inWord) {
      const nl = s.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
      endSegment();
      continue;
    }
    if (ch === '<' || ch === '>') {
      // Redirection: an fd number glued to the operator ("2>") is not a word; the target is skipped.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      while (s[i + 1] === '>' || s[i + 1] === '<' || s[i + 1] === '&' || s[i + 1] === '|') i++;
      skipNextWord = true;
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return { segments, nested };
}

export function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

function commandsInSegment(words: string[], out: string[], depth: number): void {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (isAssignment(w) || RESERVED.has(w)) {
      i++;
      continue;
    }
    if (NON_COMMAND_SEGMENT.has(w)) return;
    if (w.startsWith('$')) return; // dynamic command name (variable / substitution): unknowable
    const name = commandName(w);
    out.push(name);
    const rest = words.slice(i + 1);

    if (SHELLS.has(name)) {
      // bash -c "payload" / bash -lc "payload": analyse the payload as its own command line
      const cIdx = rest.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (cIdx !== -1 && rest[cIdx + 1] !== undefined) collect(rest[cIdx + 1], out, depth + 1);
      return;
    }
    if (name === 'eval') {
      collect(rest.join(' '), out, depth + 1);
      return;
    }
    if (WRAPPERS.has(name)) {
      let j = 0;
      while (j < rest.length && (rest[j].startsWith('-') || isAssignment(rest[j]))) {
        // options that take a separate value (nice -n 5, sudo -u root, xargs -I {}, env -u VAR)
        if (/^-[a-zA-Z]$/.test(rest[j]) && rest[j + 1] !== undefined && !rest[j + 1].startsWith('-')) {
          const next = rest[j + 1];
          if (/^[\d.]+[smhd]?$/.test(next) || /^(-n|-u|-g|-I|-c|-C|-p|-t|-o|-e|-i|-L|-s|-k|-d)$/.test(rest[j])) {
            j++;
          }
        }
        j++;
      }
      if (WRAPPERS_WITH_VALUE.has(name) && j < rest.length) j++;
      i += 1 + j;
      continue;
    }
    return;
  }
}

function collect(command: string, out: string[], depth: number): void {
  if (depth > 8) throw new Error('Command nesting too deep to analyse');
  const { segments, nested } = tokenize(command);
  for (const seg of segments) commandsInSegment(seg, out, depth);
  for (const inner of nested) collect(inner, out, depth + 1);
}

/** Every command name a shell would execute for `command`, lowercased, de-duplicated. */
export function extractCommands(command: string): string[] {
  const out: string[] = [];
  collect(command, out, 0);
  return [...new Set(out.filter(Boolean))];
}

/**
 * True when `command` starts an interactive shell (e.g. `bash`, `zsh -i`, `ssh host`), i.e. a
 * session whose later stdin lines are themselves shell commands. interact_with_process uses this
 * to decide whether its input must pass the blocklist too; REPL input such as Python code is not
 * shell syntax and would only produce false positives.
 */
export function runsInteractiveShell(command: string): boolean {
  const { segments } = tokenize(command);
  const last = segments[segments.length - 1];
  if (!last) return false;
  const words = last.filter((w) => !isAssignment(w));
  let i = 0;
  while (i < words.length && WRAPPERS.has(commandName(words[i]))) i++;
  const name = words[i] ? commandName(words[i]) : '';
  if (name === 'ssh') {
    // interactive unless a remote command follows the destination
    const rest = words.slice(i + 1);
    const positional: string[] = [];
    for (let j = 0; j < rest.length; j++) {
      if (/^-[BbcDEeFIiJLlmOoPpQRSWw]$/.test(rest[j])) j++; // option with a separate value
      else if (!rest[j].startsWith('-')) positional.push(rest[j]);
    }
    return positional.length <= 1;
  }
  if (!SHELLS.has(name) && !['pwsh', 'powershell', 'cmd'].includes(name)) return false;
  // `bash -c "..."` / `bash script.sh` run a payload and exit; bare `bash`, `bash -i`, `bash -l` stay interactive
  return !words.slice(i + 1).some((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w) || !w.startsWith('-'));
}

export interface CommandCheck {
  allowed: boolean;
  blocked?: string;
  reason?: string;
}

/** Extensions that make `name.ext` a script file rather than a variant of the `name` program. */
const SCRIPT_EXTENSIONS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'py', 'rb', 'pl', 'js', 'mjs', 'cjs', 'ts', 'php', 'lua', 'r',
  'ps1', 'psm1', 'vbs', 'jar', 'txt', 'md', 'json', 'yaml', 'yml', 'toml', 'conf', 'cfg', 'ini', 'd',
]);

/**
 * `mkfs.ext4`, `mkfs.vfat`, `fsck.hfs`... are the same tool under a dotted variant name, so a
 * blocked `mkfs` also blocks `mkfs.<variant>`. A script extension is not a variant: blocking
 * `init` must not block `./init.sh`.
 */
function blockedName(name: string, blocked: Set<string>): string | undefined {
  if (blocked.has(name)) return name;
  const dot = name.indexOf('.');
  if (dot > 0) {
    const base = name.slice(0, dot);
    const suffix = name.slice(dot + 1);
    if (blocked.has(base) && /^[a-z0-9]+$/.test(suffix) && !SCRIPT_EXTENSIONS.has(suffix)) return base;
  }
  return undefined;
}

export function checkCommand(command: string, blockedCommands: string[]): CommandCheck {
  const blocked = new Set(blockedCommands.map((c) => c.trim().toLowerCase()).filter(Boolean));
  try {
    for (const name of extractCommands(command)) {
      const hit = blockedName(name, blocked);
      if (hit) return { allowed: false, blocked: hit };
    }
    return { allowed: true };
  } catch (err) {
    return { allowed: false, reason: (err as Error).message };
  }
}
