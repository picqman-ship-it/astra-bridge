import fs from 'node:fs';
import { z } from 'zod';
import { GuiError, nativeRunner, unsupportedPlatform, type HelperCommand, type HelperResponse, type HelperRunner } from '../gui/helper.js';
import {
  canPress, canSetText, decodeRef, defaultWindow, describeApp, describeWindow, encodeRef, formatNode, hasElementCriteria,
  hasWindowSelector, isProtectedApp, isValidPath, matchApps, matchWindows, nodeMatches, sortPreorder, windowKeyOf,
  type AppInfo, type ElementCriteria, type UiNode, type WindowInfo, type WindowKey,
} from '../gui/select.js';
import { defineTool, errorResult, textResult, type ToolContext, type ToolDef, type ToolResult } from '../types.js';
import { boolish, parseArgs } from './terminal.js';

/**
 * Semantic macOS GUI tools: list windows, inspect the Accessibility tree, press an element
 * (AXPress), set a text value (AXValue). Everything is addressed by app / window / role / name /
 * identifier / path — never by screen coordinates, and nothing falls back to clicking.
 *
 * A selector that matches nothing reports so; one that matches several returns the candidates and
 * does nothing. Before acting, the helper re-resolves the element and compares its fingerprint, so
 * a ref whose UI changed in the meantime is refused instead of hitting a different element.
 */

export const GUI_TOOLS = ['list_windows', 'inspect_ui', 'press_element', 'set_element_value'];

export interface GuiToolOptions {
  /** Replaces the native helper (tests). */
  runner?: HelperRunner;
  /** Defaults to process.platform. */
  platform?: string;
  /** Wait after an action before reading the result back (ms). */
  settleMs?: number;
}

/** Scan bounds when press/set find their target by role/name/identifier. */
const SELECT_MAX_DEPTH = 25;
const SELECT_MAX_ELEMENTS = 1500;
const MAX_CANDIDATES = 15;

const timeoutField = z.coerce
  .number()
  .int()
  .min(1000)
  .max(60_000)
  .default(15_000)
  .describe('Overall time limit in ms (default 15000, max 60000). Accessibility calls to a hung app are cut off.');

const appField = z.string().max(300).optional();

const windowShape = {
  windowId: z.coerce.number().int().positive().optional().describe('windowId from list_windows (the most reliable window selector).'),
  windowTitle: z.string().max(500).optional().describe('Window title: exact (case-insensitive), otherwise a unique substring.'),
  windowIndex: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe('index from list_windows (front-to-back order, so it changes when focus moves; prefer windowId).'),
};

const criteriaShape = {
  role: z.string().max(100).optional().describe('AX role or subrole, e.g. "AXButton" (or just "button"), "AXTextField", "AXCloseButton".'),
  name: z.string().max(500).optional().describe("The element's title, description or placeholder: whole text, case-insensitive."),
  identifier: z.string().max(500).optional().describe('AXIdentifier, exact.'),
  path: z.string().max(8192).optional().describe('Element path from inspect_ui (relative to the window), e.g. "AXScrollArea[0]/AXTextArea[0]".'),
};

const refField = z
  .string()
  .max(9000)
  .optional()
  .describe('An element ref from inspect_ui (ax1:…). Addresses app, window and element at once; use it instead of the selectors.');

const listShape = {
  app: appField.describe('Only this app: its name, bundle id or pid. Default: all regular apps.'),
  includeMinimized: boolish(true).describe('Include minimized windows (default true).'),
  limit: z.coerce.number().int().min(1).max(500).default(100).describe('Max windows (default 100, max 500).'),
  timeoutMs: timeoutField,
};

const inspectShape = {
  app: appField.describe('App name, bundle id or pid. Default: the frontmost app. Not with ref.'),
  ...windowShape,
  ref: refField.describe('Inspect the subtree under this element ref (from an earlier inspect_ui) instead of a whole window.'),
  path: criteriaShape.path.describe('Inspect only the subtree at this path (relative to the window).'),
  role: criteriaShape.role.describe('Only list elements with this role/subrole (the scan itself is unchanged).'),
  name: criteriaShape.name.describe('Only list elements whose title, description or placeholder equals this (case-insensitive).'),
  identifier: criteriaShape.identifier.describe('Only list elements with this AXIdentifier.'),
  maxDepth: z.coerce.number().int().min(0).max(40).default(10).describe('Levels below the root to scan (default 10, max 40).'),
  maxElements: z.coerce.number().int().min(1).max(2000).default(300).describe('Max elements scanned (default 300, max 2000).'),
  includeValues: boolish(true).describe('Show element values (text is cut at 200 chars; secure/password fields are never read).'),
  timeoutMs: timeoutField,
};

const targetShape = {
  ref: refField,
  app: appField.describe('App name, bundle id or pid (with the selectors below; not with ref).'),
  ...windowShape,
  ...criteriaShape,
  timeoutMs: timeoutField,
};

const pressShape = { ...targetShape };
const setShape = {
  ...targetShape,
  value: z.string().max(100_000).describe('The new text value (replaces the whole current value).'),
};

type TargetArgs = z.infer<z.ZodObject<typeof targetShape>>;

interface Target {
  app: AppInfo;
  window: WindowInfo;
  key: WindowKey;
  node: UiNode;
  ref: string;
}

const HINTS: Record<string, string> = {
  not_trusted:
    ' Grant it in System Settings > Privacy & Security > Accessibility to the app that started this server (for a local ' +
    'run e.g. Terminal, iTerm or Claude; for the remote LaunchAgent service the Node binary ' +
    `${safeRealpath(process.execPath)}), then retry (restart the server if it still fails). This server never bypasses that permission.`,
  stale_ref: '',
  helper_missing: '',
};

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function guiError(err: unknown, mutation = false): ToolResult {
  if (err instanceof GuiError) {
    const unknownOutcome = err.code === 'outcome_unknown' || (mutation && err.code === 'timeout');
    let text = `(${err.code}) ${err.message}${HINTS[err.code] ?? ''}`;
    if (unknownOutcome && err.code === 'timeout') {
      text += ' The action may or may not have happened: inspect the UI before retrying.';
    } else if (mutation && !unknownOutcome && !/nothing was (done|pressed|changed)/i.test(text)) {
      text += ' Nothing was done.';
    }
    return errorResult(text);
  }
  return errorResult(err instanceof Error ? err.message : String(err));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function candidatesText(title: string, lines: string[], footer: string): ToolResult {
  const shown = lines.slice(0, MAX_CANDIDATES);
  const more = lines.length > shown.length ? `\n… and ${lines.length - shown.length} more` : '';
  return errorResult(`${title}\n${shown.map((l) => `- ${l}`).join('\n')}${more}\n${footer}`);
}

export function guiTools(_ctx: ToolContext, opts: GuiToolOptions = {}): ToolDef[] {
  const platform = opts.platform ?? process.platform;
  const runner = opts.runner ?? nativeRunner();
  const settleMs = opts.settleMs ?? 300;

  /** Calls the helper within the remaining time of this tool call. */
  const makeCall = (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    return (command: HelperCommand, request: Record<string, unknown> = {}): Promise<HelperResponse> => {
      if (platform !== 'darwin') throw unsupportedPlatform(platform);
      const left = deadline - Date.now();
      if (left < 300) throw new GuiError('timeout', `The ${timeoutMs} ms time limit was used up before the step "${command}".`);
      return runner(command, { ...request, budgetMs: Math.max(200, left - 750) }, left);
    };
  };
  type Call = ReturnType<typeof makeCall>;

  const listApps = async (call: Call) => ((await call('apps')).apps ?? []) as AppInfo[];
  const listWindowsOf = async (call: Call, pids: number[], maxWindows = 500) => {
    const res = await call('windows', { pids, maxWindows });
    return {
      windows: (res.windows ?? []) as WindowInfo[],
      errors: (res.errors ?? []) as { pid: number; error: string }[],
      complete: res.complete !== false,
    };
  };

  const appList = (apps: AppInfo[]) => apps.slice(0, 40).map(describeApp).join(', ') + (apps.length > 40 ? ', …' : '');

  /** The one app `query` names; anything else becomes the tool's (error) answer. */
  const pickApp = (apps: AppInfo[], query: string): AppInfo | ToolResult => {
    const m = matchApps(apps, query);
    if (m.kind === 'one') return m.item;
    if (m.kind === 'none') {
      return errorResult(`(app_not_found) No running app matches ${JSON.stringify(query)}. Running apps: ${appList(apps) || '(none)'}. Nothing was done.`);
    }
    return candidatesText(
      `(ambiguous_app) ${plural(m.items.length, 'app')} match ${JSON.stringify(query)}:`,
      m.items.map(describeApp),
      'Nothing was done. Name the app by bundle id or pid.',
    );
  };

  const pickWindow = (app: AppInfo, windows: WindowInfo[], sel: z.infer<z.ZodObject<typeof windowShape>>, readOnly: boolean) => {
    const header = `in ${describeApp(app)}`;
    if (!windows.length) return errorResult(`(window_not_found) ${app.name} has no windows that Accessibility can see. Nothing was done.`);
    if (hasWindowSelector(sel)) {
      const m = matchWindows(windows, sel);
      if (m.kind === 'one') return { window: m.item, why: 'selected' };
      if (m.kind === 'none') {
        return candidatesText(
          `(window_not_found) No window ${header} matches ${JSON.stringify(sel)}. Its windows:`,
          windows.map(describeWindow),
          'Nothing was done.',
        );
      }
      return candidatesText(
        `(ambiguous_window) ${plural(m.items.length, 'window')} ${header} match ${JSON.stringify(sel)}:`,
        m.items.map(describeWindow),
        'Nothing was done. Pick one by windowId.',
      );
    }
    if (windows.length === 1) return { window: windows[0], why: 'the only window' };
    if (readOnly) {
      const d = defaultWindow(windows.filter((w) => !w.minimized)) ?? defaultWindow(windows);
      if (d) return d;
    }
    return candidatesText(
      `(ambiguous_window) ${app.name} has ${windows.length} windows; name one (windowId, windowTitle or windowIndex):`,
      windows.map(describeWindow),
      'Nothing was done.',
    );
  };

  const refOf = (app: AppInfo, key: WindowKey, node: UiNode) => encodeRef({ pid: app.pid, window: key, fp: node.fp, path: node.path });

  // -------------------------------------------------------------------------------------------
  // list_windows
  // -------------------------------------------------------------------------------------------

  const listWindows = defineTool({
    name: 'list_windows',
    description:
      'macOS only. List the windows of running apps through the Accessibility API: app name, bundle id, pid, window title, ' +
      'windowId (stable while the window exists), index (front-to-back), focused/main/minimized/modal flags and the ' +
      'document URL when the app reports one. Use app + windowId to target a window in inspect_ui, press_element and ' +
      'set_element_value. Needs Accessibility permission for the process running this server.',
    inputSchema: listShape,
    annotations: { title: 'List Windows', readOnlyHint: true, openWorldHint: false },
    handler: async (raw) => {
      const a = parseArgs(listShape, raw);
      const call = makeCall(a.timeoutMs);
      try {
        const apps = await listApps(call);
        let targets = apps;
        if (a.app?.trim()) {
          const m = matchApps(apps, a.app);
          if (m.kind === 'none') {
            return errorResult(`(app_not_found) No running app matches ${JSON.stringify(a.app)}. Running apps: ${appList(apps) || '(none)'}`);
          }
          targets = m.kind === 'one' ? [m.item] : m.items;
        }
        const res = await listWindowsOf(call, targets.map((t) => t.pid), a.limit + 1);
        let windows = res.windows;
        if (!a.includeMinimized) windows = windows.filter((w) => !w.minimized);
        const truncated = windows.length > a.limit || !res.complete;
        windows = windows.slice(0, a.limit);

        const byPid = new Map(targets.map((t) => [t.pid, t]));
        const lines: string[] = [`Windows (${windows.length}${truncated ? ', list incomplete: raise limit or name an app' : ''}):`];
        let lastPid = -1;
        for (const w of windows) {
          if (w.pid !== lastPid) {
            const app = byPid.get(w.pid);
            lines.push(app ? describeApp(app) : `pid ${w.pid}`);
            lastPid = w.pid;
          }
          lines.push(`  - ${describeWindow(w)}`);
        }
        if (!windows.length) lines.push('(none)');
        const withWindows = new Set(res.windows.map((w) => w.pid));
        const failed = new Set(res.errors.map((e) => e.pid));
        const without = targets.filter((t) => !withWindows.has(t.pid) && !failed.has(t.pid));
        if (without.length && res.complete) lines.push(`Apps without windows: ${without.slice(0, 30).map((t) => t.name).join(', ')}${without.length > 30 ? ', …' : ''}`);
        for (const e of res.errors) lines.push(`Could not read the windows of ${byPid.get(e.pid)?.name ?? 'pid'} (pid ${e.pid}): ${e.error}`);
        return lines.join('\n');
      } catch (err) {
        return guiError(err);
      }
    },
  });

  // -------------------------------------------------------------------------------------------
  // inspect_ui
  // -------------------------------------------------------------------------------------------

  const inspectUi = defineTool({
    name: 'inspect_ui',
    description:
      'macOS only. Inspect the Accessibility tree of one app window (or of a subtree): role/subrole, title, description, ' +
      'identifier, placeholder, value (text cut at 200 chars; password fields never read), enabled/focused state, whether ' +
      'it can be pressed or its text set, and a ref per element. Pass a ref to press_element / set_element_value, or back ' +
      'to inspect_ui to expand a subtree. Scans are bounded (maxDepth, maxElements, timeoutMs) and say when they are ' +
      'incomplete. Window defaults to the only/focused/main/frontmost window of the app (default app: the frontmost one). ' +
      'role/name/identifier only filter what is listed.',
    inputSchema: inspectShape,
    annotations: { title: 'Inspect UI Elements', readOnlyHint: true, openWorldHint: false },
    handler: async (raw) => {
      const a = parseArgs(inspectShape, raw);
      const call = makeCall(a.timeoutMs);
      try {
        const apps = await listApps(call);
        let app: AppInfo;
        let key: WindowKey;
        let root = '';
        let rootFp: string | undefined;
        let chosen = '';
        if (a.ref?.trim()) {
          if (a.app?.trim() || hasWindowSelector(a) || a.path?.trim()) {
            return errorResult('Pass either ref, or app/window/path — not both.');
          }
          const ref = decodeRef(a.ref);
          if (!ref) return errorResult('(bad_ref) That is not an element ref from inspect_ui (expected ax1:…).');
          const found = apps.find((x) => x.pid === ref.pid);
          if (!found) return errorResult(`(app_not_found) The app of this ref (pid ${ref.pid}) is no longer running. Run list_windows again.`);
          app = found;
          key = ref.window;
          root = ref.path;
          rootFp = ref.fp;
        } else {
          if (a.path?.trim() && !isValidPath(a.path.trim())) return errorResult(`(bad_path) Invalid element path ${JSON.stringify(a.path)}.`);
          if (a.app?.trim()) {
            const picked = pickApp(apps, a.app);
            if (!('pid' in picked)) return picked;
            app = picked;
          } else {
            const active = apps.filter((x) => x.active);
            if (active.length !== 1) return errorResult('(app_not_found) No frontmost app could be determined; name one with app.');
            app = active[0];
          }
          const { windows } = await listWindowsOf(call, [app.pid]);
          const picked = pickWindow(app, windows, a, true);
          if ('content' in picked) return picked;
          key = windowKeyOf(picked.window);
          chosen = picked.why === 'selected' ? '' : ` (${picked.why}; name another with windowId)`;
          root = a.path?.trim() ?? '';
        }

        const res = await call('tree', {
          pid: app.pid,
          window: key,
          root,
          ...(rootFp ? { rootFp } : {}),
          maxDepth: a.maxDepth,
          maxElements: a.maxElements,
          includeValues: a.includeValues,
          maxValueChars: 200,
        });
        const window = res.window as WindowInfo;
        const winKey = windowKeyOf(window);
        const nodes = sortPreorder((res.nodes ?? []) as UiNode[]);
        const criteria: ElementCriteria = { role: a.role, name: a.name, identifier: a.identifier };
        const filtered = hasElementCriteria(criteria);
        const shown = filtered ? nodes.filter((n) => nodeMatches(n, criteria)) : nodes;
        const complete = res.complete !== false;

        const lines = [
          `App: ${describeApp(app)}`,
          `Window: ${describeWindow(window)}${chosen}`,
          `Scanned ${plural(nodes.length, 'element')} from ${root ? `path ${root}` : 'the window'} (maxDepth ${a.maxDepth}, maxElements ${a.maxElements}): ` +
            (complete ? 'complete.' : `INCOMPLETE (${res.stopReason ?? 'limit'}) — inspect a subtree via its ref, or raise maxDepth/maxElements.`),
        ];
        if (filtered) lines.push(`Elements matching ${JSON.stringify(criteria)}: ${shown.length}`);
        lines.push('');
        const baseDepth = nodes.length ? Math.min(...nodes.map((n) => n.depth)) : 0;
        for (const n of shown) lines.push(formatNode(n, refOf(app, winKey, n), filtered ? '' : '  '.repeat(n.depth - baseDepth)));
        if (!shown.length) lines.push('(no elements)');
        lines.push('', 'Pass a ref to press_element / set_element_value. Refs stop working when that part of the UI changes; inspect again then.');
        return lines.join('\n');
      } catch (err) {
        return guiError(err);
      }
    },
  });

  // -------------------------------------------------------------------------------------------
  // press_element / set_element_value
  // -------------------------------------------------------------------------------------------

  /** The single element a press/set call addresses, or the answer explaining why there is none. */
  async function resolveTarget(call: Call, a: TargetArgs, mode: 'press' | 'set'): Promise<Target | ToolResult> {
    const capable = mode === 'press' ? canPress : canSetText;
    const capability = mode === 'press' ? 'supports AXPress' : 'has a settable text value';
    const lacks = mode === 'press' ? 'does not support AXPress' : 'has no settable text value';
    const apps = await listApps(call);

    if (a.ref?.trim()) {
      if (a.app?.trim() || hasWindowSelector(a) || hasElementCriteria(a) || a.path?.trim()) {
        return errorResult('Pass either ref, or app/window/role/name/identifier/path — not both. Nothing was done.');
      }
      const ref = decodeRef(a.ref);
      if (!ref) return errorResult('(bad_ref) That is not an element ref from inspect_ui (expected ax1:…). Nothing was done.');
      const app = apps.find((x) => x.pid === ref.pid);
      if (!app) return errorResult(`(app_not_found) The app of this ref (pid ${ref.pid}) is no longer running. Nothing was done.`);
      if (isProtectedApp(app)) return protectedResult(app);
      // Re-read the element (and check its fingerprint) to learn what it supports right now.
      const res = await call('tree', { pid: app.pid, window: ref.window, root: ref.path, rootFp: ref.fp, maxDepth: 0, maxElements: 1, includeValues: false });
      const node = ((res.nodes ?? []) as UiNode[])[0];
      if (!node) return errorResult('(element_not_found) The element of this ref could not be read. Nothing was done.');
      const window = res.window as WindowInfo;
      if (!capable(node)) {
        return errorResult(`(not_actionable) The element ${lacks}: ${formatNode(node, a.ref.trim())}. Nothing was done.`);
      }
      return { app, window, key: ref.window, node, ref: a.ref.trim() };
    }

    if (!a.app?.trim()) return errorResult('Name the target: either ref (from inspect_ui), or app plus role/name/identifier/path. Nothing was done.');
    const path = a.path?.trim() ?? '';
    const criteria: ElementCriteria = { role: a.role, name: a.name, identifier: a.identifier };
    const byCriteria = hasElementCriteria(criteria);
    if (!byCriteria && !path) return errorResult('Give role, name, identifier and/or path to select the element (or pass a ref). Nothing was done.');
    if (path && !isValidPath(path)) return errorResult(`(bad_path) Invalid element path ${JSON.stringify(path)}. Nothing was done.`);

    const picked = pickApp(apps, a.app);
    if (!('pid' in picked)) return picked;
    const app = picked;
    if (isProtectedApp(app)) return protectedResult(app);
    const { windows } = await listWindowsOf(call, [app.pid]);
    const w = pickWindow(app, windows, a, false);
    if ('content' in w) return w;
    const key = windowKeyOf(w.window);

    // Without role/name/identifier the path itself is the target; otherwise search under it.
    const res = await call('tree', {
      pid: app.pid,
      window: key,
      root: path,
      maxDepth: byCriteria ? SELECT_MAX_DEPTH : 0,
      maxElements: byCriteria ? SELECT_MAX_ELEMENTS : 1,
      includeValues: false,
    });
    const nodes = sortPreorder((res.nodes ?? []) as UiNode[]);
    const complete = res.complete !== false;
    const matches = byCriteria ? nodes.filter((n) => nodeMatches(n, criteria)) : nodes.slice(0, 1);
    const usable = matches.filter(capable);
    const where = `in ${app.name} ${describeWindow(w.window)}`;
    const selector = JSON.stringify({ ...criteria, ...(path ? { path } : {}) }, (_k, v) => (v === undefined ? undefined : v));

    if (!usable.length) {
      if (!matches.length) {
        return errorResult(
          `(element_not_found) No element matches ${selector} ${where} (scanned ${plural(nodes.length, 'element')}${complete ? '' : `; the scan was incomplete: ${res.stopReason ?? 'limit'}`}). ` +
            'Nothing was done. Use inspect_ui to see what is there.',
        );
      }
      return candidatesText(
        `(not_actionable) ${plural(matches.length, 'element')} match ${selector} ${where}, but none ${capability}:`,
        matches.map((n) => formatNode(n, refOf(app, key, n))),
        'Nothing was done. No coordinate click is attempted; if the control has no semantic action, it cannot be operated with this tool.',
      );
    }
    if (usable.length > 1) {
      return candidatesText(
        `(ambiguous_element) ${plural(usable.length, 'element')} match ${selector} and ${mode === 'press' ? 'support AXPress' : 'have a settable text value'} ${where}:`,
        usable.map((n) => formatNode(n, refOf(app, key, n))),
        'Nothing was done. Narrow the selector (identifier, path) or pass the ref of the one you mean.',
      );
    }
    const node = usable[0];
    if (!complete && byCriteria) {
      return errorResult(
        `(scan_incomplete) Exactly one element matching ${selector} was found ${where}, but the scan stopped early ` +
          `(${res.stopReason ?? 'limit'}), so other matches may exist. Nothing was done. If this is the element you mean, ` +
          `pass its ref: ${refOf(app, key, node)}\n${formatNode(node, refOf(app, key, node))}`,
      );
    }
    return { app, window: w.window, key, node, ref: refOf(app, key, node) };
  }

  function protectedResult(app: AppInfo): ToolResult {
    return errorResult(
      `(protected_app) ${describeApp(app)} is protected: GUI actions never operate security, password or settings apps ` +
        '(they could change permissions or credentials). Nothing was done. The owner can do this by hand.',
    );
  }

  async function act(call: Call, t: Target, action: 'press' | 'setValue', value?: string): Promise<HelperResponse> {
    return call('act', { pid: t.app.pid, window: t.key, path: t.node.path, fp: t.node.fp, action, settleMs, ...(value !== undefined ? { value } : {}) });
  }

  const label = (t: Target) =>
    `${t.node.role}${t.node.subrole ? `/${t.node.subrole}` : ''}${t.node.title ? ` ${JSON.stringify(t.node.title)}` : t.node.description ? ` ${JSON.stringify(t.node.description)}` : ''}` +
    ` in ${describeApp(t.app)} window ${JSON.stringify(t.window.title)}`;

  const pressElement = defineTool({
    name: 'press_element',
    description:
      'macOS only. Press one button, checkbox, menu item or other control semantically (Accessibility AXPress; no mouse ' +
      'click, no coordinates). Target it by ref from inspect_ui, or by app + optional window (windowId/windowTitle/' +
      'windowIndex; required when the app has several windows) + role/name/identifier/path. Zero matches: nothing ' +
      'happens and you are told; several matches: the candidates are returned and nothing is pressed. Reports what was ' +
      'observed afterwards (element/window still present, changed title/value). Security, password and settings apps are refused.',
    inputSchema: pressShape,
    annotations: { title: 'Press UI Element', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async (raw) => {
      const a = parseArgs(pressShape, raw);
      const call = makeCall(a.timeoutMs);
      let target: Target | ToolResult;
      try {
        target = await resolveTarget(call, a, 'press');
      } catch (err) {
        return guiError(err, true);
      }
      if ('content' in target) return target;
      let res: HelperResponse;
      try {
        res = await act(call, target, 'press');
      } catch (err) {
        return guiError(err, true);
      }
      const before = (res.before ?? {}) as Record<string, unknown>;
      const after = (res.after ?? {}) as Record<string, unknown>;
      const observed: string[] = [];
      observed.push(after.exists === false ? 'the element is gone' : 'the element is still present');
      observed.push(res.windowExists === false ? 'the window closed' : 'the window is still open');
      for (const k of ['title', 'value', 'enabled', 'focused']) {
        if (after.exists !== false && JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
          observed.push(`${k}: ${JSON.stringify(before[k] ?? null)} -> ${JSON.stringify(after[k] ?? null)}`);
        }
      }
      if (observed.length === 2 && after.exists !== false && res.windowExists !== false) observed.push('no change visible on the element itself');
      return textResult(
        `Pressed ${label(target)}.\n` +
          'The app accepted AXPress (this confirms the press was delivered; what it does is up to the app).\n' +
          `Observed ${settleMs} ms later: ${observed.join('; ')}.\nref: ${target.ref}`,
      );
    },
  });

  const setElementValue = defineTool({
    name: 'set_element_value',
    description:
      'macOS only. Set the text of one editable element (text field, text area, combo box) semantically through its ' +
      'Accessibility value (AXValue; no typing, no clicks, no coordinates), replacing the current text, then read it back ' +
      'to verify. Target it by ref from inspect_ui, or by app + optional window + role/name/identifier/path, with the same ' +
      'no-match / several-matches rules as press_element. Refuses secure (password) fields and non-text values. The ' +
      'previous value is reported (cut at 200 chars). Security, password and settings apps are refused.',
    inputSchema: setShape,
    annotations: { title: 'Set UI Element Value', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (raw) => {
      const a = parseArgs(setShape, raw);
      const call = makeCall(a.timeoutMs);
      let target: Target | ToolResult;
      try {
        target = await resolveTarget(call, a, 'set');
      } catch (err) {
        return guiError(err, true);
      }
      if ('content' in target) return target;
      let res: HelperResponse;
      try {
        res = await act(call, target, 'setValue', a.value);
      } catch (err) {
        return guiError(err, true);
      }
      const before = (res.before ?? {}) as Record<string, unknown>;
      const prev = typeof before.value === 'string' ? `${JSON.stringify(before.value)}${(before.valueLength as number) > before.value.length ? ` …(${before.valueLength} chars)` : ''}` : '(none)';
      const head = `Set the value of ${label(target)} (${plural(a.value.length, 'char')}).\nPrevious value: ${prev}\nref: ${target.ref}`;
      if (res.verified === true) return textResult(`${head}\nVerified: reading the value back returns exactly the requested text.`);
      const back = res.readBack === null || res.readBack === undefined ? 'no readable value' : `${JSON.stringify(res.readBack)} (${res.readBackLength} chars)`;
      return errorResult(
        `(not_verified) The app accepted the new value, but reading it back returns ${back}, not the requested text. ` +
          `The element may reformat or reject input, or need focus/typing instead.\n${head}`,
      );
    },
  });

  return [listWindows, inspectUi, pressElement, setElementValue] as unknown as ToolDef[];
}
