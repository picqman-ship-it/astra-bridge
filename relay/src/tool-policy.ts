export type ToolSafety = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

// Reviewed allowlist of downstream mcp-commander tools. Anything not listed here is
// neither listed nor callable through the relay, including tools added downstream later.
export const TOOL_SAFETY: Record<string, ToolSafety> = {
  get_config: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  read_file: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  read_multiple_files: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  write_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  create_directory: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  list_directory: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  move_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  get_file_info: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  start_search: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_more_search_results: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  stop_search: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  list_searches: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  edit_block: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  list_windows: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inspect_ui: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  press_element: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  set_element_value: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  start_process: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  read_process_output: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  interact_with_process: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  force_terminate: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  list_sessions: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_processes: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  kill_process: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  get_recent_tool_calls: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_usage_stats: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  job_start: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  job_status: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  job_list: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  job_logs: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  job_cancel: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

export const APPROVED_TOOL_NAMES = new Set(Object.keys(TOOL_SAFETY));

export const SCOPE_READ = "astra.read";
export const SCOPE_WRITE = "astra.write";
export const SCOPE_CONTROL = "astra.control";
export const OAUTH_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_CONTROL] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

// The single scope each reviewed tool requires. Scopes are not hierarchical.
// astra.control covers the whole process/job family (even its read-only members,
// since output and job metadata disclose or steer durable commands) and the
// recent-call log, which can replay command text and arguments.
export const TOOL_SCOPE: Record<string, OAuthScope> = {
  get_config: SCOPE_READ,
  read_file: SCOPE_READ,
  read_multiple_files: SCOPE_READ,
  list_directory: SCOPE_READ,
  get_file_info: SCOPE_READ,
  start_search: SCOPE_READ,
  get_more_search_results: SCOPE_READ,
  list_searches: SCOPE_READ,
  get_usage_stats: SCOPE_READ,
  write_file: SCOPE_WRITE,
  create_directory: SCOPE_WRITE,
  move_file: SCOPE_WRITE,
  edit_block: SCOPE_WRITE,
  stop_search: SCOPE_WRITE,
  list_windows: SCOPE_CONTROL,
  inspect_ui: SCOPE_CONTROL,
  press_element: SCOPE_CONTROL,
  set_element_value: SCOPE_CONTROL,
  start_process: SCOPE_CONTROL,
  read_process_output: SCOPE_CONTROL,
  interact_with_process: SCOPE_CONTROL,
  force_terminate: SCOPE_CONTROL,
  list_sessions: SCOPE_CONTROL,
  list_processes: SCOPE_CONTROL,
  kill_process: SCOPE_CONTROL,
  get_recent_tool_calls: SCOPE_CONTROL,
  job_start: SCOPE_CONTROL,
  job_status: SCOPE_CONTROL,
  job_list: SCOPE_CONTROL,
  job_logs: SCOPE_CONTROL,
  job_cancel: SCOPE_CONTROL,
};

export function isOAuthScope(value: unknown): value is OAuthScope {
  return typeof value === "string" && (OAUTH_SCOPES as readonly string[]).includes(value);
}

/** Unknown tools have no scope and therefore are never permitted. */
export function requiredScope(name: string): OAuthScope | null {
  return Object.hasOwn(TOOL_SCOPE, name) ? TOOL_SCOPE[name] : null;
}

// Configuration/security mutation is never exposed remotely, even if a downstream
// build starts advertising it. Tests assert this set is disjoint from the allowlist.
export const EXCLUDED_TOOL_NAMES = new Set(["set_config_value"]);

// Mutating tools whose mcp-commander schema accepts idempotencyKey. The relay refuses
// these calls without a key so a retry after a lost result cannot repeat the effect.
// job_cancel and stop_search are deliberately absent: they take no idempotencyKey.
export const IDEMPOTENCY_REQUIRED = new Set([
  "create_directory",
  "write_file",
  "edit_block",
  "move_file",
  "start_process",
  "interact_with_process",
  "force_terminate",
  "kill_process",
  "press_element",
  "set_element_value",
  "job_start",
]);

export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 200;

const IDEMPOTENCY_NOTE = " Requires idempotencyKey: a unique string (8-200 chars) per intended action."
  + " If the outcome is unknown, retry only with the same key.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isToolApproved(name: unknown): name is string {
  return typeof name === "string" && APPROVED_TOOL_NAMES.has(name) && !EXCLUDED_TOOL_NAMES.has(name);
}

export function hasValidIdempotencyKey(args: unknown): boolean {
  const key = isRecord(args) ? args.idempotencyKey : undefined;
  return typeof key === "string"
    && key.length >= IDEMPOTENCY_KEY_MIN
    && key.length <= IDEMPOTENCY_KEY_MAX;
}

/**
 * Returns the tool as exposed over public MCP, or null when it must stay hidden:
 * not reviewed, explicitly excluded, or a gated mutating tool whose downstream schema
 * no longer declares idempotencyKey (the relay would then reject every call, and
 * injecting a key the downstream ignores would give false retry safety).
 */
export function exposeApprovedTool(tool: Record<string, unknown>): Record<string, unknown> | null {
  const name = tool.name;
  if (!isToolApproved(name)) return null;

  const annotations = isRecord(tool.annotations) ? tool.annotations : {};
  const meta = isRecord(tool._meta) ? tool._meta : {};
  // OpenAI reads securitySchemes on the tool; _meta mirrors it for clients that
  // only pass _meta through. Downstream values never override the reviewed scope.
  const securitySchemes = [{ type: "oauth2", scopes: [TOOL_SCOPE[name]] }];
  const exposed: Record<string, unknown> = {
    ...tool,
    annotations: { ...annotations, ...TOOL_SAFETY[name] },
    securitySchemes,
    _meta: { ...meta, securitySchemes },
  };
  if (!IDEMPOTENCY_REQUIRED.has(name)) return exposed;

  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : null;
  const properties = schema && isRecord(schema.properties) ? schema.properties : null;
  if (!schema || !properties || !("idempotencyKey" in properties)) return null;

  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  exposed.inputSchema = {
    ...schema,
    required: required.includes("idempotencyKey") ? required : [...required, "idempotencyKey"],
  };
  exposed.description = `${typeof tool.description === "string" ? tool.description : ""}${IDEMPOTENCY_NOTE}`.trim();
  return exposed;
}
