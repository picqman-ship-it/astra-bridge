/**
 * Input-prompt detection for terminal sessions.
 *
 * Desktop Commander tested a loose regex against whole stdout chunks and used `includes()` on
 * the last line, so '<div>\n', 'price $\n', 'Downloading 45% done' or 'a + b' all counted as
 * "waiting for input". Here we only look at the last *unterminated* line (a prompt is never
 * followed by a newline), and it must end in a recognisable prompt shape — almost always a
 * prompt character followed by trailing whitespace. The caller additionally requires ~100ms of
 * output quiet before trusting a match, which filters out lines that are merely mid-stream.
 */

const MAX_PROMPT_LINE = 200;

/** "Password:", "user@host's password:", "Enter passphrase for key '~/.ssh/id_ed25519':" */
const PASSWORD_RE = /(?:password|passphrase|passcode)\b[^\n]{0,120}:\s*$/i;
/** "Continue? [y/N]", "Overwrite (y/n)", "[Yes/no]:" */
const YES_NO_RE = /[[(]\s*(?:y|yes|n|no)\s*\/\s*(?:y|yes|n|no)\s*[\])]\s*[:?]?\s*$/i;
/** An HTML/XML-ish tag at the end of the line: "<div>", "</p>", '<a href="x">'. */
const TAG_END_RE = /<\/?[A-Za-z!][^<>]*>$/;
/** Continuation prompts: Python / IPython "...", "   ...:"; Node's REPL "|" (Node >= 20) */
const CONTINUATION_RE = /^\s*(?:\.\.\.:?|\|)$/;
/** Whole-line debugger prompts: "(Pdb)", "(gdb)", "(lldb)", "(Cmd)" */
const PAREN_WORD_RE = /^\s*\([A-Za-z][\w .-]{0,30}\)$/;
/** A default-value group closing the line, e.g. "package name: (my-app)", "Name? [bob]" */
const DEFAULT_GROUP_RE = /^(.*?)\s*(?:\([^()]*\)|\[[^[\]]*\])$/;
/** Fancy shell prompt glyphs (starship, oh-my-zsh, fish themes). */
const GLYPH_END_RE = /[❯➜λ»›]$/u;
/** Several REPL prompts in a row, printed when multi-line input was sent: ">>> >>> ", "... ... ", "> > ", "| | ". */
const REPEATED_RE = /^\s*(?:(?:>>>|\.\.\.:?|>|\|)[ \t]+){2,}$/;

/**
 * Returns the prompt text (the trimmed last line) when `lastLine` looks like a program waiting
 * for input, or null. Only the text after the last '\n' and after the last '\r' is considered,
 * so a terminated line ('...\n') never matches.
 */
export function detectPrompt(lastLine: string): string | null {
  if (typeof lastLine !== 'string' || lastLine === '') return null;
  let line = lastLine;
  const nl = line.lastIndexOf('\n');
  if (nl !== -1) line = line.slice(nl + 1);
  const cr = line.lastIndexOf('\r');
  if (cr !== -1) line = line.slice(cr + 1);
  if (line.length === 0 || line.length > MAX_PROMPT_LINE) return null;
  if (line.trim() === '') return null;

  const found = line.trim();
  if (REPEATED_RE.test(line)) return found.split(/\s+/).pop() ?? found;

  // Shapes that are unambiguous even without trailing whitespace.
  if (PASSWORD_RE.test(line) || YES_NO_RE.test(line)) return found;

  const body = line.replace(/[ \t]+$/, '');
  if (body.length === line.length) return null; // no trailing space: not a prompt shape
  if (body.trim() === '') return null;

  if (CONTINUATION_RE.test(body)) return found; // "... ", "   ...: "

  const last = body[body.length - 1];
  switch (last) {
    case '>':
      // ">>> ", "> ", "mysql> ", "irb(main):001:0> ", "    -> ", "PS C:\\> " — but not "<div> "
      return TAG_END_RE.test(body) ? null : found;
    case '$': // "$ ", "user@host:~/dir$ ", "bash-5.2$ "
    case '#': // "# ", "root@box:/# ", "db=# ", "db-# "
      return found;
    case '%':
      // "% ", "host% " (zsh/csh) — but not a progress figure such as "Downloading 45% "
      return /\d%$/.test(body) ? null : found;
    case ':':
      // "Password: ", "Enter your name: ", "In [3]: " — but not a lone ":" or "::"
      return /[^\s:]:$/.test(body) ? found : null;
    case '?':
      // "Continue? ", "Are you sure? "
      return body.trim().length > 1 ? found : null;
    case ')':
    case ']': {
      if (PAREN_WORD_RE.test(body)) return found; // "(Pdb) "
      const m = DEFAULT_GROUP_RE.exec(body);
      if (m && /[:?]$/.test(m[1].trimEnd())) return found; // "package name: (app) "
      return null;
    }
    default:
      return GLYPH_END_RE.test(body) ? found : null;
  }
}
