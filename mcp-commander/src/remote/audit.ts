import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Bounded, owner-only audit log for the remote entrypoints (JSON lines).
 *
 * Records metadata only — time, event, tool name, status, duration and a short hash of the MCP
 * session id. Never tool arguments, results, paths, tokens or headers. When the file passes
 * maxBytes it is rotated to .1 … .(maxFiles-1); the oldest is deleted.
 */

export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditEntry {
  event: 'tool' | 'auth_failed' | 'session_open' | 'session_close' | 'service_start' | 'service_stop';
  tool?: string;
  status?: AuditStatus;
  durationMs?: number;
  session?: string;
  reason?: string;
}

export function sessionTag(sessionId: string | undefined): string | undefined {
  return sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 12) : undefined;
}

export class AuditLog {
  private size = -1;
  private failed = false;

  constructor(
    readonly file: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {}

  write(entry: AuditEntry): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    try {
      if (this.size < 0) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this.size = fs.statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
      }
      if (this.size + line.length > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
      this.failed = false;
    } catch (err) {
      // An unwritable log must not stop tool calls; say so once on stderr (message only).
      if (!this.failed) console.error(`[mcp-commander-remote] audit log write failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
      this.failed = true;
      this.size = -1;
    }
  }

  private rotate(): void {
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (this.maxFiles <= 1) fs.rmSync(this.file, { force: true });
    fs.rmSync(`${this.file}.${this.maxFiles}`, { force: true });
    this.size = 0;
  }
}
