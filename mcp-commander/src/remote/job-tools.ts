import { z } from 'zod';
import { parseArgs } from '../tools/terminal.js';
import { defineTool, type ToolDef, type ToolResult } from '../types.js';
import { JobService, LOG_READ_MAX, MAX_TIMEOUT_SEC, jobView } from './job-service.js';
import { ALL_STATES, TERMINAL_STATES, type JobState } from './jobs.js';

/**
 * Remote tools for durable jobs (trusted-terminal mode only). Unlike start_process sessions, a
 * job runs in the detached job worker, so it survives MCP disconnects and restarts of this server.
 * It is not interactive (no stdin) and cannot be resumed after the worker itself dies.
 */

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const jobIdParam = z.string().describe('Job id returned by job_start (e.g. j0mg1abcd-0123456789abcdef).');

const startShape = {
  command: z.string().describe('Shell command line to run as a background job, e.g. "npm run build > build.txt".'),
  idempotencyKey: z
    .string()
    .describe(
      'Required. A unique id for this intended job (a fresh UUID). Retrying job_start with the same key and the same ' +
        'request returns the SAME job instead of starting another; the same key with a different request is refused.',
    ),
  cwd: z.string().optional().describe('Working directory inside a configured root (default: the first root).'),
  shell: z.string().optional().describe('Shell to run the command with (default: the configured default shell).'),
  timeoutSeconds: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SEC)
    .optional()
    .describe('Stop the job (SIGTERM, then SIGKILL) after this many seconds. Default: jobs.defaultTimeoutSec (3600).'),
  label: z.string().max(200).optional().describe('Short free-text label shown in job_list.'),
};

const statusShape = { jobId: jobIdParam };

const listShape = {
  state: z.enum(ALL_STATES as [JobState, ...JobState[]]).optional().describe('Only jobs in this state.'),
  limit: z.coerce.number().int().min(1).max(200).default(20).describe('Max jobs to return, newest first (default 20).'),
};

const logsShape = {
  jobId: jobIdParam,
  stream: z.enum(['stdout', 'stderr']).default('stdout').describe('Which log (default stdout).'),
  offset: z.coerce
    .number()
    .int()
    .default(0)
    .describe('Byte offset to start at (use nextOffset from the previous call to follow a log); negative = the last |offset| bytes.'),
  length: z.coerce.number().int().min(1).max(LOG_READ_MAX).optional().describe(`Max bytes to return (default 16384, max ${LOG_READ_MAX}).`),
};

const cancelShape = {
  jobId: jobIdParam,
  wait_ms: z.coerce.number().int().min(0).max(30_000).default(5000).describe('How long to wait for the job to stop (default 5000).'),
};

export function jobTools(jobs: JobService): ToolDef[] {
  const jobStart = defineTool({
    name: 'job_start',
    description:
      'Start a shell command as a durable background job and return at once with its job id. The job runs in a separate ' +
      'worker process on the Mac, so it keeps running if this MCP connection drops or the server restarts; follow it with ' +
      'job_status / job_logs, stop it with job_cancel. At most jobs.maxConcurrent (default 2) run at once; others wait ' +
      'queued. No stdin: use start_process for interactive programs. idempotencyKey is required: retrying with the same key ' +
      'returns the same job and never starts a second one. If the worker itself dies (crash, reboot) a running job is ' +
      'reported interrupted and is never re-run automatically. A job may report progress by printing lines like ' +
      '"MCPC_PROGRESS 3/10 message" or "MCPC_PROGRESS 40%" on stdout; otherwise progress is null (never estimated). ' +
      'Commands using a blocked command name are refused.',
    inputSchema: startShape,
    annotations: { title: 'Start Durable Job', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    handler: async (raw) => {
      const a = parseArgs(startShape, raw);
      const r = await jobs.submit(a);
      return json({
        ...(r.job ? jobView(r.job) : { jobId: r.jobId, state: 'never_started' }),
        deduplicated: r.deduplicated,
        worker: r.worker,
        ...(r.warning ? { warning: r.warning } : {}),
        note: r.deduplicated
          ? 'This idempotencyKey was already used for this request: this is the existing job; nothing new was started.'
          : 'Job accepted. Poll job_status (and job_logs) with this jobId.',
      });
    },
  });

  // Read-only: job_status / job_list / job_logs only read records. Restarting a dead worker is done
  // by the servers themselves (every few seconds while unfinished jobs exist), never by these tools.
  const workerNote = (state: string, unfinished: boolean) =>
    !unfinished || state === 'running'
      ? undefined
      : state === 'unresponsive'
        ? 'The job worker has not sent a heartbeat recently (stopped, or the Mac was asleep); it is not replaced while it may still run.'
        : 'No job worker is running; the server starts one within a few seconds (unfinished jobs of a dead worker are then marked interrupted, never re-run).';

  const jobStatus = defineTool({
    name: 'job_status',
    description:
      'State of one durable job: queued, starting, running, succeeded, failed, cancelled, timed_out, interrupted or ' +
      'outcome_unknown, with timestamps, elapsed time, exit code/signal, stored/dropped log bytes, self-reported progress ' +
      '(or null) and the reason for failures. Also reports whether the job worker is running. Read-only.',
    inputSchema: statusShape,
    annotations: { title: 'Job Status', readOnlyHint: true },
    handler: (raw) => {
      const { jobId } = parseArgs(statusShape, raw);
      const rec = jobs.get(jobId);
      const worker = jobs.store.workerHealth().state;
      const note = workerNote(worker, !TERMINAL_STATES.has(rec.state));
      return json({ ...jobView(rec, worker), ...(note ? { workerNote: note } : {}) });
    },
  });

  const jobList = defineTool({
    name: 'job_list',
    description:
      'List durable jobs, newest first (optionally only one state). Unreadable records are listed as "unreadable". Read-only.',
    inputSchema: listShape,
    annotations: { title: 'List Jobs', readOnlyHint: true },
    handler: (raw) => {
      const { state, limit } = parseArgs(listShape, raw);
      const { jobs: list, total } = jobs.list(state, limit);
      const unfinished = list.some((j) => j.state !== 'unreadable' && !TERMINAL_STATES.has(j.state as JobState));
      const worker = jobs.store.workerHealth().state;
      const note = workerNote(worker, unfinished);
      return json({
        total,
        shown: list.length,
        worker,
        ...(note ? { workerNote: note } : {}),
        jobs: list.map((j) =>
          j.state === 'unreadable'
            ? j
            : {
                jobId: j.id,
                state: j.state,
                ...('label' in j && j.label ? { label: j.label } : {}),
                command: 'command' in j ? j.command.slice(0, 120) : undefined,
                createdAt: 'createdAt' in j ? j.createdAt : undefined,
                exitCode: 'exitCode' in j ? j.exitCode ?? null : null,
              },
        ),
      });
    },
  });

  const jobLogs = defineTool({
    name: 'job_logs',
    description:
      'Read a durable job\'s captured stdout or stderr by byte offset (decoded as UTF-8). Returns a JSON header (offset, ' +
      'nextOffset, size, droppedAfterLimit, endOfLog) followed by the text. Each stream keeps at most jobs.maxLogBytes ' +
      '(default 4 MiB); later output is counted in droppedAfterLimit but not stored.',
    inputSchema: logsShape,
    annotations: { title: 'Job Logs', readOnlyHint: true },
    handler: (raw): ToolResult => {
      const a = parseArgs(logsShape, raw);
      const { text, ...meta } = jobs.logs(a.jobId, a.stream, a.offset, a.length);
      return { content: [{ type: 'text', text: json(meta) }, { type: 'text', text: text || '(no output in this range)' }] };
    },
  });

  const jobCancel = defineTool({
    name: 'job_cancel',
    description:
      'Cancel a durable job. Queued: cancelled immediately, never started. Running: a durable cancel request makes the ' +
      'worker stop the job\'s process group (SIGTERM, SIGKILL after 3s); waits up to wait_ms for it. Finished jobs are left ' +
      'as they are, except an interrupted job whose original process is verifiably still running (same PID and start time), ' +
      'which is sent SIGTERM.',
    inputSchema: cancelShape,
    annotations: { title: 'Cancel Job', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (raw) => {
      const { jobId, wait_ms } = parseArgs(cancelShape, raw);
      const { rec, action } = await jobs.cancel(jobId, wait_ms);
      return json({ action, ...jobView(rec) });
    },
  });

  return [jobStart, jobStatus, jobList, jobLogs, jobCancel] as unknown as ToolDef[];
}
