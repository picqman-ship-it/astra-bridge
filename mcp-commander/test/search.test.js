// Search tools (start_search / get_more_search_results / stop_search / list_searches), run
// against both engines: ripgrep (auto-resolved, @vscode/ripgrep) and the built-in walker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectInMemory, load, makeCtx, rmrf, runTool, sleep, textOf, tmpDir, waitFor } from './helpers.js';

const { SearchManager } = await load('search/manager.js');
const { searchTools } = await load('tools/search.js');
const { resolveRipgrepPath, clearRipgrepCache, runRipgrep } = await load('search/ripgrep.js');

let ROOT; // main fixture tree
let BIG; // many files, for stop / event-loop tests
let SCRATCH; // fake binaries etc.
let ctxInfo;

const INDEX_TS = [
  "import { login } from './auth/login';",
  '// TODO: wire everything up',
  'export function main(argv: string[]) {',
  '  const value = compute(42);',
  '  return value;',
  '}',
  'function compute(n: number) {',
  '  return n * 2; // TODO(perf): cache',
  '}',
  '',
].join('\n');

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function buildFixture(root) {
  write(root, '.git/config', '[core]\n\tneedle = true\n');
  write(root, '.git/HEAD', 'ref: refs/heads/main\n');
  write(root, '.gitignore', 'ignored.txt\nbuild/\n');
  write(root, 'ignored.txt', 'needle (ignored file)\n');
  write(root, 'build/out.js', 'const needle = "built";\n');
  write(root, 'README.md', '# Project\n\nThe Needle is here.\n');
  write(root, 'docs/guide.md', '# Guide\nNothing to see.\n');
  write(root, 'docs/dup.txt', 'dup\n');
  write(root, 'src/dup.txt', 'dup\n');
  write(root, 'src/index.ts', INDEX_TS);
  write(root, 'src/authService.ts', 'export const authService = {};\n');
  write(root, 'src/OAuthClient.ts', 'export class OAuthClient {}\n');
  write(root, 'src/auth/login.ts', 'export function login() {}\n');
  write(root, 'src/auth/session.js', 'module.exports = {};\n');
  write(root, 'src/utils/helpers.ts', 'export const helper = 1;\n');
  write(root, 'src/utils/format.js', 'exports.format = (s) => s;\n');
  write(root, 'src/pages/[id].tsx', 'export default function Page() {}\n');
  write(root, '.hidden/secret.txt', 'needle in a hidden dir\n');
  write(root, '.env', 'NEEDLE=1\n');
  write(root, 'unicode/žalgiris.txt', 'Labas pasauli ąčęėįšųūž\n日本語のテキスト needle 🎉\n');
  write(root, 'data/latin1.txt', Buffer.from('caf\xe9 needle\n', 'latin1'));
  write(root, 'data/blob.bin', Buffer.from('needle\x00\x01binary\n', 'latin1'));
  write(root, 'data/long.txt', `${'x'.repeat(1500)}NEEDLE${'y'.repeat(20)}\n`);
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, '0');
    write(root, `many/hit_${n}.txt`, Array.from({ length: 5 }, (_, j) => `hit ${n}-${j + 1}`).join('\n') + '\n');
  }
}

before(() => {
  ROOT = tmpDir('mcpc-search-');
  buildFixture(ROOT);
  BIG = tmpDir('mcpc-search-big-');
  for (let d = 0; d < 40; d++) {
    const dir = path.join(BIG, `dir${String(d).padStart(2, '0')}`);
    fs.mkdirSync(dir);
    for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `file${f}.txt`), `line one\nthe needle ${d}-${f}\n`);
  }
  SCRATCH = tmpDir('mcpc-search-bin-');
});

after(() => {
  for (const p of [ROOT, BIG, SCRATCH]) if (p) rmrf(p);
  ctxInfo?.cleanup();
});

async function getCtx() {
  ctxInfo ??= await makeCtx();
  return ctxInfo.ctx;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** Parses the result lines of start_search / get_more_search_results output. */
function parseResults(text) {
  const out = [];
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^📁 (.+)$/.exec(line))) out.push({ kind: 'file', file: m[1] });
    else if ((m = /^📂 (.+)\/$/.exec(line))) out.push({ kind: 'dir', file: m[1] });
    else if ((m = /^📄 (.+?):(\d+) - (.*)$/.exec(line))) out.push({ kind: 'match', file: m[1], line: +m[2], text: m[3] });
    else if ((m = /^ {3}(\/.+?):(\d+) {3}(.*)$/.exec(line))) out.push({ kind: 'context', file: m[1], line: +m[2], text: m[3] });
  }
  return out;
}

/** 'file:src/a.ts' / 'dir:src/auth' labels, sorted, for order-independent comparison. */
const labels = (results) => results.map((r) => `${r.kind}:${rel(r.file)}`).sort();

const sessionIdOf = (text) => /session:? (search_\d+_\d+)/.exec(text)?.[1];

const ENGINES = [
  { name: 'ripgrep', opts: {} },
  { name: 'built-in', opts: { rgPath: null } },
];

const rgAvailable = (await resolveRipgrepPath()) !== null;

for (const engine of ENGINES) {
  describe(`search tools [${engine.name}]`, { skip: engine.name === 'ripgrep' && !rgAvailable && 'ripgrep not found' }, () => {
    let search;
    let tools;
    const call = (name, args = {}) => runTool(tools, name, args);
    const start = async (args) => {
      const r = await call('start_search', { path: ROOT, ...args });
      const text = textOf(r);
      return { r, text, id: sessionIdOf(text), results: parseResults(text) };
    };
    /** Every result of a session, via get_more_search_results. */
    const readAll = async (id) => {
      const r = await call('get_more_search_results', { sessionId: id, offset: 0, length: 100000 });
      assert.ok(!r.isError, textOf(r));
      return parseResults(textOf(r));
    };

    before(async () => {
      search = new SearchManager(engine.opts);
      tools = searchTools(await getCtx(), search);
    });
    after(() => search.shutdown());

    // ----- files mode ------------------------------------------------------------------------

    test('small tree: COMPLETED with results, exact header format', async () => {
      const { r, text, id } = await start({ pattern: 'auth' });
      assert.ok(!r.isError, text);
      assert.match(id, /^search_\d+_\d+$/);
      assert.ok(text.startsWith(`Started file search session: ${id}\nPattern: "auth"\nPath: ${ROOT}\nStatus: COMPLETED\nRuntime: `), text);
      assert.match(text, /\nRuntime: \d+ms\nEngine: (ripgrep|built-in)\nTotal results: 3\n\nInitial results:\n/);
      assert.ok(text.includes(`Engine: ${engine.name}\n`), text);
      assert.ok(text.endsWith('\n✅ Search completed.'), text);
      // substring, case-insensitive; directories whose name matches are listed, their files are not
      assert.deepEqual(labels(parseResults(text)), ['dir:src/auth', 'file:src/OAuthClient.ts', 'file:src/authService.ts']);
      assert.ok(text.includes(`📂 ${path.join(ROOT, 'src/auth')}/\n`), text);
      assert.ok(text.includes(`📁 ${path.join(ROOT, 'src/authService.ts')}`), text);
    });

    test('files: ignoreCase=false is case-sensitive', async () => {
      assert.deepEqual(labels((await start({ pattern: 'Auth', ignoreCase: false })).results), ['file:src/OAuthClient.ts']);
      assert.deepEqual(labels((await start({ pattern: 'AUTH' })).results).length, 3);
      const none = await start({ pattern: 'AUTH', ignoreCase: false });
      assert.ok(none.text.includes('Total results: 0\n\nNo matches found.\n\n✅ Search completed.'), none.text);
    });

    test('files: glob patterns match the whole basename', async () => {
      assert.deepEqual(labels((await start({ pattern: '*.md' })).results), ['file:README.md', 'file:docs/guide.md']);
      assert.deepEqual(labels((await start({ pattern: '*.MD' })).results), ['file:README.md', 'file:docs/guide.md']);
      assert.deepEqual(labels((await start({ pattern: '*.MD', ignoreCase: false })).results), []);
      assert.deepEqual(labels((await start({ pattern: '{index,helpers}.ts' })).results), [
        'file:src/index.ts',
        'file:src/utils/helpers.ts',
      ]);
      assert.deepEqual(labels((await start({ pattern: 'hit_0?.txt' })).results).length, 9);
    });

    test('files: filePattern is ANDed with the pattern (not ORed)', async () => {
      const none = await start({ pattern: 'login', filePattern: '*.md' });
      assert.ok(none.text.includes('No matches found.'), none.text);
      assert.deepEqual(labels((await start({ pattern: 'guide', filePattern: '*.md' })).results), ['file:docs/guide.md']);
      // Without filePattern 'o' also finds the docs/ directory; with it only matching files remain.
      assert.ok(labels((await start({ pattern: 'o' })).results).includes('dir:docs'));
      assert.deepEqual(labels((await start({ pattern: 'o', filePattern: '*.ts|*.js' })).results), [
        'file:src/OAuthClient.ts',
        'file:src/auth/login.ts',
        'file:src/auth/session.js',
        'file:src/utils/format.js',
      ]);
      // '!glob' excludes
      assert.deepEqual(labels((await start({ pattern: 'o', filePattern: '*.ts|*.js|!login.ts' })).results), [
        'file:src/OAuthClient.ts',
        'file:src/auth/session.js',
        'file:src/utils/format.js',
      ]);
    });

    test('files: hidden entries only with includeHidden; .git is never listed', async () => {
      assert.ok((await start({ pattern: 'secret' })).text.includes('No matches found.'));
      assert.deepEqual(labels((await start({ pattern: 'secret', includeHidden: true })).results), ['file:.hidden/secret.txt']);
      assert.deepEqual(labels((await start({ pattern: '.env', includeHidden: true })).results), ['file:.env']);
      assert.deepEqual(labels((await start({ pattern: 'HEAD', includeHidden: true })).results), []);
      assert.deepEqual(labels((await start({ pattern: 'config', includeHidden: true })).results), []);
    });

    test('files: a pattern with "/" matches the root-relative path', async () => {
      assert.deepEqual(labels((await start({ pattern: 'utils/help' })).results), ['file:src/utils/helpers.ts']);
      assert.deepEqual(labels((await start({ pattern: 'src/*.ts' })).results), [
        'file:src/OAuthClient.ts',
        'file:src/authService.ts',
        'file:src/index.ts',
      ]);
    });

    test('files: bracket names match literally, glob escapes work', async () => {
      assert.deepEqual(labels((await start({ pattern: '[id].tsx' })).results), ['file:src/pages/[id].tsx']);
      assert.deepEqual(labels((await start({ pattern: '\\[id\\].tsx' })).results), ['file:src/pages/[id].tsx']);
      assert.deepEqual(labels((await start({ pattern: '*.tsx' })).results), ['file:src/pages/[id].tsx']);
    });

    test('files: filePattern globs with "/" are relative to the search root', async () => {
      assert.deepEqual(labels((await start({ pattern: '', filePattern: 'src/utils/*' })).results), [
        'file:src/utils/format.js',
        'file:src/utils/helpers.ts',
      ]);
      const content = await start({ searchType: 'content', pattern: 'export', filePattern: 'src/**/*.ts' });
      assert.deepEqual([...new Set(content.results.map((r) => rel(r.file)))].sort(), [
        'src/OAuthClient.ts',
        'src/auth/login.ts',
        'src/authService.ts',
        'src/index.ts',
        'src/utils/helpers.ts',
      ]);
    });

    test('files: .gitignore is respected', async () => {
      assert.ok((await start({ pattern: 'ignored' })).text.includes('No matches found.'));
      assert.ok((await start({ pattern: 'out.js' })).text.includes('No matches found.'));
      assert.ok((await start({ pattern: 'build' })).text.includes('No matches found.'));
    });

    test('files: earlyTermination stops at the first exact name', async () => {
      assert.equal((await start({ pattern: 'dup.txt' })).results.length, 2);
      const early = await start({ pattern: 'dup.txt', earlyTermination: true });
      assert.equal(early.results.length, 1, early.text);
      assert.ok(early.text.includes('Total results: 1\n'), early.text);
      assert.ok(early.text.includes('🎯 Stopped at the first file whose name equals the pattern'), early.text);
    });

    test('files: maxResults is a global cap', async () => {
      assert.equal((await start({ pattern: 'hit_' })).results.length, 12);
      const capped = await start({ pattern: 'hit_', maxResults: 5 });
      assert.equal(capped.results.length, 5, capped.text);
      assert.ok(capped.text.includes('Total results: 5\n'), capped.text);
      assert.ok(capped.text.includes('⚠️ Result limit reached (maxResults=5)'), capped.text);
      assert.equal((await readAll(capped.id)).length, 5);
    });

    test('files: UTF-8 names and a single-file root', async () => {
      assert.deepEqual(labels((await start({ pattern: 'ŽALG' })).results), ['file:unicode/žalgiris.txt']);
      const single = await start({ path: path.join(ROOT, 'README.md'), pattern: 'read' });
      assert.deepEqual(labels(single.results), ['file:README.md']);
    });

    // ----- content mode ----------------------------------------------------------------------

    test('content: regex, full line text in results', async () => {
      const { text, results } = await start({ searchType: 'content', pattern: 'TODO\\(\\w+\\)' });
      assert.ok(text.startsWith('Started content search session: '), text);
      assert.deepEqual(results, [
        { kind: 'match', file: path.join(ROOT, 'src/index.ts'), line: 8, text: '  return n * 2; // TODO(perf): cache' },
      ]);
      assert.ok(text.includes(`📄 ${path.join(ROOT, 'src/index.ts')}:8 -   return n * 2; // TODO(perf): cache\n`), text);
    });

    test('content: literalSearch', async () => {
      const lit = await start({ searchType: 'content', pattern: 'TODO(perf)', literalSearch: true });
      assert.deepEqual(lit.results.map((r) => `${rel(r.file)}:${r.line}`), ['src/index.ts:8']);
      const asRegex = await start({ searchType: 'content', pattern: 'TODO(perf)' });
      assert.ok(asRegex.text.includes('No matches found.'), asRegex.text);
      const dots = await start({ searchType: 'content', pattern: 'n * 2', literalSearch: true });
      assert.equal(dots.results.length, 1, dots.text);
    });

    test('content: ignoreCase default true, false is case-sensitive', async () => {
      const lines = async (args) =>
        (await start({ searchType: 'content', filePattern: '*.ts', ...args })).results.map((r) => `${rel(r.file)}:${r.line}`);
      assert.deepEqual(await lines({ pattern: 'todo' }), ['src/index.ts:2', 'src/index.ts:8']);
      assert.deepEqual(await lines({ pattern: 'todo', ignoreCase: false }), []);
      assert.deepEqual(await lines({ pattern: 'TODO', ignoreCase: false }), ['src/index.ts:2', 'src/index.ts:8']);
      assert.deepEqual(await lines({ pattern: '(?i)todo', ignoreCase: false }), ['src/index.ts:2', 'src/index.ts:8']);
    });

    test('content: context lines', async () => {
      const { text, results } = await start({ searchType: 'content', pattern: 'const value', contextLines: 1 });
      const f = path.join(ROOT, 'src/index.ts');
      assert.deepEqual(results, [
        { kind: 'context', file: f, line: 3, text: 'export function main(argv: string[]) {' },
        { kind: 'match', file: f, line: 4, text: '  const value = compute(42);' },
        { kind: 'context', file: f, line: 5, text: '  return value;' },
      ]);
      assert.ok(text.includes('Total results: 3 (1 matches + 2 context lines)\n'), text);
      assert.ok(text.includes(`\n   ${f}:3   export function main(argv: string[]) {\n`), text);
      // overlapping context is merged, never duplicated
      const both = await start({ searchType: 'content', pattern: 'TODO', filePattern: '*.ts', contextLines: 3 });
      const nums = both.results.map((r) => r.line);
      assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.deepEqual(both.results.filter((r) => r.kind === 'match').map((r) => r.line), [2, 8]);
    });

    test('content: maxResults is a global cap across files', async () => {
      const all = await start({ path: path.join(ROOT, 'many'), searchType: 'content', pattern: 'hit' });
      assert.ok(all.text.includes('Total results: 60\n'), all.text);
      const capped = await start({ path: path.join(ROOT, 'many'), searchType: 'content', pattern: 'hit', maxResults: 7 });
      assert.ok(capped.text.includes('Total results: 7\n'), capped.text);
      assert.equal(capped.results.filter((r) => r.kind === 'match').length, 7);
      assert.ok(capped.text.includes('⚠️ Result limit reached (maxResults=7)'), capped.text);
      assert.equal((await readAll(capped.id)).length, 7);
      // more than one file contributed, so the cap is not per file
      assert.ok(capped.results.length === 7);
    });

    test('content: trailing context of the last match is kept at the cap', async () => {
      const { results, text } = await start({
        path: path.join(ROOT, 'src/index.ts'), searchType: 'content', pattern: 'TODO', contextLines: 1, maxResults: 1,
      });
      assert.deepEqual(results.map((r) => `${r.kind}:${r.line}`), ['context:1', 'match:2', 'context:3']);
      assert.ok(text.includes('Total results: 3 (1 matches + 2 context lines)\n'), text);
    });

    test('content: patterns starting with a dash are not taken as options', async () => {
      const { r, results } = await start({ path: path.join(ROOT, 'many'), searchType: 'content', pattern: '-1$' });
      assert.ok(!r.isError, textOf(r));
      assert.equal(results.length, 12);
    });

    test('content: filePattern narrows the files searched', async () => {
      const { results } = await start({ searchType: 'content', pattern: 'needle', filePattern: '*.md' });
      assert.deepEqual(results.map((r) => `${rel(r.file)}:${r.line}:${r.text}`), ['README.md:3:The Needle is here.']);
    });

    test('content: .gitignore, binary files and hidden files are skipped by default', async () => {
      const { results } = await start({ searchType: 'content', pattern: 'needle' });
      assert.deepEqual(labels(results), [
        'match:README.md',
        'match:data/latin1.txt',
        'match:data/long.txt',
        'match:unicode/žalgiris.txt',
      ]);
      const hidden = await start({ searchType: 'content', pattern: 'needle', includeHidden: true });
      assert.deepEqual(labels(hidden.results), [
        'match:.env',
        'match:.hidden/secret.txt',
        'match:README.md',
        'match:data/latin1.txt',
        'match:data/long.txt',
        'match:unicode/žalgiris.txt',
      ]);
    });

    test('content: UTF-8 text, Unicode case folding and invalid UTF-8 lines', async () => {
      const f = path.join(ROOT, 'unicode/žalgiris.txt');
      const upper = await start({ searchType: 'content', pattern: 'ĄČĘ' });
      assert.deepEqual(upper.results, [{ kind: 'match', file: f, line: 1, text: 'Labas pasauli ąčęėįšųūž' }]);
      const cjk = await start({ searchType: 'content', pattern: '日本語' });
      assert.deepEqual(cjk.results, [{ kind: 'match', file: f, line: 2, text: '日本語のテキスト needle 🎉' }]);
      const latin = await start({ searchType: 'content', pattern: 'needle', filePattern: 'latin1.txt' });
      assert.equal(latin.results.length, 1, latin.text);
      assert.match(latin.results[0].text, /^caf.+ needle$/);
      assert.ok(!latin.text.includes('undefined'), latin.text);
    });

    test('content: very long lines are shown as a window around the match', async () => {
      const { results } = await start({ searchType: 'content', pattern: 'NEEDLE', ignoreCase: false, filePattern: 'long.txt' });
      assert.equal(results.length, 1);
      const t = results[0].text;
      assert.ok(t.includes('NEEDLE'), t);
      assert.ok(t.startsWith('...x'), t);
      assert.ok(t.length <= 206, `snippet length ${t.length}`);
    });

    test('content: single-file root', async () => {
      const { results } = await start({ path: path.join(ROOT, 'src/index.ts'), searchType: 'content', pattern: 'return' });
      assert.deepEqual(results.map((r) => r.line), [5, 8]);
    });

    // ----- errors ----------------------------------------------------------------------------

    test('invalid regex is reported as an error', async () => {
      const { r, text, id } = await start({ searchType: 'content', pattern: 'foo(' });
      assert.equal(r.isError, true, text);
      assert.match(text, /^Error: Search session search_\d+_\d+ encountered an error: regex parse error/);
      const more = await call('get_more_search_results', { sessionId: id });
      assert.equal(more.isError, true);
      assert.ok(textOf(more).includes(`Search session ${id} encountered an error: regex parse error`), textOf(more));
      assert.ok(textOf(await call('list_searches')).includes('❌ ERROR'));
    });

    test('invalid filePattern glob is reported as an error', async () => {
      const { r, text } = await start({ searchType: 'content', pattern: 'x', filePattern: '[abc' });
      assert.equal(r.isError, true, text);
      assert.ok(text.includes("error parsing glob '[abc'"), text);
    });

    test('nonexistent root', async () => {
      const missing = path.join(ROOT, 'does-not-exist');
      const r = await call('start_search', { path: missing, pattern: 'x' });
      assert.equal(r.isError, true);
      assert.equal(textOf(r), `Error: Path not found: ${missing}`);
    });

    test('allowedDirectories is enforced on the root', async () => {
      const { ctx, cleanup } = await makeCtx({ allowedDirectories: [path.join(ROOT, 'src')] });
      try {
        const limited = searchTools(ctx, search);
        const denied = await runTool(limited, 'start_search', { path: path.join(ROOT, 'docs'), pattern: 'guide' });
        assert.equal(denied.isError, true);
        assert.match(textOf(denied), /^Error: Path not allowed: .*docs\. Must be within one of these directories: /);
        const escape = await runTool(limited, 'start_search', { path: path.join(ROOT, 'src', '..'), pattern: 'guide' });
        assert.equal(escape.isError, true, textOf(escape));
        const ok = await runTool(limited, 'start_search', { path: path.join(ROOT, 'src'), pattern: 'helpers' });
        assert.ok(!ok.isError, textOf(ok));
        assert.equal(parseResults(textOf(ok)).length, 1);
      } finally {
        cleanup();
      }
    });

    test('invalid arguments are rejected with a clear message', async () => {
      const r = await call('start_search', { path: ROOT, pattern: 'x', maxResults: 0 });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Invalid arguments: maxResults/);
    });

    // ----- pagination ------------------------------------------------------------------------

    test('pagination: offset/length, tail reads, empty ranges', async () => {
      const { text, id, results } = await start({ path: path.join(ROOT, 'many'), searchType: 'content', pattern: 'hit' });
      assert.equal(results.length, 50);
      assert.ok(
        text.includes(`\n... and 10 more results. Use get_more_search_results with sessionId ${id} and offset 50\n`),
        text,
      );
      const all = await readAll(id);
      assert.equal(all.length, 60);
      assert.deepEqual(results, all.slice(0, 50));

      const p1 = textOf(await call('get_more_search_results', { sessionId: id, offset: 0, length: 20 }));
      assert.ok(
        p1.startsWith(`Search session: ${id}\nStatus: COMPLETED\nRuntime: `) &&
          p1.includes('\nTotal results found: 60\nShowing results 0-19\n\nResults:\n'),
        p1,
      );
      assert.deepEqual(parseResults(p1), all.slice(0, 20));
      assert.ok(p1.includes('\n📖 More results available. Use get_more_search_results with offset: 20\n'), p1);
      assert.ok(p1.endsWith('✅ Search completed.'), p1);

      const p3 = textOf(await call('get_more_search_results', { sessionId: id, offset: '50' }));
      assert.ok(p3.includes('Showing results 50-59\n'), p3);
      assert.deepEqual(parseResults(p3), all.slice(50));
      assert.ok(!p3.includes('📖'), p3);

      const tail = textOf(await call('get_more_search_results', { sessionId: id, offset: -5 }));
      assert.ok(tail.includes('Showing last 5 results\n\nResults:\n'), tail);
      assert.deepEqual(parseResults(tail), all.slice(-5));
      assert.ok(!tail.includes('📖'), tail);

      const empty = textOf(await call('get_more_search_results', { sessionId: id, offset: 60 }));
      assert.ok(empty.includes('Total results found: 60\nNo results in this range.\n'), empty);

      const none = await start({ pattern: 'zzz-nothing-zzz' });
      const noneMore = textOf(await call('get_more_search_results', { sessionId: none.id }));
      assert.ok(noneMore.includes('Total results found: 0\nNo matches found.\n'), noneMore);
    });

    test('unknown session ids', async () => {
      const more = await call('get_more_search_results', { sessionId: 'search_999_1' });
      assert.equal(more.isError, true);
      assert.equal(textOf(more), 'Error: Search session search_999_1 not found');
      const stop = await call('stop_search', { sessionId: 'search_999_1' });
      assert.equal(stop.isError, true);
      assert.equal(textOf(stop), 'Error: Search session search_999_1 not found');
    });

    // ----- stop / list -----------------------------------------------------------------------

    test('stop_search on a completed search', async () => {
      const { id } = await start({ pattern: 'auth' });
      assert.equal(textOf(await call('stop_search', { sessionId: id })), `Search session ${id} had already completed.`);
    });

    test('stopping a running search over a big tree', async () => {
      for (const searchType of ['files', 'content']) {
        const session = await search.start({
          root: BIG,
          displayPath: BIG,
          pattern: searchType === 'files' ? 'file' : 'needle',
          searchType,
          ignoreCase: true,
          maxResults: 50000,
          includeHidden: false,
          contextLines: 0,
          literalSearch: false,
          earlyTermination: false,
        });
        assert.equal(session.status, 'running');
        // Stop before yielding to I/O; the tool response is covered by the slow-rg test.
        assert.equal(search.stop(session.id), 'stopped');
        assert.equal(session.status, 'stopped');
        const n = session.results.length;
        assert.ok(n < 4000, `${searchType}: expected a partial result set, got ${n}`);
        await sleep(100);
        assert.equal(session.results.length, n, 'no results are added after stop');
        const list = textOf(await call('list_searches'));
        assert.ok(list.includes(`Session: ${session.id}\n  Type: ${searchType}\n`) && list.includes('⏹️ STOPPED'), list);
        const more = textOf(await call('get_more_search_results', { sessionId: session.id }));
        assert.ok(more.includes('Status: COMPLETED') && more.includes('⏹️ Search was stopped before it finished'), more);
        assert.equal(textOf(await call('stop_search', { sessionId: session.id })), `Search session ${session.id} had already completed.`);
      }
      // the same tree searched to completion
      const full = await start({ path: BIG, searchType: 'content', pattern: 'needle', maxResults: 50000 });
      assert.ok(full.text.includes('Status: COMPLETED') && full.text.includes('Total results: 4000\n'), full.text.slice(0, 400));
    });

    test('list_searches', async () => {
      const fresh = new SearchManager(engine.opts);
      try {
        const t = searchTools(await getCtx(), fresh);
        assert.equal(textOf(await runTool(t, 'list_searches')), 'No active searches.');
        const a = parseResults(textOf(await runTool(t, 'start_search', { path: ROOT, pattern: 'auth' })));
        assert.equal(a.length, 3);
        await runTool(t, 'start_search', { path: ROOT, pattern: 'TODO', searchType: 'content', filePattern: '*.ts' });
        const list1 = textOf(await runTool(t, 'list_searches'));
        assert.match(
          list1,
          /^Search sessions \(2\):\n\nSession: search_\d+_\d+\n {2}Type: files\n {2}Pattern: "auth"\n {2}Status: ✅ COMPLETED\n {2}Runtime: \d+\.\ds\n {2}Results: 3\n\nSession: search_\d+_\d+\n {2}Type: content\n {2}Pattern: "TODO"\n {2}Status: ✅ COMPLETED\n {2}Runtime: \d+\.\ds\n {2}Results: 2$/,
        );
        const runtimes = (s) => [...s.matchAll(/Runtime: (\S+)/g)].map((m) => m[1]);
        await sleep(150);
        assert.deepEqual(runtimes(textOf(await runTool(t, 'list_searches'))), runtimes(list1), 'runtime is frozen at completion');
      } finally {
        fresh.shutdown();
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Engine-specific behaviour
// ---------------------------------------------------------------------------------------------

/** A fake `rg` that records its pid and then never finishes. */
function fakeSlowRg() {
  const pidFile = path.join(SCRATCH, `rg-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`);
  const bin = path.join(SCRATCH, `slow-rg-${path.basename(pidFile, '.pid')}`);
  fs.writeFileSync(bin, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
  return { bin, pidFile };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('ripgrep process handling', { skip: process.platform === 'win32' && 'POSIX shell script fake' }, () => {
  test('a slow search is RUNNING after the initial wait, stop_search kills the process', async () => {
    const { bin, pidFile } = fakeSlowRg();
    const search = new SearchManager({ rgPath: bin });
    try {
      const tools = searchTools(await getCtx(), search);
      const t0 = Date.now();
      const started = textOf(await runTool(tools, 'start_search', { path: ROOT, pattern: 'x', searchType: 'content' }));
      const waited = Date.now() - t0;
      assert.ok(waited >= 1400 && waited < 5000, `start_search waited ${waited}ms`);
      const id = sessionIdOf(started);
      assert.ok(started.includes('Status: RUNNING\n') && started.includes('Engine: ripgrep\n'), started);
      assert.ok(started.endsWith('\n🔄 Search in progress. Use get_more_search_results to get more results.'), started);

      const running = textOf(await runTool(tools, 'get_more_search_results', { sessionId: id }));
      assert.ok(running.includes('Status: IN PROGRESS\n') && running.includes('No results yet, search is still running...'), running);
      assert.ok(running.includes('📖 More results available. Use get_more_search_results with offset: 0'), running);
      assert.ok(!running.includes('✅'), running);
      assert.ok(textOf(await runTool(tools, 'list_searches')).includes('Status: 🔄 RUNNING'));

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(isAlive(pid));
      assert.equal(textOf(await runTool(tools, 'stop_search', { sessionId: id })), `Search session ${id} terminated successfully.`);
      await waitFor(() => !isAlive(pid), { timeout: 5000 });
      assert.ok(textOf(await runTool(tools, 'list_searches')).includes('Status: ⏹️ STOPPED'));
      const after = textOf(await runTool(tools, 'get_more_search_results', { sessionId: id }));
      assert.ok(after.includes('Status: COMPLETED\n') && after.includes('✅ Search completed.'), after);
    } finally {
      search.shutdown();
    }
  });

  test('timeout_ms stops a search and says so', async () => {
    const { bin, pidFile } = fakeSlowRg();
    const search = new SearchManager({ rgPath: bin });
    try {
      const tools = searchTools(await getCtx(), search);
      const t0 = Date.now();
      const out = textOf(
        await runTool(tools, 'start_search', { path: ROOT, pattern: 'x', searchType: 'content', timeout_ms: '300' }),
      );
      const waited = Date.now() - t0;
      assert.ok(waited >= 250 && waited < 1400, `returned after ${waited}ms`);
      assert.ok(out.includes('Status: COMPLETED\n'), out);
      assert.ok(out.includes('⏱️ Search timed out after 300ms and was stopped; results may be incomplete.'), out);
      await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await waitFor(() => !isAlive(pid), { timeout: 5000 });
    } finally {
      search.shutdown();
    }
  });

  test('shutdown() kills running searches', async () => {
    const { bin, pidFile } = fakeSlowRg();
    const search = new SearchManager({ rgPath: bin });
    const session = await search.start({
      root: ROOT, displayPath: ROOT, pattern: 'x', searchType: 'content', ignoreCase: true, maxResults: 10,
      includeHidden: false, contextLines: 0, literalSearch: false, earlyTermination: false,
    });
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    search.shutdown();
    assert.equal(session.status, 'stopped');
    await waitFor(() => !isAlive(pid), { timeout: 5000 });
  });

  test('an unusable ripgrep binary falls back to the built-in engine', async () => {
    const search = new SearchManager({ rgPath: path.join(SCRATCH, 'no-such-rg') });
    try {
      const tools = searchTools(await getCtx(), search);
      const out = textOf(await runTool(tools, 'start_search', { path: ROOT, pattern: 'auth' }));
      assert.ok(out.includes('Status: COMPLETED\n') && out.includes('Engine: built-in\n'), out);
      assert.ok(out.includes('could not be started'), out);
      assert.equal(parseResults(out).length, 3);
    } finally {
      search.shutdown();
    }
  });

  test('ripgrep exit code 2 with results keeps them and warns', { skip: !rgAvailable && 'ripgrep not found' }, async (t) => {
    if (process.getuid?.() === 0) return t.skip('root can read everything');
    const dir = tmpDir('mcpc-search-perm-');
    const locked = path.join(dir, 'locked');
    try {
      write(dir, 'open.txt', 'needle\n');
      write(dir, 'locked/inner.txt', 'needle\n');
      fs.chmodSync(locked, 0o000);
      for (const opts of [{}, { rgPath: null }]) {
        const search = new SearchManager(opts);
        try {
          const tools = searchTools(await getCtx(), search);
          const out = await runTool(tools, 'start_search', { path: dir, pattern: 'needle', searchType: 'content' });
          assert.ok(!out.isError, textOf(out));
          const text = textOf(out);
          assert.deepEqual(parseResults(text).map((r) => path.basename(r.file)), ['open.txt']);
          assert.match(text, /⚠️ Some files could not be searched: .*locked.*(Permission denied|EACCES)/);
        } finally {
          search.shutdown();
        }
      }
    } finally {
      fs.chmodSync(locked, 0o755);
      rmrf(dir);
    }
  });
});

describe('built-in engine', () => {
  test('does not block the event loop on a big tree', async () => {
    const search = new SearchManager({ rgPath: null });
    try {
      let maxGap = 0;
      let last = Date.now();
      const timer = setInterval(() => {
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
      }, 5);
      const session = await search.start({
        root: BIG, displayPath: BIG, pattern: 'needle \\d+-\\d+', searchType: 'content', ignoreCase: true,
        maxResults: 50000, includeHidden: false, contextLines: 1, literalSearch: false, earlyTermination: false,
      });
      await session.done;
      clearInterval(timer);
      assert.equal(session.status, 'completed');
      assert.equal(session.matchCount, 4000);
      assert.ok(maxGap < 250, `event loop blocked for ${maxGap}ms`);
    } finally {
      search.shutdown();
    }
  });

  test('lists exactly what ripgrep lists for complex ignore rules', { skip: !rgAvailable && 'ripgrep not found' }, async () => {
    const dir = tmpDir('mcpc-search-ignore-');
    const w = (r, c = 'x\n') => write(dir, r, c);
    try {
      fs.mkdirSync(path.join(dir, '.git'));
      w('.gitignore', '*.log\n!keep.log\n/top-only.txt\nbuild/\ndocs/*.tmp\n**/cache/**\nfoo/**/bar.txt\n# c\n\\#hash.txt\n*.o\ndironly/\n');
      for (const f of ['a.log', 'keep.log', 'sub/keep.log', 'sub/b.log', 'top-only.txt', 'sub/top-only.txt', 'build/x.js',
        'sub/build/y.js', 'docs/a.tmp', 'docs/deep/b.tmp', 'x/cache/c.txt', 'cache/f.txt', 'foo/bar.txt', 'foo/a/b/bar.txt',
        'foo/baz.txt', '#hash.txt', 'main.o', 'main.c', 'Upper.LOG', 'dironly/file', 'sub/dironly', 'sub/x.c', 'sub/important.c',
        'sub/local.txt', 'sub/deeper/local.txt', 'ignored-by-dotignore.txt', 'sub/ignored-by-dotignore.txt', 'nested/inner.txt',
        'nested/outer.log', '.hidden/h.txt', '.dotfile', 'vis/.dot2']) w(f);
      w('sub/.gitignore', '*.c\n!important.c\n/local.txt\n');
      w('.ignore', 'ignored-by-dotignore.txt\n');
      w('.rgignore', '!a.log\n');
      w('nested/.git/HEAD', 'x');
      w('nested/.gitignore', 'inner.txt\n');
      fs.symlinkSync(path.join(dir, 'main.c'), path.join(dir, 'link.c'));
      fs.symlinkSync(path.join(dir, 'sub'), path.join(dir, 'linkdir'));

      const listing = async (engineOpts, args) => {
        const search = new SearchManager(engineOpts);
        try {
          const out = await runTool(searchTools(await getCtx(), search), 'start_search', { path: dir, pattern: '', ...args });
          assert.ok(!out.isError, textOf(out));
          return parseResults(textOf(out)).map((r) => `${r.kind}:${path.relative(dir, r.file)}`).sort();
        } finally {
          search.shutdown();
        }
      };
      for (const args of [{}, { includeHidden: true }, { filePattern: '*.log' }, { filePattern: '*.txt|!sub/**' }, { filePattern: '!*.txt' }]) {
        const viaRg = await listing({}, args);
        const viaWalker = await listing({ rgPath: null }, args);
        assert.deepEqual(viaWalker, viaRg, JSON.stringify(args));
        if (Object.keys(args).length === 0) {
          assert.deepEqual(viaRg.filter((l) => l.startsWith('file:')), [
            'file:Upper.LOG', 'file:a.log', 'file:docs/deep/b.tmp', 'file:foo/baz.txt', 'file:keep.log', 'file:main.c',
            'file:nested/outer.log', 'file:sub/deeper/local.txt', 'file:sub/dironly', 'file:sub/important.c',
            'file:sub/keep.log', 'file:sub/top-only.txt',
          ]);
        }
      }
    } finally {
      rmrf(dir);
    }
  });

  test('lookaround patterns are matched per line', async () => {
    const search = new SearchManager({ rgPath: null });
    try {
      const tools = searchTools(await getCtx(), search);
      // 'value;' ends its line, so (?!\s) holds there although a newline follows in the file.
      const out = textOf(
        await runTool(tools, 'start_search', { path: path.join(ROOT, 'src/index.ts'), pattern: 'value;(?!\\s)', searchType: 'content' }),
      );
      assert.deepEqual(parseResults(out).map((r) => r.line), [5]);
    } finally {
      search.shutdown();
    }
  });
});

describe('ripgrep resolution', () => {
  const saved = process.env.MCP_COMMANDER_RG;
  after(() => {
    if (saved === undefined) delete process.env.MCP_COMMANDER_RG;
    else process.env.MCP_COMMANDER_RG = saved;
    clearRipgrepCache();
  });

  test('MCP_COMMANDER_RG=none forces the built-in engine, a path is used as given', async () => {
    process.env.MCP_COMMANDER_RG = 'none';
    clearRipgrepCache();
    assert.equal(await resolveRipgrepPath(), null);
    const { bin } = fakeSlowRg();
    process.env.MCP_COMMANDER_RG = bin;
    assert.equal(await resolveRipgrepPath(), bin);
    const search = new SearchManager(); // auto-resolve honours the env var
    try {
      process.env.MCP_COMMANDER_RG = 'none';
      const tools = searchTools(await getCtx(), search);
      const out = textOf(await runTool(tools, 'start_search', { path: ROOT, pattern: 'auth' }));
      assert.ok(out.includes('Engine: built-in\n'), out);
    } finally {
      search.shutdown();
    }
  });

  test('auto-resolution finds @vscode/ripgrep when it is installed', async (t) => {
    delete process.env.MCP_COMMANDER_RG;
    clearRipgrepCache();
    let vscodeRg = null;
    try {
      vscodeRg = (await import('@vscode/ripgrep')).rgPath;
    } catch {
      /* optional dependency missing */
    }
    const found = await resolveRipgrepPath();
    if (!vscodeRg || !fs.existsSync(vscodeRg)) {
      if (!found) return t.skip('no ripgrep on this machine');
      assert.ok(fs.existsSync(found));
      return;
    }
    assert.equal(found, vscodeRg);
  });
});

describe('engine robustness', () => {
  const ENGINE_OPTS = [
    ...(rgAvailable ? [{ name: 'ripgrep', opts: {} }] : []),
    { name: 'built-in', opts: { rgPath: null } },
  ];
  /** start_search with a throwaway manager; returns the tool result and its text. */
  const searchWith = async (opts, args) => {
    const search = new SearchManager(opts);
    try {
      const r = await runTool(searchTools(await getCtx(), search), 'start_search', args);
      return { r, text: textOf(r) };
    } finally {
      search.shutdown();
    }
  };
  const hits = (dir, text) => parseResults(text).map((r) => `${r.kind}:${path.relative(dir, r.file)}${r.line ? `:${r.line}` : ''}`).sort();

  test('both engines skip node_modules, unless the path is inside it', async () => {
    const dir = tmpDir('mcpc-search-nm-'); // not a git repository: no .gitignore hides node_modules
    try {
      write(dir, 'a.js', 'needle a\n');
      write(dir, 'node_modules/pkg/index.js', 'needle nm\n');
      write(dir, 'lib/node_modules/deep/x.js', 'needle deep\n');
      for (const { name, opts } of ENGINE_OPTS) {
        const content = await searchWith(opts, { path: dir, pattern: 'needle', searchType: 'content' });
        assert.deepEqual(hits(dir, content.text), ['match:a.js:1'], `${name}: ${content.text}`);
        const files = await searchWith(opts, { path: dir, pattern: 'js', filePattern: '*.js' });
        assert.deepEqual(hits(dir, files.text), ['file:a.js'], `${name}: ${files.text}`);
        const inside = await searchWith(opts, { path: path.join(dir, 'node_modules'), pattern: 'needle', searchType: 'content' });
        assert.deepEqual(hits(dir, inside.text), ['match:node_modules/pkg/index.js:1'], `${name}: ${inside.text}`);
      }
    } finally {
      rmrf(dir);
    }
  });

  test('both engines decode UTF-16 files that start with a byte-order mark', async () => {
    const dir = tmpDir('mcpc-search-u16-');
    const le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
    const be = (s) => {
      const b = Buffer.from(s, 'utf16le');
      for (let i = 0; i < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1], b[i]];
      return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
    };
    try {
      write(dir, 'le.txt', le('first\r\nutf16le needle ąč\r\n'));
      write(dir, 'be.txt', be('first\nutf16be needle 🎉\n'));
      write(dir, 'nul.txt', le('a\u0000b needle\n')); // binary once decoded
      write(dir, 'nobom.txt', Buffer.from('needle without bom\n', 'utf16le')); // binary: NUL bytes
      for (const { name, opts } of ENGINE_OPTS) {
        const { text } = await searchWith(opts, { path: dir, pattern: 'needle', searchType: 'content' });
        assert.deepEqual(hits(dir, text), ['match:be.txt:2', 'match:le.txt:2'], `${name}: ${text}`);
        assert.ok(text.includes(`📄 ${path.join(dir, 'le.txt')}:2 - utf16le needle ąč\n`), `${name}: ${text}`);
        assert.ok(text.includes(`📄 ${path.join(dir, 'be.txt')}:2 - utf16be needle 🎉\n`), `${name}: ${text}`);
      }
    } finally {
      rmrf(dir);
    }
  });

  test('an unreadable subdirectory is a warning in both engines, not a failed search', { skip: process.platform === 'win32' && 'POSIX permissions' }, async (t) => {
    if (process.getuid?.() === 0) return t.skip('root can read everything');
    const dir = tmpDir('mcpc-search-lockedonly-');
    const locked = path.join(dir, 'locked');
    try {
      write(dir, 'locked/inner.txt', 'needle\n');
      fs.chmodSync(locked, 0o000);
      for (const { name, opts } of ENGINE_OPTS) {
        for (const args of [{ searchType: 'content', pattern: 'needle' }, { pattern: 'inner' }]) {
          const { r, text } = await searchWith(opts, { path: dir, ...args });
          assert.ok(!r.isError, `${name} ${args.searchType ?? 'files'}: ${text}`);
          assert.ok(text.includes('Status: COMPLETED\n') && text.includes('No matches found.'), `${name}: ${text}`);
          assert.match(text, /⚠️ Some files could not be searched: .*locked.*(Permission denied|EACCES)/, `${name}: ${text}`);
        }
      }
    } finally {
      fs.chmodSync(locked, 0o755);
      rmrf(dir);
    }
  });

  test('a search root that cannot be entered does not switch later searches off ripgrep', { skip: (!rgAvailable && 'ripgrep not found') || (process.platform === 'win32' && 'POSIX permissions') }, async (t) => {
    if (process.getuid?.() === 0) return t.skip('root can read everything');
    const dir = tmpDir('mcpc-search-lockedroot-');
    const locked = path.join(dir, 'locked');
    const search = new SearchManager(); // auto-resolved binary, as in the server
    try {
      write(dir, 'locked/inner.txt', 'needle\n');
      fs.chmodSync(locked, 0o000);
      const tools = searchTools(await getCtx(), search);
      const denied = await runTool(tools, 'start_search', { path: locked, pattern: 'needle', searchType: 'content' });
      assert.equal(denied.isError, true, textOf(denied));
      assert.match(textOf(denied), /locked: Permission denied/);
      assert.notEqual(await resolveRipgrepPath(), null, 'ripgrep must stay usable');
      const next = textOf(await runTool(tools, 'start_search', { path: ROOT, pattern: 'auth' }));
      assert.ok(next.includes('Engine: ripgrep\n'), next);
    } finally {
      search.shutdown();
      fs.chmodSync(locked, 0o755);
      rmrf(dir);
      clearRipgrepCache();
    }
  });

  test('a pattern too long for a command line falls back without leaking a RUNNING session', { skip: (!rgAvailable && 'ripgrep not found') || (process.platform === 'win32' && 'command-line limits differ') }, async () => {
    const search = new SearchManager();
    try {
      const tools = searchTools(await getCtx(), search);
      const huge = 'x'.repeat(4 * 1024 * 1024); // > ARG_MAX on macOS, > MAX_ARG_STRLEN on Linux
      const r = await runTool(tools, 'start_search', { path: ROOT, pattern: huge, searchType: 'content', literalSearch: true });
      const text = textOf(r);
      assert.ok(!text.includes('E2BIG') || text.includes('built-in engine'), text.slice(0, 500));
      if (r.isError) assert.ok(text.length < 2000, `error text is ${text.length} chars`);
      else assert.ok(text.includes('Engine: built-in\n'), text.slice(0, 500));
      await waitFor(() => search.list().every((s) => s.isComplete), { timeout: 5000 });
      assert.ok(!textOf(await runTool(tools, 'list_searches')).includes('RUNNING'));
      assert.notEqual(await resolveRipgrepPath(), null, 'ripgrep must stay usable');
      const next = textOf(await runTool(tools, 'start_search', { path: ROOT, pattern: 'auth' }));
      assert.ok(next.includes('Engine: ripgrep\n'), next);
    } finally {
      search.shutdown();
      clearRipgrepCache();
    }
  });

  /** Runs a shell script through runRipgrep's line splitter. */
  const viaSplitter = (script, opts) =>
    new Promise((resolve, reject) => {
      const lines = [];
      const long = [];
      runRipgrep('/bin/sh', ['-c', script], SCRATCH, {
        onLine: (l) => lines.push(l),
        onLongLine: (head, length) => long.push({ head, length }),
        onExit: () => resolve({ lines, long }),
        onSpawnError: reject,
      }, opts);
    });

  test('ripgrep output: a very long line is split in linear time', { skip: process.platform === 'win32' && 'POSIX shell' }, async () => {
    const n = 60 * 1024 * 1024;
    const file = path.join(SCRATCH, 'one-long-line.txt');
    fs.writeFileSync(file, `${'a'.repeat(n)}\nend\ntail`);
    const t0 = Date.now();
    const { lines, long } = await viaSplitter(`cat '${file}'`);
    const ms = Date.now() - t0;
    fs.rmSync(file);
    assert.deepEqual(long, []);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].length, n);
    assert.deepEqual(lines.slice(1), ['end', 'tail']);
    assert.ok(ms < 8000, `splitting took ${ms}ms`); // re-scanning the growing buffer took ~40s
  });

  test('ripgrep output: lines over the limit are skipped and reported', { skip: process.platform === 'win32' && 'POSIX shell' }, async () => {
    const big = `{"type":"match","data":{"path":{"text":"/tmp/big.txt"},"lines":{"text":"${'a'.repeat(5000)}"}}}`;
    const { lines, long } = await viaSplitter(
      `printf '%s\\nshort\\n' '${big}'; printf 'x%.0s' $(seq 1 3000); printf '\\nlast'`,
      { maxLineChars: 1000 },
    );
    assert.deepEqual(lines, ['short', 'last']);
    assert.equal(long.length, 2);
    assert.ok(long[0].head.startsWith('{"type":"match","data":{"path":{"text":"/tmp/big.txt"}'), long[0].head.slice(0, 80));
    assert.equal(long[0].length, big.length);
    assert.equal(long[1].length, 3000);

    // Through the manager: the dropped match becomes a warning naming its file.
    const data = path.join(SCRATCH, 'long-line.jsonl');
    const small = path.join(ROOT, 'src/index.ts');
    fs.writeFileSync(data, [
      JSON.stringify({ type: 'match', data: { path: { text: '/tmp/big.txt' }, lines: { text: `${'b'.repeat(6000)} needle\n` }, line_number: 1, submatches: [] } }),
      JSON.stringify({ type: 'match', data: { path: { text: small }, lines: { text: 'needle here\n' }, line_number: 4, submatches: [] } }),
    ].join('\n') + '\n');
    const bin = path.join(SCRATCH, 'long-line-rg');
    fs.writeFileSync(bin, `#!/bin/sh\ncat '${data}'\n`, { mode: 0o755 });
    const search = new SearchManager({ rgPath: bin, rgMaxLineChars: 2000 });
    try {
      const out = textOf(await runTool(searchTools(await getCtx(), search), 'start_search', { path: ROOT, pattern: 'needle', searchType: 'content' }));
      assert.deepEqual(parseResults(out), [{ kind: 'match', file: small, line: 4, text: 'needle here' }]);
      assert.ok(out.includes('⚠️ Some files could not be searched: /tmp/big.txt: a line of about 6 KB is too long to report; skipped'), out);
    } finally {
      search.shutdown();
    }
  });
});

describe('through a real MCP client', () => {
  test('tools are registered in order and arguments are coerced', async () => {
    const { searchTools: st } = await load('tools/search.js');
    const names = st(await getCtx(), new SearchManager({ rgPath: null })).map((d) => d.name);
    assert.deepEqual(names, ['start_search', 'get_more_search_results', 'stop_search', 'list_searches']);

    const mcp = await connectInMemory();
    try {
      const { tools } = await mcp.client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      for (const n of names) assert.ok(byName[n], `${n} registered`);
      const props = Object.keys(byName.start_search.inputSchema.properties ?? {});
      for (const p of ['path', 'pattern', 'searchType', 'filePattern', 'ignoreCase', 'maxResults', 'includeHidden',
        'contextLines', 'timeout_ms', 'literalSearch', 'earlyTermination']) {
        assert.ok(props.includes(p), `start_search.${p} in schema`);
      }
      for (const [n, d] of Object.entries(byName)) {
        if (!names.includes(n)) continue;
        assert.equal(d.description, d.description.trim());
        for (const [p, s] of Object.entries(d.inputSchema.properties ?? {})) assert.ok(s.description, `${n}.${p} has a description`);
      }

      const r = await mcp.call('start_search', {
        path: ROOT,
        pattern: 'AUTH',
        ignoreCase: 'true',
        maxResults: '2',
        bogus: 1,
      });
      assert.ok(!r.isError, JSON.stringify(r));
      assert.match(r.content[0].text, /not supported by this tool, which were ignored: bogus/);
      const text = r.content.map((c) => c.text).join('\n');
      assert.ok(text.includes('Total results: 2\n') && text.includes('Result limit reached (maxResults=2)'), text);
      const id = sessionIdOf(text);
      const more = await mcp.call('get_more_search_results', { sessionId: id, offset: '-1' });
      assert.ok(textOf(more).includes('Showing last 1 results'), textOf(more));
      const ctxRes = await mcp.call('start_search', {
        path: path.join(ROOT, 'src'),
        pattern: 'const value',
        searchType: 'content',
        contextLines: '1',
      });
      assert.equal(parseResults(textOf(ctxRes)).length, 3, textOf(ctxRes));
      assert.ok(textOf(await mcp.call('list_searches')).startsWith('Search sessions (2):'));
    } finally {
      await mcp.close();
    }
  });
});
