// Tests for src/tools/edit.ts (edit_block) and the pure fuzzy-matching functions in src/tools/fuzzy.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { load, makeCtx, rmrf, runTool, textOf, tmpDir } from './helpers.js';

const { editTools, findOccurrences, detectLineEnding, normalizeLineEndings, buildPreview } = await load('tools/edit.js');
const fuzzy = await load('tools/fuzzy.js');

const RECOMMENDATION =
  'RECOMMENDATION: For large search/replace operations, consider breaking them into smaller chunks with fewer lines.';

async function call(defs, args) {
  const def = defs.find((d) => d.name === 'edit_block');
  return runTool(defs, 'edit_block', z.object(def.inputSchema).passthrough().parse(args));
}

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rand, maxLen, alphabet) {
  const n = Math.floor(rand() * (maxLen + 1));
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

const numbered = (n) => Array.from({ length: n }, (_, i) => `L${i}: text`);

describe('edit_block', () => {
  let env;
  let dir;
  let tools;
  before(async () => {
    env = await makeCtx();
    dir = tmpDir('mcpc-edit-');
    tools = editTools(env.ctx);
  });
  after(() => {
    rmrf(dir);
    env.cleanup();
  });
  let n = 0;
  const file = (content, name = `f${n++}.txt`) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  test('is the only tool, with described params', () => {
    assert.deepEqual(tools.map((t) => t.name), ['edit_block']);
    for (const [k, s] of Object.entries(tools[0].inputSchema)) assert.ok(s.description, k);
    assert.equal(tools[0].description, tools[0].description.trim());
  });

  test('single exact replacement with the read_file-style preview', async () => {
    const p = file(numbered(30).join('\n') + '\n');
    const r = await call(tools, { file_path: p, old_string: 'L15: text', new_string: 'L15: CHANGED' });
    assert.equal(r.isError, undefined);
    const expectedLines = numbered(30);
    expectedLines[15] = 'L15: CHANGED';
    assert.equal(
      textOf(r),
      `Successfully applied 1 edit(s) to ${p}\n\n[Reading 21 lines from line 5 (total: 30 lines, 4 remaining)]\n\n` +
        expectedLines.slice(5, 26).join('\n'),
    );
    assert.equal(fs.readFileSync(p, 'utf8'), expectedLines.join('\n') + '\n');
  });

  test('preview near the start, multi-line replacement', async () => {
    const p = file(numbered(40).join('\n') + '\n');
    const r = await call(tools, { file_path: p, old_string: 'L10: text\nL11: text', new_string: 'A\nB\nC' });
    const after = [...numbered(10), 'A', 'B', 'C', ...numbered(40).slice(12)];
    assert.equal(
      textOf(r),
      `Successfully applied 1 edit(s) to ${p}\n\n[Reading 23 lines from start (total: 41 lines, 18 remaining)]\n\n` + after.slice(0, 23).join('\n'),
    );
    assert.equal(fs.readFileSync(p, 'utf8'), after.join('\n') + '\n');
  });

  test('deletion (empty new_string)', async () => {
    const p = file('keep\ndrop me\nkeep too\n');
    const r = await call(tools, { file_path: p, old_string: 'drop me\n', new_string: '' });
    assert.match(textOf(r), /^Successfully applied 1 edit\(s\) to /);
    assert.equal(fs.readFileSync(p, 'utf8'), 'keep\nkeep too\n');
  });

  test('expected_replacements replaces exactly that many (numeric string accepted)', async () => {
    const p = file('x = 1;\ny = 2;\nx = 1;\nz = 3;\nx = 1;\n');
    const r = await call(tools, { file_path: p, old_string: 'x = 1;', new_string: 'x = 9;', expected_replacements: '3' });
    assert.match(textOf(r), new RegExp(`^Successfully applied 3 edit\\(s\\) to ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n\\[Reading 5 lines from start \\(total: 5 lines, 0 remaining\\)\\]`));
    assert.equal(fs.readFileSync(p, 'utf8'), 'x = 9;\ny = 2;\nx = 9;\nz = 3;\nx = 9;\n');
  });

  test('count mismatch is an error listing the lines, and changes nothing', async () => {
    const content = 'foo\nbar\nfoo\nbaz\nfoo\n';
    const p = file(content);
    const r = await call(tools, { file_path: p, old_string: 'foo', new_string: 'qux' });
    assert.equal(r.isError, true);
    assert.equal(
      textOf(r),
      `Error: Expected 1 occurrences but found 3 in ${p} (at lines 1, 3, 5). If you want to replace all 3 occurrences, ` +
        'set expected_replacements to 3. To replace a specific occurrence, make old_string more unique by including more surrounding lines.',
    );
    const r2 = await call(tools, { file_path: p, old_string: 'foo', new_string: 'qux', expected_replacements: 5 });
    assert.match(textOf(r2), /^Error: Expected 5 occurrences but found 3 in /);
    assert.equal(fs.readFileSync(p, 'utf8'), content);
  });

  test('occurrences are counted without overlap (matches what is replaced)', async () => {
    const p = file('aaa');
    const r = await call(tools, { file_path: p, old_string: 'aa', new_string: 'X', expected_replacements: 2 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /^Error: Expected 2 occurrences but found 1 in .* \(at lines 1\)/);
    assert.equal(fs.readFileSync(p, 'utf8'), 'aaa');
    await call(tools, { file_path: p, old_string: 'aa', new_string: 'X' });
    assert.equal(fs.readFileSync(p, 'utf8'), 'Xa');
    assert.deepEqual(findOccurrences('aaaa', 'aa'), [0, 2]);
    assert.deepEqual(findOccurrences('abcabc', 'x'), []);
  });

  test('CRLF files: LF old/new strings are normalized and endings preserved', async () => {
    const p = file('one\r\ntwo\r\nthree\r\n');
    const r = await call(tools, { file_path: p, old_string: 'one\ntwo', new_string: 'uno\ndos\nextra' });
    assert.equal(
      textOf(r),
      `Successfully applied 1 edit(s) to ${p}\n\n[Reading 4 lines from start (total: 4 lines, 0 remaining)]\n\nuno\ndos\nextra\nthree`,
    );
    assert.equal(fs.readFileSync(p, 'utf8'), 'uno\r\ndos\r\nextra\r\nthree\r\n');
  });

  test('CR-only files and CRLF old_string on an LF file', async () => {
    const cr = file('a\rb\rc');
    await call(tools, { file_path: cr, old_string: 'a\nb', new_string: 'x\ny' });
    assert.equal(fs.readFileSync(cr, 'utf8'), 'x\ry\rc');
    const lf = file('a\nb\nc\n');
    await call(tools, { file_path: lf, old_string: 'a\r\nb', new_string: 'B\r\nA' });
    assert.equal(fs.readFileSync(lf, 'utf8'), 'B\nA\nc\n');
    assert.equal(detectLineEnding('no endings'), '\n');
    assert.equal(detectLineEnding('x\r\ny\n'), '\r\n');
    assert.equal(detectLineEnding('x\ry\r\n'), '\r');
    assert.equal(normalizeLineEndings('a\r\nb\rc\nd', '\r\n'), 'a\r\nb\r\nc\r\nd');
  });

  test('mixed line endings: regions using another style still match, keeping their own endings', async () => {
    const p = file('a\r\nb\nc\nd\r\n');
    const r = await call(tools, { file_path: p, old_string: 'b\nc', new_string: 'B\nC\nC2' });
    assert.equal(
      textOf(r),
      `Successfully applied 1 edit(s) to ${p}\n\n[Reading 5 lines from start (total: 5 lines, 0 remaining)]\n\na\nB\nC\nC2\nd`,
    );
    assert.equal(fs.readFileSync(p, 'utf8'), 'a\r\nB\nC\nC2\nd\r\n');
    const span = file('a\r\nb\nc\nd\r\n');
    await call(tools, { file_path: span, old_string: 'a\nb\nc', new_string: 'X\nY' });
    assert.equal(fs.readFileSync(span, 'utf8'), 'X\r\nY\nd\r\n');
    const multi = file('k\r\nx\ny\nx\ny\n');
    const m = await call(tools, { file_path: multi, old_string: 'x\ny', new_string: 'z' });
    assert.match(textOf(m), /^Error: Expected 1 occurrences but found 2 in .* \(at lines 2, 4\)/);
  });

  test('old/new that differ only in line endings are identical after normalization', async () => {
    const p = file('a\r\nb\r\n');
    const r = await call(tools, { file_path: p, old_string: 'a\nb', new_string: 'a\r\nb' });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), 'Error: old_string and new_string are identical — nothing to change');
  });

  test('UTF-8 BOM is preserved', async () => {
    const p = file(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('labas pasauli\n')]));
    await call(tools, { file_path: p, old_string: 'pasauli', new_string: 'rytas' });
    const raw = fs.readFileSync(p);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(raw.subarray(3).toString('utf8'), 'labas rytas\n');
  });

  test('UTF-16LE (and BE) files are decoded and re-encoded', async () => {
    const p = file(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('grüß dich\r\nzweite\r\n', 'utf16le')]));
    const r = await call(tools, { file_path: p, old_string: 'dich\nzweite', new_string: 'euch\nzwei' });
    assert.match(textOf(r), /^Successfully applied 1 edit\(s\)/);
    const raw = fs.readFileSync(p);
    assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe]);
    assert.equal(raw.subarray(2).toString('utf16le'), 'grüß euch\r\nzwei\r\n');

    const be = file(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('ab\n', 'utf16le').swap16()]));
    await call(tools, { file_path: be, old_string: 'ab', new_string: 'čd' });
    const rawBe = fs.readFileSync(be);
    assert.deepEqual([...rawBe.subarray(0, 2)], [0xfe, 0xff]);
    assert.equal(Buffer.from(rawBe.subarray(2)).swap16().toString('utf16le'), 'čd\n');
  });

  test('warns when the search or replacement text exceeds fileWriteLineLimit', async () => {
    env.ctx.config.set('fileWriteLineLimit', 2);
    try {
      const p = file(numbered(5).join('\n') + '\n');
      const r = await call(tools, { file_path: p, old_string: 'L1: text', new_string: 'a\nb\nc\nd' });
      assert.ok(textOf(r).endsWith(`\n\nWARNING: The replacement text has 4 lines (maximum: 2).\n${RECOMMENDATION}`), textOf(r));
      const r2 = await call(tools, { file_path: p, old_string: 'a\nb\nc', new_string: 'abc' });
      assert.ok(textOf(r2).endsWith(`\n\nWARNING: The search text has 3 lines (maximum: 2).\n${RECOMMENDATION}`), textOf(r2));
      const r3 = await call(tools, { file_path: p, old_string: 'abc', new_string: 'x\ny' });
      assert.ok(!textOf(r3).includes('WARNING'));
    } finally {
      env.ctx.config.set('fileWriteLineLimit', 50);
    }
  });

  test('parameter and file-type errors', async () => {
    const p = file('content\n');
    const cases = [
      [{ file_path: p, old_string: '', new_string: 'x' }, /^Error: old_string must not be empty/],
      [{ file_path: p, old_string: 'content', new_string: 'content' }, /^Error: old_string and new_string are identical — nothing to change$/],
      [{ file_path: path.join(dir, 'missing.txt'), old_string: 'a', new_string: 'b' }, new RegExp(`^Error: File not found: .*missing\\.txt$`)],
      [{ file_path: dir, old_string: 'a', new_string: 'b' }, /^Error: Cannot edit a directory: /],
    ];
    for (const [args, re] of cases) {
      const r = await call(tools, args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(textOf(r), re);
    }
    const bin = file(Buffer.from([0x61, 0x00, 0x62]), 'x.bin');
    assert.match(textOf(await call(tools, { file_path: bin, old_string: 'a', new_string: 'b' })), /^Error: Cannot edit binary file: /);
    const png = file(
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
      'i.png',
    );
    assert.match(textOf(await call(tools, { file_path: png, old_string: 'a', new_string: 'b' })), /^Error: Cannot edit image file: /);
    const latin1 = file(Buffer.from('café au lait\n', 'latin1'), 'latin1.txt');
    const r = await call(tools, { file_path: latin1, old_string: 'au', new_string: 'with' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /not valid UTF-8/);
    assert.deepEqual(fs.readFileSync(latin1), Buffer.from('café au lait\n', 'latin1'));
    const schema = z.object(tools[0].inputSchema);
    assert.equal(schema.safeParse({ file_path: p, old_string: 'a', new_string: 'b', expected_replacements: 0 }).success, false);
  });

  test('similar text (>= 70%) is reported with a diff and never applied', async () => {
    const content =
      'function greet(name) {\n  const message = "Hello, " + name;\n  console.log(message);\n  return message;\n}\n';
    const p = file(content, 'greet.js');
    const r = await call(tools, {
      file_path: p,
      old_string: '  const mesage = "Hello, " + name;\n  console.log(mesage);',
      new_string: 'replaced',
    });
    assert.equal(r.isError, true);
    const t = textOf(r);
    assert.match(t, /^Error: Exact match not found, but found a similar text with 9\d% similarity at line 2 \(found in \d+ms\):\n\nDifferences:\n/);
    assert.ok(t.includes('  const mes{-'), t);
    assert.ok(t.includes('-}{+'), t);
    assert.ok(
      t.endsWith('\n\nFound text (copy it exactly if this is the text you meant):\n  const message = "Hello, " + name;\n  console.log(message);'),
      t,
    );
    assert.equal(fs.readFileSync(p, 'utf8'), content);
  });

  test('fuzzy search on CRLF files reports the right line', async () => {
    const p = file('alpha\r\nbeta gamma delta\r\nepsilon\r\n');
    const r = await call(tools, { file_path: p, old_string: 'beta gama delta', new_string: 'x' });
    assert.match(textOf(r), /similarity at line 2 /);
    assert.ok(textOf(r).endsWith(':\nbeta gamma delta'));
  });

  test('dissimilar text (< 70%) says not found with the closest match', async () => {
    const p = file('the quick brown fox\njumps over the lazy dog\n');
    const r = await call(tools, { file_path: p, old_string: 'completely unrelated sentence', new_string: 'x' });
    assert.equal(r.isError, true);
    assert.match(
      textOf(r),
      new RegExp(`^Error: Search content not found in ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. The closest match was "[^]*" with only \\d+% similarity, which is below the 70% threshold\\.$`),
    );
    const empty = file('');
    const r2 = await call(tools, { file_path: empty, old_string: 'abc', new_string: 'x' });
    assert.equal(textOf(r2), `Error: Search content not found in ${empty}. The closest match was "" with only 0% similarity, which is below the 70% threshold.`);
  });

  test('finds a slightly wrong block deep inside a larger file', async () => {
    const all = Array.from({ length: 3000 }, (_, i) => `const value_${i} = compute(${i}, "payload number ${i}");`);
    const p = file(all.join('\n') + '\n', 'big.js');
    const wanted = all.slice(1700, 1703).join('\n').replace('payload number 1701', 'payload numbr 1701');
    const r = await call(tools, { file_path: p, old_string: wanted, new_string: 'x' });
    assert.match(textOf(r), /^Error: Exact match not found, but found a similar text with 99% similarity at line 1701 /);
    assert.ok(textOf(r).endsWith(`:\n${all.slice(1700, 1703).join('\n')}`));
  });

  test('files over 2MB skip the fuzzy search', async () => {
    const p = file('abcdefghij\n'.repeat(200 * 1024), 'huge.txt');
    const r = await call(tools, { file_path: p, old_string: 'not-in-there', new_string: 'x' });
    assert.equal(r.isError, true);
    assert.equal(
      textOf(r),
      `Error: Search content not found in ${p}. (The file is larger than 2MB, so no fuzzy search was run; use read_file or a search tool to find the exact text.)`,
    );
  });

  test('allowedDirectories: outside paths and escaping symlinks are denied', async () => {
    const allowed = path.join(dir, 'allowed');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'secret value\n');
    const link = path.join(allowed, 'link.txt');
    fs.symlinkSync(secret, link);
    const inside = path.join(allowed, 'ok.txt');
    fs.writeFileSync(inside, 'ok value\n');
    env.ctx.config.set('allowedDirectories', [allowed]);
    try {
      for (const fp of [secret, link]) {
        const r = await call(tools, { file_path: fp, old_string: 'value', new_string: 'changed' });
        assert.equal(r.isError, true);
        assert.equal(textOf(r), `Error: Path not allowed: ${fp}. Must be within one of these directories: ${allowed}`);
      }
      assert.equal(fs.readFileSync(secret, 'utf8'), 'secret value\n');
      assert.match(textOf(await call(tools, { file_path: inside, old_string: 'value', new_string: 'changed' })), /^Successfully/);
    } finally {
      env.ctx.config.set('allowedDirectories', []);
    }
  });

  test('buildPreview counts lines like read_file (no phantom trailing line)', () => {
    assert.equal(buildPreview('a\nb\n', 0, 'a'), '[Reading 2 lines from start (total: 2 lines, 0 remaining)]\n\na\nb');
    assert.equal(buildPreview('', 0, ''), '[Reading 0 lines from start (total: 0 lines, 0 remaining)]\n\n');
  });
});

describe('fuzzy: pure functions', () => {
  const ALPHABETS = ['ab', 'abcd', 'abcdefghijklmnopqrstuvwxyz \n', 'aą čę🎉éé'];

  test('Myers levenshtein matches the two-row DP (random, all block sizes)', () => {
    const rand = rng(1234);
    for (let k = 0; k < 600; k++) {
      const alphabet = ALPHABETS[k % ALPHABETS.length];
      const maxLen = k % 3 === 0 ? 150 : 40;
      const a = randomString(rand, maxLen, alphabet);
      const b = rand() < 0.3 ? a.slice(0, Math.floor(rand() * a.length)) + randomString(rand, 5, alphabet) : randomString(rand, maxLen, alphabet);
      assert.equal(fuzzy.levenshtein(a, b), fuzzy.levenshteinDP(a, b), JSON.stringify([a, b]));
    }
    assert.equal(fuzzy.levenshtein('kitten', 'sitting'), 3);
    assert.equal(fuzzy.levenshtein('', 'abc'), 3);
    assert.equal(fuzzy.levenshtein('abc', ''), 3);
    assert.equal(fuzzy.levenshtein('same', 'same'), 0);
    const long = 'x'.repeat(33) + 'y'.repeat(31) + 'z'.repeat(40);
    assert.equal(fuzzy.levenshtein(long, long.replace('xy', 'xq')), 1);
  });

  test('prefixDistances[j] = levenshtein(pattern, text[0:j])', () => {
    const rand = rng(99);
    for (let k = 0; k < 150; k++) {
      const alphabet = ALPHABETS[k % ALPHABETS.length];
      const pattern = randomString(rand, k % 2 ? 70 : 20, alphabet);
      const text = randomString(rand, 60, alphabet);
      const d = fuzzy.prefixDistances(pattern, text);
      assert.equal(d.length, text.length + 1);
      for (let j = 0; j <= text.length; j++) assert.equal(d[j], fuzzy.levenshteinDP(pattern, text.slice(0, j)));
    }
  });

  test('fast iterativeReduction equals the original step-by-step shrink', () => {
    const rand = rng(7);
    for (let k = 0; k < 200; k++) {
      const alphabet = ALPHABETS[k % ALPHABETS.length];
      const text = randomString(rand, 80, alphabet);
      const query = randomString(rand, 25, alphabet);
      const start = Math.floor(rand() * (text.length + 1));
      const end = start + Math.floor(rand() * (text.length - start + 1));
      assert.deepEqual(fuzzy.iterativeReduction(text, query, start, end), fuzzy.iterativeReductionNaive(text, query, start, end));
    }
  });

  test('bestSubstringMatch finds the minimum distance over all substrings', () => {
    const rand = rng(42);
    for (let k = 0; k < 120; k++) {
      const alphabet = ALPHABETS[k % ALPHABETS.length];
      const text = randomString(rand, 40, alphabet);
      const query = randomString(rand, 12, alphabet) || 'q';
      let min = Infinity;
      for (let i = 0; i <= text.length; i++) {
        for (let j = i; j <= text.length; j++) min = Math.min(min, fuzzy.levenshteinDP(text.slice(i, j), query));
      }
      const m = fuzzy.bestSubstringMatch(text, query);
      assert.equal(m.distance, min, JSON.stringify([text, query]));
      assert.equal(m.value, text.slice(m.start, m.end));
      assert.equal(fuzzy.levenshteinDP(m.value, query), m.distance);
    }
  });

  test('recursiveFuzzyIndexOf returns a consistent match; findClosestMatch is never worse', () => {
    const rand = rng(5);
    for (let k = 0; k < 100; k++) {
      const alphabet = ALPHABETS[k % ALPHABETS.length];
      const text = randomString(rand, 300, alphabet);
      const query = randomString(rand, 20, alphabet) || 'q';
      const m = fuzzy.recursiveFuzzyIndexOf(text, query);
      assert.equal(m.value, text.slice(m.start, m.end));
      assert.equal(fuzzy.levenshtein(m.value, query), m.distance);
      const c = fuzzy.findClosestMatch(text, query);
      assert.equal(fuzzy.levenshtein(c.value, query), c.distance);
      assert.ok(fuzzy.similarity(query, c.value) >= fuzzy.similarity(query, m.value));
    }
  });

  test('exact substrings are found with distance 0', () => {
    const text = 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor';
    const m = fuzzy.findClosestMatch(text, 'consectetur adipiscing');
    assert.equal(m.distance, 0);
    assert.equal(m.start, text.indexOf('consectetur adipiscing'));
  });

  test('similarity and highlightDifferences formats', () => {
    assert.equal(fuzzy.similarity('', ''), 1);
    assert.equal(fuzzy.similarity('abc', 'abd'), 1 - 1 / 3);
    assert.equal(fuzzy.getSimilarityRatio('abcd', 'abcd'), 1);
    assert.equal(fuzzy.FUZZY_THRESHOLD, 0.7);
    assert.equal(fuzzy.highlightDifferences('abcdef', 'abXdef'), 'ab{-c-}{+X+}def');
    assert.equal(fuzzy.highlightDifferences('hello world', 'hello there world'), 'hello {--}{+there +}world');
    assert.equal(fuzzy.highlightDifferences('same', 'same'), 'same{--}{++}');
    assert.equal(fuzzy.highlightDifferences('abc', 'xyz'), '{-abc-}{+xyz+}');
    // never splits a surrogate pair
    assert.equal(fuzzy.highlightDifferences('a😀b', 'a😃b'), 'a{-😀-}{+😃+}b');
  });

  test('runFuzzySearch runs in a worker and honours its timeout', async () => {
    const m = await fuzzy.runFuzzySearch('alpha beta gamma', 'beta gama', 10000);
    assert.equal(m.value.startsWith('beta gam'), true);
    const big = 'abcdefghijklmnopqrstuvwxyz'.repeat(60000);
    const query = 'the quick brown fox jumps over the lazy dog '.repeat(60);
    await assert.rejects(fuzzy.runFuzzySearch(big, query, 20), (err) => err instanceof fuzzy.FuzzyTimeoutError && /timed out after 20ms/.test(err.message));
  });
});
