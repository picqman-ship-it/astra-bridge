// GUI (macOS Accessibility) tools: pure selection/ref logic, the tools' behaviour against a fake
// helper (ambiguity, not-found, stale/protected, platform and permission errors), schemas, the
// remote policy, and read-only checks of the real native helper when it is built on macOS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DIST, connectInMemory, load, makeCtx, runTool, textOf } from './helpers.js';

const select = await load('gui/select.js');
const { GuiError, nativeRunner, HELPER_NAME } = await load('gui/helper.js');
const { guiTools, GUI_TOOLS } = await load('tools/gui.js');
const policy = await load('remote/policy.js');
const { RootGuard } = await load('remote/root-guard.js');
const { parseRemoteConfig } = await load('remote/config.js');

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const APPS = [
  { pid: 100, name: 'TextEdit', bundleId: 'com.apple.TextEdit', active: true, hidden: false },
  { pid: 200, name: 'Notes', bundleId: 'com.apple.Notes', active: false, hidden: false },
  { pid: 201, name: 'Notes Helper Pro', bundleId: 'com.example.noteshelper', active: false, hidden: false },
  { pid: 300, name: 'System Settings', bundleId: 'com.apple.systempreferences', active: false, hidden: false },
];

const WIN_A = { pid: 100, index: 0, windowId: 11, title: 'a.txt', titleFp: 'aaaaaaaa', focused: true, main: true, subrole: 'AXStandardWindow' };
const WIN_B = { pid: 100, index: 1, windowId: 12, title: 'b.txt', titleFp: 'bbbbbbbb' };

const node = (path, order, role, extra = {}) => ({ path, order, depth: order.length, role, fp: extra.fp ?? `f${String(order.join('')).padStart(7, '0')}`.slice(0, 8), ...extra });
const TREE = [
  node('', [], 'AXWindow', { title: 'a.txt', fp: '00000001' }),
  node('AXScrollArea[0]', [0], 'AXScrollArea', { fp: '00000002' }),
  node('AXScrollArea[0]/AXTextArea[0]', [0, 0], 'AXTextArea', { settable: true, value: 'hello', fp: '00000003' }),
  node('AXButton[0]', [1], 'AXButton', { title: 'OK', actions: ['AXPress'], fp: '00000004' }),
  node('AXButton[1]', [2], 'AXButton', { title: 'OK', actions: ['AXPress'], fp: '00000005' }),
  node('AXButton[2]', [3], 'AXButton', { title: 'Cancel', actions: ['AXPress'], identifier: 'cancel-btn', fp: '00000006' }),
  node('AXTextField[0]', [4], 'AXTextField', { subrole: 'AXSecureTextField', secure: true, settable: true, description: 'Password', fp: '00000007' }),
  node('AXStaticText[0]', [5], 'AXStaticText', { value: 'Label', fp: '00000008' }),
  node('AXButton[3]', [6], 'AXButton', { subrole: 'AXCloseButton', actions: ['AXPress'], fp: '00000009' }),
];

/** A fake helper: `handlers[command]` is a value or (request) => value; errors are thrown. */
function fake(handlers = {}) {
  const calls = [];
  const defaults = {
    apps: { apps: APPS },
    windows: (req) => ({ windows: [WIN_A, WIN_B].filter((w) => req.pids.includes(w.pid)), errors: [], complete: true }),
    tree: (req) => {
      const win = req.window.windowId === 12 ? WIN_B : WIN_A;
      const root = req.root ?? '';
      let nodes = TREE.filter((n) => root === '' || n.path === root || n.path.startsWith(`${root}/`));
      if (req.maxDepth === 0) nodes = nodes.filter((n) => n.path === root);
      if (req.rootFp && nodes[0] && nodes[0].fp !== req.rootFp) throw new GuiError('stale_ref', 'The element at this ref changed.');
      return { window: win, nodes, complete: true, scanned: nodes.length };
    },
    act: (req) =>
      req.action === 'press'
        ? { action: 'press', performed: true, before: { exists: true, title: 'OK' }, after: { exists: true, title: 'OK' }, windowExists: true }
        : { action: 'setValue', performed: true, verified: true, before: { exists: true, value: 'hello', valueLength: 5 }, readBack: req.value, readBackLength: req.value.length, windowExists: true },
  };
  const all = { ...defaults, ...handlers };
  const runner = async (cmd, req, timeoutMs) => {
    calls.push({ cmd, req, timeoutMs });
    const h = all[cmd];
    if (h === undefined) throw new Error(`unexpected helper command ${cmd}`);
    return typeof h === 'function' ? h(req) : h;
  };
  return { runner, calls, acts: () => calls.filter((c) => c.cmd === 'act') };
}

async function tools(handlers, opts = {}) {
  const { ctx, cleanup } = await makeCtx();
  const f = fake(handlers);
  const defs = guiTools(ctx, { runner: f.runner, platform: 'darwin', settleMs: 0, ...opts });
  return { defs, f, cleanup, call: (name, args) => runTool(defs, name, args) };
}

// ---------------------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------------------

describe('gui selection logic', () => {
  it('matches apps by pid, bundle id, exact name, then a unique name substring', () => {
    assert.equal(select.matchApps(APPS, '100').item.name, 'TextEdit');
    assert.equal(select.matchApps(APPS, 'com.apple.textedit').item.pid, 100);
    assert.equal(select.matchApps(APPS, 'textedit').item.pid, 100);
    // "Notes" is an exact name, so the longer "Notes Helper Pro" does not make it ambiguous.
    assert.equal(select.matchApps(APPS, 'notes').item.pid, 200);
    assert.equal(select.matchApps(APPS, 'helper').item.pid, 201);
    assert.equal(select.matchApps(APPS, 'note').kind, 'many');
    assert.equal(select.matchApps(APPS, 'nope').kind, 'none');
    assert.equal(select.matchApps(APPS, '  ').kind, 'none');
    assert.equal(select.matchApps(APPS, '999').kind, 'none');
  });

  it('matches windows by id, index and title (exact before substring) and reports ambiguity', () => {
    const wins = [WIN_A, WIN_B, { ...WIN_B, index: 2, windowId: 13, title: 'a.txt copy' }];
    assert.equal(select.matchWindows(wins, { windowId: 12 }).item.index, 1);
    assert.equal(select.matchWindows(wins, { windowIndex: 2 }).item.windowId, 13);
    assert.equal(select.matchWindows(wins, { windowTitle: 'A.TXT' }).item.windowId, 11, 'exact title wins over substring');
    assert.equal(select.matchWindows(wins, { windowTitle: 'txt' }).kind, 'many');
    assert.equal(select.matchWindows(wins, { windowTitle: 'copy' }).item.windowId, 13);
    assert.equal(select.matchWindows(wins, { windowId: 11, windowTitle: 'b.txt' }).kind, 'none', 'all given fields must match');
    assert.equal(select.hasWindowSelector({}), false);
    assert.equal(select.hasWindowSelector({ windowTitle: ' ' }), false);
    assert.equal(select.hasWindowSelector({ windowIndex: 0 }), true);
  });

  it('picks a default window for read-only inspection only by a clear rule', () => {
    assert.equal(select.defaultWindow([]), null);
    assert.equal(select.defaultWindow([WIN_B]).why, 'the only window');
    assert.equal(select.defaultWindow([WIN_B, WIN_A]).window.windowId, 11);
    const plain = [{ ...WIN_B, index: 3 }, { ...WIN_B, index: 1, windowId: 99 }];
    assert.deepEqual(select.defaultWindow(plain), { window: plain[1], why: 'the frontmost window' });
  });

  it('matches elements by role/subrole, name (title, description, placeholder) and identifier', () => {
    const find = (c) => TREE.filter((n) => select.nodeMatches(n, c)).map((n) => n.path);
    assert.deepEqual(find({ role: 'button', name: 'ok' }), ['AXButton[0]', 'AXButton[1]']);
    assert.deepEqual(find({ role: 'AXCloseButton' }), ['AXButton[3]'], 'subrole matches too');
    assert.deepEqual(find({ name: 'password' }), ['AXTextField[0]'], 'description is a name');
    assert.deepEqual(find({ identifier: 'cancel-btn' }), ['AXButton[2]']);
    assert.deepEqual(find({ identifier: 'CANCEL-BTN' }), [], 'identifier is exact');
    assert.deepEqual(find({ name: 'OK', identifier: 'cancel-btn' }), [], 'all criteria must hold');
    assert.equal(select.normalizeRole('TextField'), 'axtextfield');
    assert.equal(select.normalizeRole('AXButton'), 'axbutton');
    assert.equal(select.hasElementCriteria({ role: ' ' }), false);
  });

  it('knows which elements can be pressed or given text (never secure fields)', () => {
    const byPath = Object.fromEntries(TREE.map((n) => [n.path, n]));
    assert.equal(select.canPress(byPath['AXButton[0]']), true);
    assert.equal(select.canPress(byPath['AXStaticText[0]']), false);
    assert.equal(select.canSetText(byPath['AXScrollArea[0]/AXTextArea[0]']), true);
    assert.equal(select.canSetText(byPath['AXTextField[0]']), false, 'secure field');
    assert.equal(select.canSetText({ ...byPath['AXScrollArea[0]/AXTextArea[0]'], value: 3 }), false, 'numeric value');
  });

  it('encodes and decodes refs deterministically and rejects anything else', () => {
    const a = { pid: 4123, window: { windowId: 5821 }, fp: '1a2b3c4d', path: 'AXScrollArea[0]/AXTextArea[0]' };
    const text = select.encodeRef(a);
    assert.equal(text, 'ax1:4123:w5821:1a2b3c4d:AXScrollArea[0]/AXTextArea[0]');
    assert.deepEqual(select.decodeRef(text), a);
    assert.equal(select.encodeRef(a), text, 'deterministic');
    const b = { pid: 7, window: { index: 2, titleFp: '0badf00d' }, fp: 'ffffffff', path: '' };
    assert.deepEqual(select.decodeRef(select.encodeRef(b)), b, 'window by index + title hash, window root');
    for (const bad of [
      '', 'ax2:1:w1:00000000:', 'ax1:x:w1:00000000:', 'ax1:1:w1:XYZ:', 'ax1:1:q1:00000000:',
      'ax1:1:w1:00000000:AXButton', 'ax1:1:w1:00000000:AXButton[0]/', 'ax1:1:w1:00000000:../AXButton[0]',
      'ax1:1:w1:00000000:AX Button[0]', 'ax1:1:w1:00000000:AXButton[-1]',
    ]) {
      assert.equal(select.decodeRef(bad), null, bad);
    }
    assert.equal(select.isValidPath(Array.from({ length: 129 }, () => 'AXGroup[0]').join('/')), false, 'depth bound');
  });

  it('orders a breadth-first scan as a tree and renders one line per element with its ref', () => {
    const shuffled = [TREE[3], TREE[2], TREE[0], TREE[1]];
    assert.deepEqual(select.sortPreorder(shuffled).map((n) => n.path), ['', 'AXScrollArea[0]', 'AXScrollArea[0]/AXTextArea[0]', 'AXButton[0]']);
    const line = select.formatNode({ ...TREE[5], enabled: false, childrenOmitted: 4 }, 'ax1:1:w1:00000006:AXButton[2]', '  ');
    assert.match(line, /^ {2}AXButton "Cancel" id="cancel-btn" \[disabled, pressable\] \(\+4 children not shown\) ref=ax1:1:w1:00000006:AXButton\[2\]$/);
    const secure = select.formatNode(TREE[6], 'r');
    assert.match(secure, /\[secure\]/);
    assert.doesNotMatch(secure, /settable|value=/);
  });

  it('protects security/settings apps (same list as the native helper)', () => {
    assert.equal(select.isProtectedApp({ bundleId: 'com.apple.systempreferences' }), true);
    assert.equal(select.isProtectedApp({ bundleId: 'com.apple.TextEdit' }), false);
    assert.equal(select.isProtectedApp({ bundleId: null }), false);
    const swift = fs.readFileSync(path.join(DIST, '..', 'native', 'ax-helper.swift'), 'utf8');
    const block = swift.slice(swift.indexOf('let protectedBundleIds'), swift.indexOf(']', swift.indexOf('let protectedBundleIds')));
    const swiftIds = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(swiftIds, [...select.PROTECTED_BUNDLE_IDS].sort());
  });
});

// ---------------------------------------------------------------------------------------------
// Tools against a fake helper
// ---------------------------------------------------------------------------------------------

describe('gui tools: platform, helper and permission errors', () => {
  it('fails cleanly on non-macOS without calling the helper', async () => {
    const t = await tools({}, { platform: 'linux' });
    try {
      for (const [name, args] of [
        ['list_windows', {}], ['inspect_ui', { app: 'TextEdit' }],
        ['press_element', { app: 'TextEdit', name: 'OK' }], ['set_element_value', { app: 'TextEdit', role: 'textarea', value: 'x' }],
      ]) {
        const r = await t.call(name, args);
        assert.equal(r.isError, true, name);
        assert.match(textOf(r), /unsupported_platform.*not available on this platform \(linux\)/, name);
      }
      assert.equal(t.f.calls.length, 0);
    } finally {
      t.cleanup();
    }
  });

  it('reports a missing helper binary', async () => {
    const run = nativeRunner('/nonexistent/mcp-commander-ax');
    await assert.rejects(run('apps', {}, 1000), (err) => err instanceof GuiError && err.code === 'helper_missing');
  });

  it('reports missing Accessibility permission with the exact place to grant it', async () => {
    const t = await tools({ windows: () => { throw new GuiError('not_trusted', 'Accessibility access is not granted to the process that runs this server.'); } });
    try {
      const r = await t.call('list_windows', {});
      assert.equal(r.isError, true);
      assert.match(textOf(r), /\(not_trusted\).*Privacy & Security > Accessibility.*never bypasses/s);
    } finally {
      t.cleanup();
    }
  });

  it('reports a locked screen instead of listing placeholder windows', async () => {
    const t = await tools({ windows: () => { throw new GuiError('screen_locked', "The Mac's screen is locked."); } });
    try {
      const r = await t.call('inspect_ui', { app: 'TextEdit' });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /\(screen_locked\)/);
    } finally {
      t.cleanup();
    }
  });

  it('passes a time budget to every helper call and stops when it is used up', async () => {
    const t = await tools();
    try {
      await t.call('list_windows', { timeoutMs: 5000 });
      for (const c of t.f.calls) {
        assert.ok(c.timeoutMs <= 5000 && c.timeoutMs > 0, `${c.cmd} timeout`);
        assert.ok(c.req.budgetMs < c.timeoutMs, `${c.cmd} helper budget leaves room for the kill`);
      }
    } finally {
      t.cleanup();
    }
  });
});

describe('gui tools: list_windows and inspect_ui', () => {
  it('lists windows grouped by app with ids and flags', async () => {
    const t = await tools();
    try {
      const out = textOf(await t.call('list_windows', {}));
      assert.match(out, /Windows \(2\):/);
      assert.match(out, /TextEdit \(pid 100, com\.apple\.TextEdit\)\n {2}- window "a\.txt" windowId=11 index=0 \[focused, main\]/);
      assert.match(out, /window "b\.txt" windowId=12 index=1/);
      assert.match(out, /Apps without windows: Notes, Notes Helper Pro, System Settings/);
    } finally {
      t.cleanup();
    }
  });

  it('lists windows of every app a loose filter matches, and says when none does', async () => {
    const t = await tools();
    try {
      await t.call('list_windows', { app: 'note' });
      assert.deepEqual(t.f.calls.find((c) => c.cmd === 'windows').req.pids, [200, 201]);
      const none = await t.call('list_windows', { app: 'Nope' });
      assert.equal(none.isError, true);
      assert.match(textOf(none), /app_not_found.*Running apps: TextEdit/);
    } finally {
      t.cleanup();
    }
  });

  it('inspects the focused window by default, with refs usable later', async () => {
    const t = await tools();
    try {
      const r = await t.call('inspect_ui', { app: 'TextEdit' });
      const out = textOf(r);
      assert.ok(!r.isError, out);
      assert.match(out, /Window: window "a\.txt" windowId=11 .*\(the focused window; name another with windowId\)/);
      assert.match(out, /complete\./);
      assert.match(out, /^ {4}AXTextArea value="hello" \[settable\] ref=ax1:100:w11:00000003:AXScrollArea\[0\]\/AXTextArea\[0\]$/m);
      const tree = t.f.calls.find((c) => c.cmd === 'tree').req;
      assert.deepEqual(tree.window, { windowId: 11 });
      assert.equal(tree.maxDepth, 10);
      assert.equal(tree.maxElements, 300);
    } finally {
      t.cleanup();
    }
  });

  it('defaults to the frontmost app, filters without changing the scan, and flags incomplete scans', async () => {
    const t = await tools({
      tree: () => ({ window: WIN_A, nodes: TREE, complete: false, stopReason: 'element limit', scanned: TREE.length }),
    });
    try {
      const out = textOf(await t.call('inspect_ui', { role: 'button', name: 'ok', maxElements: 5 }));
      assert.match(out, /App: TextEdit/);
      assert.match(out, /INCOMPLETE \(element limit\)/);
      assert.match(out, /Elements matching .*: 2/);
      assert.equal((out.match(/^AXButton "OK"/gm) ?? []).length, 2);
      assert.doesNotMatch(out, /Cancel/);
    } finally {
      t.cleanup();
    }
  });

  it('expands a subtree from a ref and refuses a ref mixed with selectors', async () => {
    const t = await tools();
    try {
      const ref = 'ax1:100:w11:00000002:AXScrollArea[0]';
      const out = textOf(await t.call('inspect_ui', { ref }));
      assert.match(out, /from path AXScrollArea\[0\]/);
      const req = t.f.calls.find((c) => c.cmd === 'tree').req;
      assert.equal(req.root, 'AXScrollArea[0]');
      assert.equal(req.rootFp, '00000002');
      const mixed = await t.call('inspect_ui', { ref, app: 'TextEdit' });
      assert.equal(mixed.isError, true);
      const bad = await t.call('inspect_ui', { ref: 'click at 10,20' });
      assert.match(textOf(bad), /bad_ref/);
    } finally {
      t.cleanup();
    }
  });
});

describe('gui tools: press_element and set_element_value never guess', () => {
  it('returns candidates and does nothing when several elements match', async () => {
    const t = await tools();
    try {
      const r = await t.call('press_element', { app: 'TextEdit', windowId: 11, role: 'button', name: 'OK' });
      assert.equal(r.isError, true);
      const out = textOf(r);
      assert.match(out, /\(ambiguous_element\) 2 elements match/);
      assert.match(out, /ref=ax1:100:w11:00000004:AXButton\[0\]/);
      assert.match(out, /ref=ax1:100:w11:00000005:AXButton\[1\]/);
      assert.match(out, /Nothing was done/);
      assert.equal(t.f.acts().length, 0);
    } finally {
      t.cleanup();
    }
  });

  it('reports not found (and matches that cannot act) without acting', async () => {
    const t = await tools();
    try {
      const none = await t.call('press_element', { app: 'TextEdit', windowId: 11, name: 'Save' });
      assert.match(textOf(none), /\(element_not_found\) No element matches .*Nothing was done/);
      const label = await t.call('press_element', { app: 'TextEdit', windowId: 11, role: 'statictext' });
      assert.equal(label.isError, true);
      assert.match(textOf(label), /\(not_actionable\).*none supports AXPress/s);
      const pw = await t.call('set_element_value', { app: 'TextEdit', windowId: 11, name: 'Password', value: 'secret' });
      assert.match(textOf(pw), /\(not_actionable\).*none has a settable text value/s);
      assert.equal(t.f.acts().length, 0);
    } finally {
      t.cleanup();
    }
  });

  it('requires a window choice when the app has several windows', async () => {
    const t = await tools();
    try {
      const r = await t.call('press_element', { app: 'TextEdit', identifier: 'cancel-btn' });
      assert.match(textOf(r), /\(ambiguous_window\) TextEdit has 2 windows.*windowId=11.*windowId=12/s);
      assert.equal(t.f.acts().length, 0);
      const byTitle = await t.call('press_element', { app: 'TextEdit', windowTitle: '.txt', identifier: 'cancel-btn' });
      assert.match(textOf(byTitle), /ambiguous_window/);
    } finally {
      t.cleanup();
    }
  });

  it('refuses a unique match from an incomplete scan, offering its ref instead', async () => {
    const t = await tools({ tree: () => ({ window: WIN_A, nodes: TREE, complete: false, stopReason: 'time budget' }) });
    try {
      const r = await t.call('press_element', { app: 'TextEdit', windowId: 11, identifier: 'cancel-btn' });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /\(scan_incomplete\).*time budget.*pass its ref: ax1:100:w11:00000006:AXButton\[2\]/s);
      assert.equal(t.f.acts().length, 0);
    } finally {
      t.cleanup();
    }
  });

  it('presses the single match semantically and reports what it observed', async () => {
    const t = await tools({
      act: { action: 'press', performed: true, before: { exists: true }, after: { exists: false }, windowExists: false },
    });
    try {
      const r = await t.call('press_element', { app: 'com.apple.TextEdit', windowId: 11, role: 'AXCloseButton' });
      const out = textOf(r);
      assert.ok(!r.isError, out);
      assert.match(out, /Pressed AXButton\/AXCloseButton in TextEdit/);
      assert.match(out, /the element is gone; the window closed/);
      const [act] = t.f.acts();
      assert.deepEqual(
        { action: act.req.action, pid: act.req.pid, window: act.req.window, path: act.req.path, fp: act.req.fp },
        { action: 'press', pid: 100, window: { windowId: 11 }, path: 'AXButton[3]', fp: '00000009' },
      );
      for (const k of ['x', 'y', 'position', 'point']) assert.ok(!(k in act.req), `no coordinates (${k})`);
    } finally {
      t.cleanup();
    }
  });

  it('acts on a ref after re-reading it (fingerprint checked), and refuses stale refs', async () => {
    const t = await tools();
    try {
      const ok = await t.call('press_element', { ref: 'ax1:100:w11:00000006:AXButton[2]' });
      assert.ok(!ok.isError, textOf(ok));
      const tree = t.f.calls.find((c) => c.cmd === 'tree').req;
      assert.deepEqual({ root: tree.root, rootFp: tree.rootFp, maxDepth: tree.maxDepth }, { root: 'AXButton[2]', rootFp: '00000006', maxDepth: 0 });
      assert.equal(t.f.acts()[0].req.fp, '00000006');

      const stale = await t.call('press_element', { ref: 'ax1:100:w11:0000beef:AXButton[2]' });
      assert.equal(stale.isError, true);
      assert.match(textOf(stale), /\(stale_ref\).*Nothing was done/);
      assert.equal(t.f.acts().length, 1);

      const gone = await t.call('press_element', { ref: 'ax1:555:w11:00000006:AXButton[2]' });
      assert.match(textOf(gone), /app_not_found/);
      const mixed = await t.call('press_element', { ref: 'ax1:100:w11:00000006:AXButton[2]', name: 'OK' });
      assert.match(textOf(mixed), /either ref, or app/);
      const wrongKind = await t.call('set_element_value', { ref: 'ax1:100:w11:00000006:AXButton[2]', value: 'x' });
      assert.match(textOf(wrongKind), /\(not_actionable\) The element has no settable text value/);
      assert.equal(t.f.acts().length, 1);
    } finally {
      t.cleanup();
    }
  });

  it('never acts in protected security/settings apps, by selector or by ref', async () => {
    const t = await tools();
    try {
      const a = await t.call('press_element', { app: 'System Settings', name: 'Allow' });
      assert.match(textOf(a), /\(protected_app\)/);
      const b = await t.call('press_element', { ref: 'ax1:300:w1:00000000:AXButton[0]' });
      assert.match(textOf(b), /\(protected_app\)/);
      assert.equal(t.f.calls.filter((c) => c.cmd === 'tree' || c.cmd === 'act').length, 0);
    } finally {
      t.cleanup();
    }
  });

  it('requires a real selector', async () => {
    const t = await tools();
    try {
      assert.match(textOf(await t.call('press_element', {})), /Name the target/);
      assert.match(textOf(await t.call('press_element', { app: 'TextEdit' })), /Give role, name, identifier and\/or path/);
      assert.match(textOf(await t.call('press_element', { app: 'TextEdit', windowId: 11, path: 'AXButton' })), /bad_path/);
      assert.equal(t.f.calls.filter((c) => c.cmd === 'tree' || c.cmd === 'act').length, 0);
    } finally {
      t.cleanup();
    }
  });

  it('sets text by path, verifies it by reading back, and reports the previous value', async () => {
    const t = await tools();
    try {
      const r = await t.call('set_element_value', { app: 'TextEdit', windowId: 11, path: 'AXScrollArea[0]/AXTextArea[0]', value: 'new text' });
      const out = textOf(r);
      assert.ok(!r.isError, out);
      assert.match(out, /Set the value of AXTextArea in TextEdit .* \(8 chars\)/);
      assert.match(out, /Previous value: "hello"/);
      assert.match(out, /Verified: reading the value back returns exactly the requested text/);
      const tree = t.f.calls.find((c) => c.cmd === 'tree').req;
      assert.equal(tree.maxDepth, 0, 'a bare path addresses that element only');
      assert.equal(t.f.acts()[0].req.value, 'new text');
    } finally {
      t.cleanup();
    }
  });

  it('reports a value the app did not keep as not verified', async () => {
    const t = await tools({
      act: { action: 'setValue', performed: true, verified: false, before: { exists: true, value: '' }, readBack: 'NEW TEXT', readBackLength: 8 },
    });
    try {
      const r = await t.call('set_element_value', { app: 'TextEdit', windowId: 11, role: 'textarea', value: 'new text' });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /\(not_verified\).*"NEW TEXT" \(8 chars\)/s);
    } finally {
      t.cleanup();
    }
  });

  it('says the outcome is unknown when the helper is cut off during the action', async () => {
    const t = await tools({ act: () => { throw new GuiError('timeout', 'The Accessibility helper did not finish within 900 ms and was stopped.'); } });
    try {
      const r = await t.call('press_element', { app: 'TextEdit', windowId: 11, identifier: 'cancel-btn' });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /may or may not have happened/);
      assert.doesNotMatch(textOf(r), /Nothing was done/);
    } finally {
      t.cleanup();
    }
  });

  it('passes helper refusals through with "nothing was done"', async () => {
    const t = await tools({ act: () => { throw new GuiError('secure_field', 'Refusing to set a secure (password) text field.'); } });
    try {
      const r = await t.call('set_element_value', { app: 'TextEdit', windowId: 11, role: 'textarea', value: 'x' });
      assert.match(textOf(r), /\(secure_field\) Refusing.*Nothing was done\./);
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Schemas (through a real MCP client) and the remote policy
// ---------------------------------------------------------------------------------------------

describe('gui tool schemas and remote policy', () => {
  it('registers four GUI tools with bounded, coordinate-free schemas', async () => {
    const s = await connectInMemory();
    try {
      const { tools: list } = await s.client.listTools();
      const byName = Object.fromEntries(list.map((t) => [t.name, t]));
      assert.deepEqual(GUI_TOOLS, ['list_windows', 'inspect_ui', 'press_element', 'set_element_value']);
      for (const name of GUI_TOOLS) {
        const props = Object.keys(byName[name].inputSchema.properties);
        for (const p of props) assert.doesNotMatch(p, /^(x|y|point|position|coordinates?)$/i, `${name}.${p}`);
      }
      assert.equal(byName.list_windows.annotations.readOnlyHint, true);
      assert.equal(byName.inspect_ui.annotations.readOnlyHint, true);
      assert.equal(byName.press_element.annotations.destructiveHint, true);
      assert.deepEqual(byName.set_element_value.inputSchema.required, ['value']);
      assert.equal(byName.inspect_ui.inputSchema.properties.maxElements.maximum, 2000);
      assert.equal(byName.inspect_ui.inputSchema.properties.maxDepth.maximum, 40);
      assert.equal(byName.set_element_value.inputSchema.properties.value.maxLength, 100_000);
      // Schema validation happens before any handler (and so before any helper) runs.
      const missing = await s.call('set_element_value', { app: 'TextEdit', role: 'textarea' });
      assert.equal(missing.isError, true);
      const tooDeep = await s.call('inspect_ui', { app: 'TextEdit', maxDepth: 99 });
      assert.equal(tooDeep.isError, true);
    } finally {
      await s.close();
    }
  });

  it('exposes GUI tools remotely only with trustedGui, mutations with idempotencyKey', async () => {
    assert.ok(!policy.remoteToolNames(true).some((t) => GUI_TOOLS.includes(t)), 'trusted terminal alone does not add GUI');
    assert.ok(!policy.remoteToolNames(false).some((t) => GUI_TOOLS.includes(t)));
    assert.deepEqual(policy.remoteToolNames(false, true).filter((t) => GUI_TOOLS.includes(t)), GUI_TOOLS);
    assert.equal(policy.remoteToolNames(true, true).length, 31);

    const { IDEMPOTENT_TOOLS } = await load('remote/idempotency.js');
    assert.ok(IDEMPOTENT_TOOLS.includes('press_element') && IDEMPOTENT_TOOLS.includes('set_element_value'));
    assert.ok(!IDEMPOTENT_TOOLS.includes('inspect_ui') && !IDEMPOTENT_TOOLS.includes('list_windows'));

    const { ctx, cleanup } = await makeCtx();
    try {
      const all = guiTools(ctx, { runner: fake().runner, platform: 'darwin' });
      const cfg = { trustedTerminal: false, trustedGui: true, roots: ['/tmp'], idempotency: { maxKeys: 10, maxResultBytes: 4096 } };
      const roots = new RootGuard(cfg.roots);
      const selected = policy.selectRemoteTools(cfg, { idempotency: {}, jobs: null, roots })(all);
      assert.deepEqual(selected.map((t) => t.name), GUI_TOOLS);
      const keyed = selected.filter((t) => 'idempotencyKey' in t.inputSchema).map((t) => t.name);
      assert.deepEqual(keyed, ['press_element', 'set_element_value']);
      assert.throws(() => policy.selectRemoteTools(cfg, { idempotency: {}, jobs: null }), /needs the runtime RootGuard/);
      const off = policy.selectRemoteTools({ ...cfg, trustedGui: false }, { idempotency: {}, jobs: null, roots })(all);
      assert.deepEqual(off, []);
    } finally {
      cleanup();
    }
  });

  it('validates trustedGui in remote.json strictly (default off)', async () => {
    const { tmpDir, rmrf } = await import('./helpers.js');
    const base = tmpDir('mcpc-gui-remote-');
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    try {
      const cfg = (extra) => JSON.stringify({ schemaVersion: 1, roots: [work], ...extra });
      assert.equal(parseRemoteConfig(cfg({}), path.join(base, 'remote')).trustedGui, false);
      assert.equal(parseRemoteConfig(cfg({ trustedGui: true }), path.join(base, 'remote')).trustedGui, true);
      assert.throws(() => parseRemoteConfig(cfg({ trustedGui: 'yes' }), path.join(base, 'remote')), /trustedGui must be true or false/);
    } finally {
      rmrf(base);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The real native helper (read-only commands only; no UI is touched)
// ---------------------------------------------------------------------------------------------

const helperPath = path.join(DIST, 'native', HELPER_NAME);
const haveHelper = process.platform === 'darwin' && fs.existsSync(helperPath);

describe('native helper (macOS, read-only)', { skip: !haveHelper && 'helper not built on this platform' }, () => {
  const run = (cmd, input) => {
    const r = spawnSync(helperPath, [cmd], { input, encoding: 'utf8', timeout: 10_000 });
    return { status: r.status, json: JSON.parse(r.stdout.trim()) };
  };

  it('reports trust and session state without touching any app', () => {
    const { status, json } = run('check', '{}');
    assert.equal(status, 0);
    assert.equal(json.ok, true);
    assert.equal(typeof json.trusted, 'boolean');
    assert.equal(typeof json.screenLocked, 'boolean');
    assert.equal(json.windowIdSupported, true, '_AXUIElementGetWindow is present on this macOS');
  });

  it('lists regular apps (needs no Accessibility permission)', () => {
    const { json } = run('apps', '');
    assert.equal(json.ok, true);
    assert.ok(json.apps.some((a) => a.bundleId === 'com.apple.finder'), 'Finder is always running');
    for (const a of json.apps) assert.equal(typeof a.pid, 'number');
  });

  it('answers bad requests with a structured error, never a crash', () => {
    for (const [cmd, input, code] of [
      ['nope', '{}', 'bad_request'],
      ['tree', 'not json', 'bad_request'],
      ['act', '{"pid": 999999, "window": {"windowId": 1}, "path": "", "fp": "00000000", "action": "press"}', null],
    ]) {
      const { status, json } = run(cmd, input);
      assert.equal(status, 0, cmd);
      assert.equal(json.ok, false, cmd);
      if (code) assert.equal(json.code, code, cmd);
      else assert.ok(['app_not_found', 'not_trusted', 'screen_locked', 'session_inactive'].includes(json.code), json.code);
    }
  });

  it('the Node runner round-trips through the real binary', async () => {
    const res = await nativeRunner(helperPath)('check', {}, 10_000);
    assert.equal(res.ok, true);
  });
});
