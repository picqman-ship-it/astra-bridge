// Checked-in tool descriptors for the review/demo agent. These mirror the names and
// input schemas that mcp-commander (remote, trusted-terminal mode) advertises for the
// 31 reviewed tools, transcribed by hand so the demo never contacts a real Mac or
// Commander at runtime. Descriptions are shortened and state the demo behavior.

export const DEMO_ROOT = "/demo-workspace";
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 200;
export const DEMO_COMMAND_HELP = "pwd, node --version, echo <text>, sleep <0-30 seconds>";

// Same set as IDEMPOTENCY_REQUIRED in tool-policy.ts; a test asserts they match.
export const DEMO_IDEMPOTENT_TOOLS = [
  "create_directory", "write_file", "edit_block", "move_file", "start_process",
  "interact_with_process", "force_terminate", "kill_process", "press_element", "set_element_value", "job_start",
];

export const JOB_STATES = [
  "queued", "starting", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted", "outcome_unknown",
];

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const bool = (description, def) => ({ type: "boolean", default: def, description });

const idempotencyKey = str(
  "Required. A unique id for this intended action (a fresh UUID, 8-200 characters). Retrying with the same key and "
    + "the same arguments returns the recorded result without acting again; the same key with different arguments is refused.",
  { minLength: IDEMPOTENCY_KEY_MIN, maxLength: IDEMPOTENCY_KEY_MAX },
);

function schema(properties = {}, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function tool(name, title, description, inputSchema, hints) {
  return {
    name,
    description: `${description} [Review demo: operates only on the isolated ${DEMO_ROOT} sandbox.]`,
    inputSchema,
    annotations: { title, ...hints },
  };
}

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const MUT = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const pid = int("PID of the session, as returned by start_process (demo PIDs are simulated).");
const jobId = str("Job id returned by job_start (e.g. j0mg1abcd-0123456789abcdef).");
const sessionId = str('Session id returned by start_search (e.g. "search_1_1758800000000").');

export const DEMO_TOOLS = Object.freeze([
  tool("get_config", "Get Configuration",
    "Get the remote server settings (read-only): allowed directories, limits, the demo command grammar and the exposed tools.",
    schema(), RO),
  tool("read_file", "Read File",
    "Read a text file. Text comes back with a '[Reading N lines ...]' header. offset is a 0-based line index; length is the "
      + "max number of lines (default 1000). A negative offset returns the last |offset| lines. URL fetching is disabled "
      + "in the demo (isUrl=true or an http(s):// path is refused). Use absolute paths.",
    schema({
      path: str("Absolute path of the file."),
      offset: int("0-based line to start from. Negative = read the last |offset| lines.", { default: 0 }),
      length: int("Maximum number of lines to return (default: fileReadLineLimit config).", { minimum: 1 }),
      isUrl: bool("Treat path as a URL to fetch. Always refused in the review demo.", false),
    }, ["path"]),
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool("read_multiple_files", "Read Multiple Files",
    "Read up to 50 files at once. The first text block is a summary with one line per path; each readable file then "
      + "follows as '--- <path> contents: ---' plus what read_file returns. A failing file never fails the whole call.",
    schema({
      paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "Absolute file paths to read (1-50)." },
    }, ["paths"]), RO),
  tool("write_file", "Write File",
    "Write UTF-8 text to a file, creating missing parent directories. mode 'rewrite' replaces the file; 'append' adds to "
      + "its end. If mode is omitted and the file already has content, the write is rejected.",
    schema({
      path: str("Absolute path of the file to write."),
      content: str("Text to write."),
      mode: { type: "string", enum: ["rewrite", "append"], description: "'rewrite' replaces the file, 'append' adds to its end. Required when the file already has content." },
      idempotencyKey,
    }, ["path", "content", "idempotencyKey"]), MUT),
  tool("create_directory", "Create Directory",
    "Create a directory, including missing parents (like mkdir -p). Succeeds without changes if it already exists.",
    schema({ path: str("Absolute path of the directory to create."), idempotencyKey }, ["path", "idempotencyKey"]),
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false }),
  tool("list_directory", "List Directory",
    "List a directory recursively as '[DIR] rel/path', '[FILE] rel/path' or '[LINK] rel/path' lines (symlinks are never "
      + "followed). depth 1 lists direct children only (default 2, max 10).",
    schema({
      path: str("Absolute path of the directory to list."),
      depth: int("How many levels to descend: 1 = direct children only (1-10, clamped).", { default: 2 }),
    }, ["path"]), RO),
  tool("move_file", "Move/Rename File",
    "Move or rename a file or directory. Never overwrites: fails if the destination exists. Creates missing parent "
      + "directories of the destination. Both paths must be inside the allowed directory.",
    schema({
      source: str("Absolute path of the file/directory to move."),
      destination: str("Absolute path of the new location (must not exist yet)."),
      idempotencyKey,
    }, ["source", "destination", "idempotencyKey"]), MUT),
  tool("get_file_info", "Get File Info",
    "Get metadata for a file, directory or symlink as 'key: value' lines: path, size, times, type flags, permissions, "
      + "fileType and, for text files, lineCount/lastLine/appendPosition.",
    schema({ path: str("Absolute path of the file, directory or symlink.") }, ["path"]), RO),
  tool("start_search", "Start Search",
    "Search for files by name (searchType 'files') or for text inside files (searchType 'content'). Returns the status, "
      + "the first 50 results and a sessionId; page with get_more_search_results, cancel with stop_search.",
    schema({
      path: str("Directory (or single file) to search. Absolute path recommended."),
      pattern: str("files: name substring or glob (e.g. 'auth', '*.md'); content: regex, or exact text with literalSearch"),
      searchType: { type: "string", enum: ["files", "content"], default: "files", description: "'files' = match file/directory names (default), 'content' = search inside files" },
      filePattern: str("Only consider files whose name matches one of these '|'-separated globs, e.g. '*.ts|*.js'"),
      ignoreCase: bool("Case-insensitive matching of pattern (default true)", true),
      maxResults: int("Maximum total results (default 5000; values above 50000 are capped)", { minimum: 1 }),
      includeHidden: bool("Include hidden files and directories (dot-names; default false)", false),
      contextLines: int("content only: lines of context before and after each match (default 0, max 10)", { minimum: 0, default: 0 }),
      timeout_ms: int("Stop the search after this many milliseconds (optional)"),
      literalSearch: bool("content only: treat pattern as exact text, not a regex (default false)", false),
      earlyTermination: bool("files only: stop at the first file whose name equals the pattern exactly (default false)", false),
    }, ["path", "pattern"]), RO),
  tool("get_more_search_results", "Get Search Results",
    "Read results of a search started with start_search. offset/length select a range (0-based; default 0 and 100); "
      + "a negative offset returns the last |offset| results.",
    schema({
      sessionId,
      offset: int("First result to return (0-based, default 0); negative = the last |offset| results", { default: 0 }),
      length: int("Maximum number of results to return (default 100)", { minimum: 1, default: 100 }),
    }, ["sessionId"]), RO),
  tool("stop_search", "Stop Search",
    "Stop a running search started with start_search. Results found so far stay readable.",
    schema({ sessionId }, ["sessionId"]),
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false }),
  tool("list_searches", "List Searches",
    "List search sessions (running and recently finished) with type, pattern, status, runtime and result count.",
    schema(), RO),
  tool("edit_block", "Edit Text Block",
    "Replace exact text in a file: old_string must match exactly. By default exactly one occurrence must exist; set "
      + "expected_replacements to replace that many. If the count differs nothing is changed and the matching line numbers "
      + "are reported. Returns a preview of the edited lines.",
    schema({
      file_path: str("Absolute path of the text file to edit."),
      old_string: str("Exact text to find (must be non-empty)."),
      new_string: str("Replacement text (may be empty to delete old_string)."),
      expected_replacements: int("Exact number of occurrences to replace (default 1).", { minimum: 1, default: 1 }),
      idempotencyKey,
    }, ["file_path", "old_string", "new_string", "idempotencyKey"]), MUT),
  tool("list_windows", "List macOS Windows",
    "Describe a simulated semantic macOS window list. The review demo never reads the host Mac UI.",
    schema({
      app: str("Optional app name, bundle id or pid filter"),
      includeMinimized: bool("Include minimized windows", true),
      limit: int("Max windows", { minimum: 1, maximum: 500, default: 100 }),
      timeoutMs: int("Overall time limit in ms", { minimum: 1000, maximum: 60000, default: 15000 }),
    }), RO),
  tool("inspect_ui", "Inspect macOS UI",
    "Describe a simulated bounded Accessibility tree and stable element refs. The review demo never reads the host Mac UI.",
    schema({
      app: str("App name, bundle id or pid"),
      windowId: int("Stable window id", { minimum: 1 }),
      windowTitle: str("Window title"),
      windowIndex: int("Front-to-back window index", { minimum: 0, maximum: 1000 }),
      ref: str("Element ref from inspect_ui"),
      path: str("Semantic element path"),
      role: str("AX role or subrole"),
      name: str("Element title, description or placeholder"),
      identifier: str("AXIdentifier"),
      maxDepth: int("Max tree depth", { minimum: 0, maximum: 40, default: 10 }),
      maxElements: int("Max elements", { minimum: 1, maximum: 2000, default: 300 }),
      includeValues: bool("Include safe values", true),
      timeoutMs: int("Overall time limit in ms", { minimum: 1000, maximum: 60000, default: 15000 }),
    }), RO),
  tool("press_element", "Press macOS UI Element",
    "Simulate a semantic AXPress request. The review demo never controls the host Mac UI.",
    schema({
      ref: str("Element ref from inspect_ui"), app: str("App name, bundle id or pid"),
      windowId: int("Stable window id", { minimum: 1 }), windowTitle: str("Window title"),
      windowIndex: int("Window index", { minimum: 0, maximum: 1000 }), role: str("AX role or subrole"),
      name: str("Element name"), identifier: str("AXIdentifier"), path: str("Semantic element path"),
      timeoutMs: int("Overall time limit in ms", { minimum: 1000, maximum: 60000, default: 15000 }), idempotencyKey,
    }, ["idempotencyKey"]), MUT),
  tool("set_element_value", "Set macOS UI Element Value",
    "Simulate a semantic AXValue request. The review demo never controls the host Mac UI.",
    schema({
      ref: str("Element ref from inspect_ui"), app: str("App name, bundle id or pid"),
      windowId: int("Stable window id", { minimum: 1 }), windowTitle: str("Window title"),
      windowIndex: int("Window index", { minimum: 0, maximum: 1000 }), role: str("AX role or subrole"),
      name: str("Element name"), identifier: str("AXIdentifier"), path: str("Semantic element path"),
      timeoutMs: int("Overall time limit in ms", { minimum: 1000, maximum: 60000, default: 15000 }),
      value: str("New text value"), idempotencyKey,
    }, ["value", "idempotencyKey"]), MUT),
  tool("start_process", "Start Terminal Process",
    `Start a command in a new session. The review demo simulates a tiny command grammar only (${DEMO_COMMAND_HELP}); `
      + "nothing is executed on a real shell and anything else is refused.",
    schema({
      command: str("Command line to run. Demo grammar only: pwd, node --version, echo <text>, sleep <seconds>."),
      timeout_ms: int("Max ms to wait for the process to exit before returning (default 10000, max 600000).", { minimum: 0, maximum: 600000, default: 10000 }),
      shell: str("Shell to run the command with. Ignored by the demo simulator."),
      cwd: str("Working directory inside the allowed directory (default: the demo workspace)."),
      idempotencyKey,
    }, ["command", "idempotencyKey"]),
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
  tool("read_process_output", "Read Process Output",
    "Read output from a session started by start_process. offset=0 returns unread output (waiting up to timeout_ms); "
      + "offset>0 reads from that line; offset<0 reads the last |offset| lines.",
    schema({
      pid,
      timeout_ms: int("offset=0 only: max ms to wait for new output (default 5000, max 60000)", { minimum: 0, maximum: 60000, default: 5000 }),
      offset: int("0 = unread output; >0 = from this 0-based line; <0 = the last |offset| lines.", { default: 0 }),
      length: int("Max lines to return (default 1000)", { minimum: 1 }),
    }, ["pid"]), RO),
  tool("interact_with_process", "Send Input to Process",
    "Send input to a running session's stdin and return its response. Demo sessions do not read stdin, so input is "
      + "recorded but produces no output.",
    schema({
      pid,
      input: str("Text to send to stdin; a newline is appended if missing."),
      timeout_ms: int("Max ms to wait for the response (default 8000, max 600000).", { minimum: 0, maximum: 600000, default: 8000 }),
      wait_for_prompt: bool("true (default): wait for the next prompt/exit; false: send and return immediately.", true),
      idempotencyKey,
    }, ["pid", "input", "idempotencyKey"]),
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
  tool("force_terminate", "Force Terminate Process",
    "Stop a running session started by start_process. Its output stays readable with read_process_output.",
    schema({ pid, idempotencyKey }, ["pid", "idempotencyKey"]), MUT),
  tool("list_sessions", "List Terminal Sessions",
    "List sessions started with start_process: active ones and the 10 most recently completed.",
    schema(), RO),
  tool("list_processes", "List Running Processes",
    "List processes. The review demo lists only its own simulated sessions, never real operating-system processes.",
    schema({
      filter: str("Only processes whose command line contains this text (case-insensitive)"),
      limit: int("Max processes to list (default 100, max 2000)", { minimum: 1, maximum: 2000, default: 100 }),
    }), RO),
  tool("kill_process", "Kill Process",
    "Send a signal to a process by PID. The review demo can only signal its own simulated sessions.",
    schema({
      pid: int("Process ID to signal"),
      signal: { type: "string", enum: ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"], default: "SIGTERM", description: "Signal to send (default SIGTERM)" },
      idempotencyKey,
    }, ["pid", "idempotencyKey"]), MUT),
  tool("get_recent_tool_calls", "Get Recent Tool Calls",
    "Get recent tool calls made to this demo agent (oldest first): arguments (long strings truncated), error flag and duration.",
    schema({
      maxResults: int("Default 50", { minimum: 1, maximum: 1000 }),
      toolName: str("Only calls to this tool"),
      since: str("ISO 8601 timestamp; only calls at or after it"),
    }), RO),
  tool("get_usage_stats", "Get Usage Statistics",
    "Usage statistics for this demo agent session: total/successful/failed calls and the most used tools.",
    schema(), RO),
  tool("job_start", "Start Durable Job",
    `Start a command as a durable background job and return its job id. Demo grammar only (${DEMO_COMMAND_HELP}). `
      + "Follow it with job_status / job_logs, stop it with job_cancel. Retrying with the same idempotencyKey and request "
      + "returns the same job.",
    schema({
      command: str("Command line to run as a background job. Demo grammar only."),
      idempotencyKey,
      cwd: str("Working directory inside the allowed directory (default: the demo workspace)."),
      shell: str("Shell to run the command with. Ignored by the demo simulator."),
      timeoutSeconds: int("Stop the job after this many seconds (default 3600).", { minimum: 1, maximum: 604800 }),
      label: str("Short free-text label shown in job_list.", { maxLength: 200 }),
    }, ["command", "idempotencyKey"]),
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
  tool("job_status", "Job Status",
    "State of one durable job with timestamps, elapsed time, exit code, stored log bytes and failure reason. Read-only.",
    schema({ jobId }, ["jobId"]), RO),
  tool("job_list", "List Jobs",
    "List durable jobs, newest first (optionally only one state). Read-only.",
    schema({
      state: { type: "string", enum: JOB_STATES, description: "Only jobs in this state." },
      limit: int("Max jobs to return, newest first (default 20).", { minimum: 1, maximum: 200, default: 20 }),
    }), RO),
  tool("job_logs", "Job Logs",
    "Read a durable job's captured stdout or stderr by byte offset. Returns a JSON header (offset, nextOffset, size, "
      + "endOfLog) followed by the text.",
    schema({
      jobId,
      stream: { type: "string", enum: ["stdout", "stderr"], default: "stdout", description: "Which log (default stdout)." },
      offset: int("Byte offset to start at; negative = the last |offset| bytes.", { default: 0 }),
      length: int("Max bytes to return (default 16384, max 65536).", { minimum: 1, maximum: 65536 }),
    }, ["jobId"]), RO),
  tool("job_cancel", "Cancel Job",
    "Cancel a durable job. Queued: cancelled immediately. Running: stopped. Finished jobs are left as they are.",
    schema({
      jobId,
      wait_ms: int("How long to wait for the job to stop (default 5000).", { minimum: 0, maximum: 30000, default: 5000 }),
    }, ["jobId"]), MUT),
]);

export const DEMO_TOOL_NAMES = Object.freeze(DEMO_TOOLS.map((t) => t.name));

export function demoToolByName(name) {
  return DEMO_TOOLS.find((t) => t.name === name) ?? null;
}
