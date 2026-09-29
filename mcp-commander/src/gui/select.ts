/**
 * Pure selection logic for the GUI tools: matching apps, windows and Accessibility elements,
 * encoding element refs, and rendering. No I/O here; the native helper (helper.ts) supplies data.
 *
 * Every selector resolves to exactly one target or to nothing: callers act only on `one`, and hand
 * `many` back to the model as candidates. Position/size are never used to select anything.
 */

export interface AppInfo {
  pid: number;
  name: string;
  bundleId: string | null;
  active: boolean;
  hidden: boolean;
}

export interface WindowInfo {
  pid: number;
  /** Position in the app's AXWindows (front-to-back, so it changes as focus moves). */
  index: number;
  /** CGWindowID: stable for the window's lifetime (null when macOS does not provide it). */
  windowId: number | null;
  title: string;
  /** FNV-1a of the full title, used to verify an index-addressed window. */
  titleFp: string;
  identifier?: string;
  role?: string;
  subrole?: string;
  document?: string;
  main?: boolean;
  focused?: boolean;
  minimized?: boolean;
  modal?: boolean;
}

export interface UiNode {
  /** "Role[n]/Role[n]" from the window; n counts siblings with the same role. "" = the window. */
  path: string;
  /** Absolute child indices from the scan root (for display order). */
  order: number[];
  depth: number;
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  identifier?: string;
  placeholder?: string;
  value?: string | number | boolean;
  valueTruncated?: boolean;
  valueLength?: number;
  enabled?: boolean;
  focused?: boolean;
  actions?: string[];
  settable?: boolean;
  secure?: boolean;
  childCount?: number;
  childrenOmitted?: number;
  /** Identity fingerprint (role, subrole, identifier, title, description) checked before acting. */
  fp: string;
  error?: string;
}

export type Match<T> = { kind: 'one'; item: T } | { kind: 'none' } | { kind: 'many'; items: T[] };

function toMatch<T>(items: T[]): Match<T> {
  if (items.length === 1) return { kind: 'one', item: items[0] };
  return items.length ? { kind: 'many', items } : { kind: 'none' };
}

const ci = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Apps whose windows GUI mutations never touch: pressing buttons there could grant permissions
 * (TCC), approve security prompts, or read/alter credentials. Keep in sync with
 * protectedBundleIds in native/ax-helper.swift, which enforces the same list.
 */
export const PROTECTED_BUNDLE_IDS = new Set([
  'com.apple.systempreferences', 'com.apple.SystemPreferences', 'com.apple.settings.PrivacySecurity.extension',
  'com.apple.SecurityAgent', 'com.apple.UserNotificationCenter', 'com.apple.keychainaccess', 'com.apple.Passwords',
  'com.apple.loginwindow', 'com.apple.coreservices.uiagent', 'com.apple.accessibility.universalAccessAuthWarn',
  'com.apple.ScreenSaver.Engine', 'com.apple.Installer', 'com.apple.DiskUtility', 'com.apple.MigrateAssistant',
]);

export function isProtectedApp(app: Pick<AppInfo, 'bundleId'>): boolean {
  return !!app.bundleId && PROTECTED_BUNDLE_IDS.has(app.bundleId);
}

/**
 * `query` is a pid, a bundle id or an app name. Exact (case-insensitive) matches win; only when
 * there are none is a name substring tried — and that must still be unique to be used.
 */
export function matchApps(apps: AppInfo[], query: string): Match<AppInfo> {
  const q = ci(query);
  if (!q) return { kind: 'none' };
  if (/^\d+$/.test(q)) return toMatch(apps.filter((a) => a.pid === Number(q)));
  const exact = apps.filter((a) => ci(a.bundleId) === q || ci(a.name) === q);
  if (exact.length) return toMatch(exact);
  return toMatch(apps.filter((a) => ci(a.name).includes(q)));
}

export interface WindowSelector {
  windowId?: number;
  windowTitle?: string;
  windowIndex?: number;
}

export function hasWindowSelector(sel: WindowSelector): boolean {
  return sel.windowId !== undefined || sel.windowIndex !== undefined || (sel.windowTitle ?? '').trim() !== '';
}

/** Windows matching every given field. Title: exact (case-insensitive) first, else a substring. */
export function matchWindows(windows: WindowInfo[], sel: WindowSelector): Match<WindowInfo> {
  let list = windows;
  if (sel.windowId !== undefined) list = list.filter((w) => w.windowId === sel.windowId);
  if (sel.windowIndex !== undefined) list = list.filter((w) => w.index === sel.windowIndex);
  const t = ci(sel.windowTitle);
  if (t) {
    const exact = list.filter((w) => ci(w.title) === t);
    list = exact.length ? exact : list.filter((w) => ci(w.title).includes(t));
  }
  return toMatch(list);
}

/**
 * The window inspect_ui uses when none was named (read-only, so a sensible default is fine): the
 * only window, else the focused one, else the main one, else the frontmost. Mutations never use this.
 */
export function defaultWindow(windows: WindowInfo[]): { window: WindowInfo; why: string } | null {
  if (!windows.length) return null;
  if (windows.length === 1) return { window: windows[0], why: 'the only window' };
  const focused = windows.filter((w) => w.focused);
  if (focused.length === 1) return { window: focused[0], why: 'the focused window' };
  const main = windows.filter((w) => w.main);
  if (main.length === 1) return { window: main[0], why: 'the main window' };
  const front = windows.reduce((best, w) => (w.index < best.index ? w : best));
  return { window: front, why: 'the frontmost window' };
}

/** "button" / "AXButton" / "axbutton" -> "axbutton" (compare case-insensitively). */
export function normalizeRole(role: string): string {
  const r = role.trim().toLowerCase();
  return r.startsWith('ax') ? r : `ax${r}`;
}

export interface ElementCriteria {
  role?: string;
  name?: string;
  identifier?: string;
}

export function hasElementCriteria(c: ElementCriteria): boolean {
  return !!(c.role?.trim() || c.name?.trim() || c.identifier?.trim());
}

/**
 * role: the element's role or subrole ("button", "AXCloseButton"); name: its title, description or
 * placeholder (case-insensitive, whole string); identifier: AXIdentifier, exact.
 */
export function nodeMatches(node: UiNode, c: ElementCriteria): boolean {
  if (c.role?.trim()) {
    const r = normalizeRole(c.role);
    if (ci(node.role) !== r && ci(node.subrole) !== r) return false;
  }
  if (c.name?.trim()) {
    const n = ci(c.name);
    if (![node.title, node.description, node.placeholder].some((v) => v !== undefined && ci(v) === n)) return false;
  }
  if (c.identifier?.trim() && node.identifier !== c.identifier.trim()) return false;
  return true;
}

export const canPress = (n: UiNode) => !!n.actions?.includes('AXPress');
export const canSetText = (n: UiNode) => !!n.settable && !n.secure && (n.value === undefined || typeof n.value === 'string');

// ---------------------------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------------------------

export type WindowKey = { windowId: number } | { index: number; titleFp: string };

export interface ElementRef {
  pid: number;
  window: WindowKey;
  /** Fingerprint of the element when it was inspected. */
  fp: string;
  path: string;
}

const STEP = '[A-Za-z0-9_]{1,64}\\[\\d{1,5}\\]';
const PATH_RE = new RegExp(`^(?:${STEP}(?:/${STEP}){0,127})?$`);
const REF_RE = /^ax1:(\d{1,7}):(w\d{1,10}|i\d{1,4}-[0-9a-f]{8}):([0-9a-f]{8}):(.*)$/;

export function isValidPath(path: string): boolean {
  return path.length <= 8192 && PATH_RE.test(path);
}

export function windowKeyOf(w: WindowInfo): WindowKey {
  return w.windowId !== null ? { windowId: w.windowId } : { index: w.index, titleFp: w.titleFp };
}

/** `ax1:<pid>:<w<windowId> | i<index>-<titleFp>>:<fp>:<path>` — path last, so it may be empty. */
export function encodeRef(ref: ElementRef): string {
  const win = 'windowId' in ref.window ? `w${ref.window.windowId}` : `i${ref.window.index}-${ref.window.titleFp}`;
  return `ax1:${ref.pid}:${win}:${ref.fp}:${ref.path}`;
}

/** Parses a ref; null when it is not one this version produced. */
export function decodeRef(text: string): ElementRef | null {
  const m = REF_RE.exec(text.trim());
  if (!m) return null;
  const [, pid, win, fp, path] = m;
  if (!isValidPath(path)) return null;
  const window: WindowKey = win.startsWith('w')
    ? { windowId: Number(win.slice(1)) }
    : { index: Number(win.slice(1, win.indexOf('-'))), titleFp: win.slice(win.indexOf('-') + 1) };
  return { pid: Number(pid), window, fp, path };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Pre-order (tree) order from the breadth-first scan. */
export function sortPreorder(nodes: UiNode[]): UiNode[] {
  return [...nodes].sort((a, b) => {
    const n = Math.min(a.order.length, b.order.length);
    for (let i = 0; i < n; i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
    return a.order.length - b.order.length;
  });
}

const q = (s: string) => JSON.stringify(s);

export function describeApp(app: AppInfo): string {
  return `${app.name} (pid ${app.pid}${app.bundleId ? `, ${app.bundleId}` : ''})`;
}

export function describeWindow(w: WindowInfo): string {
  const flags = [w.focused && 'focused', w.main && 'main', w.minimized && 'minimized', w.modal && 'modal'].filter(Boolean);
  return (
    `window ${q(w.title)} ${w.windowId !== null ? `windowId=${w.windowId}` : '(no windowId)'} index=${w.index}` +
    (w.subrole && w.subrole !== 'AXStandardWindow' ? ` subrole=${w.subrole}` : '') +
    (w.identifier ? ` identifier=${q(w.identifier)}` : '') +
    (flags.length ? ` [${flags.join(', ')}]` : '') +
    (w.document ? ` document=${w.document}` : '')
  );
}

/** One line per element: role, the identifying texts, state flags, then the ref. */
export function formatNode(node: UiNode, ref: string, indent = ''): string {
  const parts = [`${indent}${node.role}${node.subrole ? `/${node.subrole}` : ''}`];
  if (node.title !== undefined) parts.push(q(node.title));
  if (node.description !== undefined) parts.push(`desc=${q(node.description)}`);
  if (node.identifier !== undefined) parts.push(`id=${q(node.identifier)}`);
  if (node.placeholder !== undefined) parts.push(`placeholder=${q(node.placeholder)}`);
  if (node.value !== undefined) {
    const v = typeof node.value === 'string' ? q(node.value) : String(node.value);
    parts.push(`value=${v}${node.valueTruncated ? `…(${node.valueLength} chars)` : ''}`);
  }
  const flags: string[] = [];
  if (node.enabled === false) flags.push('disabled');
  if (node.focused) flags.push('focused');
  if (canPress(node)) flags.push('pressable');
  if (node.settable && !node.secure) flags.push('settable');
  if (node.secure) flags.push('secure');
  const other = (node.actions ?? []).filter((a) => a !== 'AXPress');
  if (other.length) flags.push(`actions=${other.join(',')}`);
  if (node.error) flags.push(`error=${node.error}`);
  if (flags.length) parts.push(`[${flags.join(', ')}]`);
  if (node.childrenOmitted) parts.push(`(+${node.childrenOmitted} children not shown)`);
  parts.push(`ref=${ref}`);
  return parts.join(' ');
}
