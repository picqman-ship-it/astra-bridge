import { isUrlLike } from '../files/read.js';
import { errorResult, type ToolDef } from '../types.js';
import { VERSION } from '../version.js';
import type { RemoteConfig } from './config.js';
import { IDEMPOTENT_TOOLS, withIdempotency, type IdempotencyStore } from './idempotency.js';
import type { JobService } from './job-service.js';
import { jobTools } from './job-tools.js';
import { RootGuard } from './root-guard.js';

/**
 * Which tools a remote client gets, and the remote-only restrictions on them.
 *
 * File and search tools are confined to the configured roots (the same symlink-resolving checks the
 * local server uses). Shell and process tools exist only in trusted-terminal mode, because a shell
 * or interpreter can reach anything this user can: the roots do not sandbox it.
 */

export const FILE_TOOLS = [
  'read_file', 'read_multiple_files', 'write_file', 'create_directory', 'list_directory', 'move_file',
  'get_file_info', 'edit_block',
];
export const SEARCH_TOOLS = ['start_search', 'get_more_search_results', 'stop_search', 'list_searches'];
export const INFO_TOOLS = ['get_config', 'get_recent_tool_calls', 'get_usage_stats'];
/** Arbitrary code execution / signalling other processes: trusted-terminal mode only. */
export const TERMINAL_TOOLS = [
  'start_process', 'read_process_output', 'interact_with_process', 'force_terminate', 'list_sessions',
  'list_processes', 'kill_process',
];
/** Durable background jobs (remote only; they run in the detached job worker): trusted-terminal mode only. */
export const JOB_TOOLS = ['job_start', 'job_status', 'job_list', 'job_logs', 'job_cancel'];
/**
 * macOS GUI (Accessibility) tools: trustedGui mode only. They see and operate every app window of
 * this user, not just the roots; a pressed button can do anything the app can.
 */
export const GUI_TOOLS = ['list_windows', 'inspect_ui', 'press_element', 'set_element_value'];
/** Never exposed remotely: it edits the security settings. */
export const NEVER_REMOTE = ['set_config_value'];

/** 15 tools by default; +12 with trusted-terminal mode (7 terminal/process + 5 job tools); +4 with trustedGui. */
export function remoteToolNames(trustedTerminal: boolean, trustedGui = false): string[] {
  return [
    ...FILE_TOOLS, ...SEARCH_TOOLS, ...INFO_TOOLS,
    ...(trustedTerminal ? [...TERMINAL_TOOLS, ...JOB_TOOLS] : []),
    ...(trustedGui ? GUI_TOOLS : []),
  ];
}

/** Remote-only services the policy wires into the tool list. */
export interface RemoteServices {
  idempotency: IdempotencyStore;
  jobs: JobService | null;
  /**
   * The runtime's one root snapshot, shared by every session. Required: a guard created per
   * session would snapshot (and so authorize) a root that was replaced after the service started.
   */
  roots: RootGuard;
}

function remoteGetConfig(base: ToolDef, cfg: RemoteConfig, exposed: string[]): ToolDef {
  return {
    ...base,
    description:
      'Get the remote server settings (read-only): the directories the file and search tools may use, whether ' +
      'trusted-terminal mode is on, limits, and the exposed tools. Settings can only be changed by the owner on the Mac.',
    handler: () => {
      const payload = {
        mode: 'remote',
        version: VERSION,
        roots: cfg.roots,
        trustedTerminal: cfg.trustedTerminal,
        trustedGui: cfg.trustedGui,
        ...(cfg.trustedTerminal ? { defaultShell: cfg.defaultShell, blockedCommands: cfg.blockedCommands, jobs: cfg.jobs } : {}),
        idempotency: { ...cfg.idempotency, tools: IDEMPOTENT_TOOLS.filter((t) => exposed.includes(t)) },
        fileReadLineLimit: cfg.fileReadLineLimit,
        fileWriteLineLimit: cfg.fileWriteLineLimit,
        limits: cfg.limits,
        tools: exposed,
        note:
          (cfg.trustedTerminal
            ? 'Terminal tools run commands as the Mac user; the roots restrict file/search tools only, not shells or interpreters.'
            : 'Terminal and process tools are disabled (trusted-terminal mode is off).') +
          (cfg.trustedGui
            ? ' GUI tools read and operate any app window of the Mac user (not limited to the roots).'
            : ' GUI tools are disabled (trustedGui is off).'),
      };
      return `Remote configuration:\n${JSON.stringify(payload, null, 2)}`;
    },
  };
}

function noUrlReadFile(base: ToolDef): ToolDef {
  return {
    ...base,
    description: base.description.replace(/ With isUrl=true[^.]*\./, '') + ' Remote mode: URLs are not fetched; local files only.',
    annotations: { ...base.annotations, openWorldHint: false },
    handler: (args) => {
      const a = args as { path?: unknown; isUrl?: unknown };
      if (a.isUrl === true || (typeof a.path === 'string' && isUrlLike(a.path))) {
        return errorResult('URL fetching is disabled in remote mode; read_file only reads files inside the configured roots.');
      }
      return base.handler(args);
    },
  };
}

function startProcessInRoot(base: ToolDef, cfg: RemoteConfig): ToolDef {
  return {
    ...base,
    description: `${base.description} Remote mode: cwd defaults to ${cfg.roots[0]} and must be inside a configured root.`,
    handler: (args) => {
      const a = args as { cwd?: unknown };
      const cwd = typeof a.cwd === 'string' && a.cwd.trim() ? a.cwd : cfg.roots[0];
      return base.handler({ ...(args as object), cwd } as never);
    },
  };
}

/**
 * Returns the remote tool list for `cfg`: the shared tools in their original order (mutating ones
 * with the optional idempotencyKey), then the job tools in trusted-terminal mode.
 */
export function selectRemoteTools(cfg: RemoteConfig, services: RemoteServices) {
  const exposed = remoteToolNames(cfg.trustedTerminal, cfg.trustedGui);
  const roots = services.roots;
  if (!(roots instanceof RootGuard)) throw new Error('selectRemoteTools needs the runtime RootGuard (services.roots).');
  return (tools: ToolDef[]): ToolDef[] => {
    const selected = tools
      .filter((t) => exposed.includes(t.name) && !NEVER_REMOTE.includes(t.name))
      .map((t) => {
        if (t.name === 'get_config') return remoteGetConfig(t, cfg, exposed);
        if (t.name === 'read_file') return noUrlReadFile(t);
        if (t.name === 'start_process') return startProcessInRoot(t, cfg);
        return t;
      })
      .map((t) => (IDEMPOTENT_TOOLS.includes(t.name) ? withIdempotency(t, services.idempotency) : t));
    if (cfg.trustedTerminal && services.jobs) selected.push(...jobTools(services.jobs).filter((t) => exposed.includes(t.name)));
    return selected.map((tool) => ({
      ...tool,
      handler: async (args) => {
        roots.assertStable();
        if (tool.name === 'move_file') {
          const move = args as { source: string; destination: string };
          await roots.assertMove(move.source, move.destination);
        }
        return tool.handler(args);
      },
    }));
  };
}

export function remoteInstructions(cfg: RemoteConfig): string {
  return (
    'mcp-commander (remote mode) on the owner\'s Mac. File and search tools work only inside these directories: ' +
    `${cfg.roots.join(', ')}. Use absolute paths. Write large files in chunks (write_file mode "append"). ` +
    (cfg.trustedTerminal
      ? 'Terminal tools are enabled: processes you start keep running across requests and reconnects until you ' +
        'force_terminate them or the service stops. For long work that must survive disconnects and server restarts use ' +
        'job_start (durable job, required idempotencyKey) and poll job_status/job_logs. '
      : 'Terminal, process and job tools are disabled on this server. ') +
    (cfg.trustedGui
      ? 'macOS GUI tools are enabled: list_windows / inspect_ui find controls semantically; press_element / ' +
        'set_element_value act on exactly one element (by ref from inspect_ui) and never click coordinates. '
      : '') +
    'Mutating tools accept an optional idempotencyKey (a fresh UUID per action) so a retried call is not executed twice; ' +
    'without a key there is no duplicate protection.'
  );
}
