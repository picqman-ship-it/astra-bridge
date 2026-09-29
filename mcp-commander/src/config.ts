import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './security/paths.js';

/**
 * Persistent server configuration.
 *
 * Like Desktop Commander, the config is a pretty-printed JSON file that is created with
 * defaults on first run and can be changed at runtime (set_config_value) or edited by hand.
 * Instead of an fs.watch hot-reload we re-stat the file on every read: external edits are
 * picked up on the next tool call, with no watcher lifecycle to manage.
 */
export interface ServerConfig {
  blockedCommands: string[];
  allowedDirectories: string[];
  defaultShell: string;
  fileReadLineLimit: number;
  fileWriteLineLimit: number;
}

export type ConfigKey = keyof ServerConfig;

/**
 * What the tools need from a configuration. ConfigManager (local, editable config.json) is one
 * implementation; the remote HTTP entrypoint supplies a fixed, read-only one.
 */
export interface ConfigSource {
  readonly file: string;
  readonly loadError: string | null;
  get(): ServerConfig;
  getValue<K extends ConfigKey>(key: K): ServerConfig[K];
  set(key: ConfigKey, raw: unknown): ServerConfig;
}

type ValueType = 'array' | 'string' | 'number';

export const CONFIG_FIELDS: Record<ConfigKey, { valueType: ValueType; description: string }> = {
  blockedCommands: {
    valueType: 'array',
    description: 'Command names that start_process / interact_with_process refuse to run.',
  },
  allowedDirectories: {
    valueType: 'array',
    description: 'Directories the file and search tools may touch. Empty list = whole filesystem.',
  },
  defaultShell: { valueType: 'string', description: 'Shell used by start_process when none is given.' },
  fileReadLineLimit: { valueType: 'number', description: 'Default max lines returned by read_file and by the terminal tools (start_process, read_process_output, interact_with_process).' },
  fileWriteLineLimit: {
    valueType: 'number',
    description: 'write_file / edit_block warn when a single write exceeds this many lines.',
  },
};

export const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as ConfigKey[];

export const DEFAULT_BLOCKED_COMMANDS = [
  'mkfs', 'format', 'mount', 'umount', 'fdisk', 'dd', 'parted', 'diskpart', 'sudo', 'su', 'passwd',
  'adduser', 'useradd', 'usermod', 'groupadd', 'chsh', 'visudo', 'shutdown', 'reboot', 'halt',
  'poweroff', 'init', 'iptables', 'firewall', 'netsh', 'sfc', 'bcdedit', 'reg', 'net', 'sc', 'runas',
  'cipher', 'takeown',
];

export function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
}

export function getDefaultConfig(): ServerConfig {
  return {
    blockedCommands: [...DEFAULT_BLOCKED_COMMANDS],
    allowedDirectories: [],
    defaultShell: defaultShell(),
    fileReadLineLimit: 1000,
    fileWriteLineLimit: 50,
  };
}

export function defaultConfigDir(): string {
  return process.env.MCP_COMMANDER_CONFIG_DIR || path.join(os.homedir(), '.mcp-commander');
}

/** Normalizes a raw value for `key`, throwing a user-facing message when it cannot be used. */
export function coerceConfigValue(key: ConfigKey, raw: unknown): ServerConfig[ConfigKey] {
  const field = Object.prototype.hasOwnProperty.call(CONFIG_FIELDS, key) ? CONFIG_FIELDS[key] : undefined;
  if (!field) throw new Error(`Unknown config key: ${String(key)}`);
  const { valueType } = field;
  let value = raw;
  // JSON-looking strings are parsed, so clients that can only send strings still work.
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
    try {
      value = JSON.parse(value);
    } catch {
      // A malformed JSON array for a list key is a mistake, not a one-element list ("[bad").
      if (valueType === 'array') throw new Error(`Value for ${key} is not a valid JSON array: ${value}`);
      /* other keys: keep the raw string */
    }
  }
  if (valueType === 'array') {
    // FIX: blockedCommands "rm, sudo" used to become the single entry "rm, sudo", which matches no
    // command, so the whole blocklist (sudo included) was silently switched off. Command names
    // never contain commas or whitespace, so a plain string is a list of names. (A plain string
    // for allowedDirectories stays one path: paths may contain both.)
    if (typeof value === 'string') {
      value = key === 'blockedCommands' ? value.split(/[\s,]+/) : value.trim() === '' ? [] : [value];
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new Error(`Value for ${key} must be an array of strings (or a JSON array string).`);
    }
    return value.map((v) => v.trim()).filter(Boolean);
  }
  if (valueType === 'number') {
    // Only numbers and numeric strings: Number('') is 0, Number([5]) is 5, Number(true) is 1.
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Value for ${key} must be a positive integer.`);
    return n;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Value for ${key} must be a non-empty string.`);
  }
  return value.trim();
}

export class ConfigManager implements ConfigSource {
  readonly dir: string;
  readonly file: string;
  private config: ServerConfig = getDefaultConfig();
  /** Raw text of config.json as last loaded or written (null = never loaded). */
  private lastRaw: string | null = null;
  loadError: string | null = null;
  /** Set while config.json exists but cannot be read (EACCES, EISDIR...): set() must not clobber it. */
  private readError: string | null = null;

  constructor(dir = defaultConfigDir()) {
    // FIX: MCP client configs pass --config-dir / MCP_COMMANDER_CONFIG_DIR without a shell, so
    // "~/.mcp-commander" arrived literally and a directory named "~" was created in the server's
    // cwd (often the user's project). Expand ~ and make the path absolute.
    this.dir = path.resolve(expandHome(dir));
    this.file = path.join(this.dir, 'config.json');
    this.load();
  }

  private load(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(this.file)) {
        this.writeAtomically(getDefaultConfig());
      }
    } catch (err) {
      // FIX: an unwritable config location (read-only home, sandbox, a file in the way) used to
      // crash the server at startup. Run on defaults instead and say why in get_config.
      this.loadError = `Could not create ${this.file}: ${(err as Error).message} (using defaults; changes cannot be saved)`;
    }
    this.reloadIfChanged(true);
  }

  /**
   * Re-reads config.json when its content changed since the last load.
   *
   * FIX: this used to compare only mtimeMs, but two edits within the filesystem's timestamp
   * granularity (1 s on some filesystems, and coarse on others) leave mtime unchanged, so a quick
   * second edit was silently ignored. The file is tiny, so we simply compare the raw content.
   */
  private reloadIfChanged(force = false): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // file deleted (or never created): keep the last known config in memory
        if (this.readError) this.loadError = null;
        this.readError = null;
        return;
      }
      // FIX: an existing but unreadable config.json (chmod 000, root-owned after a sudo run, a
      // directory) was treated like a missing one: at startup the server silently ran on defaults
      // (no allowedDirectories restriction) and get_config showed no warning.
      this.readError = `${this.file} exists but cannot be read (${(err as Error).message})`;
      this.loadError =
        `Could not read ${this.file}: ${(err as Error).message} ` +
        `(${force ? 'using defaults' : 'keeping the last loaded settings'})`;
      this.lastRaw = null; // re-parse it once it is readable again
      return;
    }
    this.readError = null;
    if (!force && raw === this.lastRaw) return;
    this.lastRaw = raw;
    try {
      this.config = this.sanitize(JSON.parse(raw));
      this.loadError = null;
    } catch (err) {
      // Corrupt file: keep the previous config rather than silently dropping restrictions.
      this.loadError = `Could not parse ${this.file}: ${(err as Error).message}`;
    }
  }

  /** Reject invalid security settings rather than silently broadening access. */
  private sanitize(parsed: unknown): ServerConfig {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config.json must contain a JSON object.');
    }
    const merged = getDefaultConfig();
    if (parsed && typeof parsed === 'object') {
      for (const key of CONFIG_KEYS) {
        const raw = (parsed as Record<string, unknown>)[key];
        if (raw === undefined) continue;
        try {
          (merged as unknown as Record<string, unknown>)[key] = coerceConfigValue(key, raw);
        } catch (err) {
          if (key === 'allowedDirectories' || key === 'blockedCommands') {
            throw new Error(`Invalid security setting ${key}: ${(err as Error).message}`);
          }
          /* Non-security preferences may keep their default. */
        }
      }
    }
    return merged;
  }

  /** Writes via temp file + rename (0600: the file controls the server's guard rails). */
  private writeAtomically(cfg: ServerConfig): void {
    const text = JSON.stringify(cfg, null, 2) + '\n';
    // FIX: renaming over a symlinked config.json (dotfiles setups) replaced the link with a plain
    // file, so the real file was never updated and later edits to it were ignored. Write the target.
    let target = this.file;
    try {
      target = fs.realpathSync(this.file);
    } catch {
      /* missing (or a dangling link): write the path itself */
    }
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    this.lastRaw = text;
  }

  get(): ServerConfig {
    this.reloadIfChanged();
    return structuredClone(this.config);
  }

  getValue<K extends ConfigKey>(key: K): ServerConfig[K] {
    return this.get()[key];
  }

  set(key: ConfigKey, raw: unknown): ServerConfig {
    const value = coerceConfigValue(key, raw);
    this.reloadIfChanged();
    if (this.readError) {
      // Writing would replace settings we could not even read (possibly stricter ones).
      throw new Error(`${this.readError}. Refusing to overwrite it; fix its permissions (or remove it) and try again.`);
    }
    const next = { ...this.config, [key]: value } as ServerConfig;
    // If the file is corrupt, this.config still holds the last good config, so the write
    // replaces the broken file with a valid one (the original failed every set in that state).
    this.writeAtomically(next);
    this.config = next;
    this.loadError = null;
    return structuredClone(next);
  }
}
