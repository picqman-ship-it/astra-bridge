import { CallHistory } from '../history.js';
import { SearchManager } from '../search/manager.js';
import { createCommanderServer, type CommanderServer } from '../server.js';
import { TerminalManager } from '../terminal/manager.js';
import { AuditLog, sessionTag } from './audit.js';
import { RemoteConfigSource, type RemoteConfig } from './config.js';
import { IdempotencyStore } from './idempotency.js';
import { JobService } from './job-service.js';
import { remoteInstructions, selectRemoteTools } from './policy.js';

const SUPERVISE_EVERY_MS = 2000;

/**
 * State shared by every remote MCP session of one service process.
 *
 * Terminal sessions, searches and call history belong to the service, not to an MCP session: a
 * client that reconnects (same or new MCP session) finds its REPL by PID. They end with
 * force_terminate / stop_search, or when the service stops — a restarted service starts empty and
 * cannot resume processes the previous one owned (they are stopped on shutdown).
 *
 * Durable jobs are different: they run in the detached job worker (job-worker.ts), not here, so
 * shutdown() leaves them alone and a restarted service finds them on disk. Idempotency records
 * live on disk too and are shared with every other server process using this remote directory.
 */
export class RemoteRuntime {
  readonly terminal = new TerminalManager();
  readonly search = new SearchManager();
  readonly history = new CallHistory();
  readonly audit: AuditLog;
  readonly idempotency: IdempotencyStore;
  /** Present only in trusted-terminal mode. */
  readonly jobs: JobService | null;
  private readonly config: RemoteConfigSource;
  private stopping: Promise<void> | null = null;
  private supervisor: NodeJS.Timeout | null = null;
  private supervising = false;
  private reportedSupervisionError = false;

  constructor(readonly cfg: RemoteConfig) {
    this.config = new RemoteConfigSource(cfg);
    this.audit = new AuditLog(cfg.auditFile, cfg.audit.maxBytes, cfg.audit.maxFiles);
    this.idempotency = new IdempotencyStore(cfg);
    this.jobs = cfg.trustedTerminal ? new JobService(cfg) : null;
    if (this.jobs) {
      // Unfinished jobs and no live worker (never started, idle-exited with work left, or died):
      // start one, now and every few seconds. It settles a dead worker's jobs (never re-running
      // them) and runs queued ones. This is the only automatic worker start besides job_start and
      // job_cancel; the read-only job tools never start anything.
      this.superviseJobs();
      this.supervisor = setInterval(() => this.superviseJobs(), SUPERVISE_EVERY_MS);
      this.supervisor.unref();
    }
  }

  private superviseJobs(): void {
    if (!this.jobs || this.supervising) return;
    this.supervising = true;
    this.jobs
      .resumeIfPending()
      .catch((err) => {
        if (!this.reportedSupervisionError) {
          console.error(`[mcp-commander-remote] job worker check failed: ${err instanceof Error ? err.message : 'error'}`);
        }
        this.reportedSupervisionError = true;
      })
      .finally(() => (this.supervising = false));
  }

  /** A new MCP server bound to the shared state. `sessionId` feeds the audit log's session tag. */
  createServer(sessionId: () => string | undefined): CommanderServer {
    return createCommanderServer({
      config: this.config,
      history: this.history,
      terminal: this.terminal,
      search: this.search,
      selectTools: selectRemoteTools(this.cfg, { idempotency: this.idempotency, jobs: this.jobs }),
      instructions: remoteInstructions(this.cfg),
      onToolCall: (e) =>
        this.audit.write({
          event: 'tool',
          tool: e.tool,
          status: e.ok ? 'ok' : 'error',
          durationMs: e.durationMs,
          session: sessionTag(sessionId()),
        }),
    });
  }

  /**
   * Stops searches and every interactive process the service started. Durable jobs are not
   * touched: they belong to the job worker. Safe to call more than once.
   */
  shutdown(): Promise<void> {
    if (this.supervisor) clearInterval(this.supervisor);
    this.supervisor = null;
    this.stopping ??= (async () => {
      this.search.shutdown();
      await this.terminal.shutdown();
    })();
    return this.stopping;
  }
}
