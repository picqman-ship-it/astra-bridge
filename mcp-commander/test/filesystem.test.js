// Tests for src/tools/filesystem.ts and the src/files/* helpers it uses.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { load, makeCtx, rmrf, runTool, textOf, tmpDir } from './helpers.js';

const { filesystemTools, moveAcrossDevices } = await load('tools/filesystem.js');
const { readLocal, readUrl } = await load('files/read.js');
const { looksBinary } = await load('files/detect.js');

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff, 0xd9]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0, 0x3b])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.alloc(8, 1)]);

/** Parses args with the tool's own zod shape (defaults + coercion, like server.ts), then runs it. */
async function call(defs, name, args = {}) {
  const def = defs.find((d) => d.name === name);
  assert.ok(def, `tool ${name} exists`);
  const parsed = z.object(def.inputSchema).passthrough().parse(args);
  return runTool(defs, name, parsed);
}

function lines(n, prefix = 'line') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function setup(overrides = {}) {
  let env;
  const state = {};
  before(async () => {
    env = await makeCtx(overrides);
    state.ctx = env.ctx;
    state.dir = tmpDir('mcpc-fs-');
    state.tools = filesystemTools(env.ctx);
  });
  after(() => {
    rmrf(state.dir);
    env.cleanup();
  });
  return state;
}

describe('tool list', () => {
  const s = setup();
  test('exports the seven filesystem tools in order, with described params', () => {
    assert.deepEqual(
      s.tools.map((t) => t.name),
      ['read_file', 'read_multiple_files', 'write_file', 'create_directory', 'list_directory', 'move_file', 'get_file_info'],
    );
    for (const t of s.tools) {
      assert.equal(t.description, t.description.trim(), `${t.name} description has no padding`);
      assert.ok(t.description.length > 40, `${t.name} has a real description`);
      for (const [key, schema] of Object.entries(t.inputSchema)) {
        assert.ok(schema.description, `${t.name}.${key} has a description`);
      }
    }
  });
});

describe('read_file: text pagination', () => {
  const s = setup();
  let ten;
  before(() => {
    ten = path.join(s.dir, 'ten.txt');
    fs.writeFileSync(ten, lines(10).join('\n') + '\n');
  });

  test('full read with the exact header', async () => {
    const r = await call(s.tools, 'read_file', { path: ten });
    assert.equal(r.isError, undefined);
    assert.equal(textOf(r), `[Reading 10 lines from start (total: 10 lines, 0 remaining)]\n\n${lines(10).join('\n')}`);
  });

  test('offset + length window, remaining count and continuation hint', async () => {
    const r = await call(s.tools, 'read_file', { path: ten, offset: 3, length: 4 });
    assert.equal(
      textOf(r),
      '[Reading 4 lines from line 3 (total: 10 lines, 3 remaining)]\n\nline3\nline4\nline5\nline6' +
        '\n\n[... 3 more lines. Call read_file with offset=7 to continue]',
    );
    const r0 = await call(s.tools, 'read_file', { path: ten, length: 4 });
    assert.equal(
      textOf(r0),
      '[Reading 4 lines from start (total: 10 lines, 6 remaining)]\n\nline0\nline1\nline2\nline3' +
        '\n\n[... 6 more lines. Call read_file with offset=4 to continue]',
    );
  });

  test('numeric strings are coerced (models send them)', async () => {
    const r = await call(s.tools, 'read_file', { path: ten, offset: '8', length: '5' });
    assert.equal(textOf(r), '[Reading 2 lines from line 8 (total: 10 lines, 0 remaining)]\n\nline8\nline9');
  });

  test('offset past the end returns 0 lines', async () => {
    const r = await call(s.tools, 'read_file', { path: ten, offset: 20 });
    assert.equal(textOf(r), '[Reading 0 lines from line 20 (total: 10 lines, 0 remaining)]\n\n');
  });

  test('negative offset reads the tail and ignores length', async () => {
    const r = await call(s.tools, 'read_file', { path: ten, offset: -3, length: 1 });
    assert.equal(textOf(r), '[Reading last 3 lines (total: 10 lines)]\n\nline7\nline8\nline9');
    const all = await call(s.tools, 'read_file', { path: ten, offset: -50 });
    assert.equal(textOf(all), `[Reading last 10 lines (total: 10 lines)]\n\n${lines(10).join('\n')}`);
  });

  test('default length is fileReadLineLimit read at call time', async () => {
    s.ctx.config.set('fileReadLineLimit', 4);
    try {
      const r = await call(s.tools, 'read_file', { path: ten });
      assert.match(textOf(r), /^\[Reading 4 lines from start \(total: 10 lines, 6 remaining\)\]/);
      s.ctx.config.set('fileReadLineLimit', 7);
      const r2 = await call(s.tools, 'read_file', { path: ten });
      assert.match(textOf(r2), /^\[Reading 7 lines from start \(total: 10 lines, 3 remaining\)\]/);
    } finally {
      s.ctx.config.set('fileReadLineLimit', 1000);
    }
  });

  test('line counting: empty file, trailing terminator, blank last line', async () => {
    const cases = [
      ['', 0, []],
      ['a', 1, ['a']],
      ['a\nb', 2, ['a', 'b']],
      ['a\nb\n', 2, ['a', 'b']],
      ['a\n\n', 2, ['a', '']],
      ['\n', 1, ['']],
    ];
    for (const [content, total, want] of cases) {
      const p = path.join(s.dir, 'count.txt');
      fs.writeFileSync(p, content);
      const r = await call(s.tools, 'read_file', { path: p });
      assert.equal(
        textOf(r),
        `[Reading ${total} lines from start (total: ${total} lines, 0 remaining)]\n\n${want.join('\n')}`,
        JSON.stringify(content),
      );
    }
  });

  test('CRLF, CR-only and mixed line endings are split and stripped', async () => {
    const p = path.join(s.dir, 'eol.txt');
    fs.writeFileSync(p, 'a\r\nb\r\nc\r\n');
    assert.equal(textOf(await call(s.tools, 'read_file', { path: p })), '[Reading 3 lines from start (total: 3 lines, 0 remaining)]\n\na\nb\nc');
    fs.writeFileSync(p, 'a\rb\rc');
    assert.equal(textOf(await call(s.tools, 'read_file', { path: p })), '[Reading 3 lines from start (total: 3 lines, 0 remaining)]\n\na\nb\nc');
    fs.writeFileSync(p, 'a\nb\r\nc\rd');
    assert.equal(textOf(await call(s.tools, 'read_file', { path: p, offset: -2 })), '[Reading last 2 lines (total: 4 lines)]\n\nc\nd');
  });

  test('UTF-8 BOM is stripped, UTF-16LE is decoded', async () => {
    const p = path.join(s.dir, 'bom.txt');
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ąčę\nšų\n')]));
    assert.equal(textOf(await call(s.tools, 'read_file', { path: p })), '[Reading 2 lines from start (total: 2 lines, 0 remaining)]\n\nąčę\nšų');
    const u16 = path.join(s.dir, 'u16.txt');
    fs.writeFileSync(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo\r\nwörld 🎉\r\n', 'utf16le')]));
    assert.equal(
      textOf(await call(s.tools, 'read_file', { path: u16 })),
      '[Reading 2 lines from start (total: 2 lines, 0 remaining)]\n\nhéllo\nwörld 🎉',
    );
  });

  test('lines longer than 20000 chars are truncated with a marker', async () => {
    const p = path.join(s.dir, 'long.txt');
    fs.writeFileSync(p, 'short\n' + 'x'.repeat(20005) + '\nend\n');
    const r = await call(s.tools, 'read_file', { path: p });
    assert.equal(
      textOf(r),
      `[Reading 3 lines from start (total: 3 lines, 0 remaining)]\n\nshort\n${'x'.repeat(20000)}… [line truncated, 5 more chars]\nend`,
    );
  });

  test('streamed reads (large-file path) match in-memory reads exactly', async () => {
    const contents = [
      lines(50).join('\n') + '\n',
      lines(50).join('\r\n'),
      lines(7).join('\r') + '\r',
      'a\n' + 'y'.repeat(25000) + '\nb',
      '',
      '\n\n\n',
      'no newline at all',
    ];
    const windows = [
      [0, 1000],
      [0, 3],
      [2, 2],
      [5, 10],
      [40, 100],
      [49, 1],
      [100, 5],
      [-1, 0],
      [-3, 0],
      [-100, 0],
    ];
    const p = path.join(s.dir, 'stream.txt');
    for (const content of contents) {
      for (const enc of ['utf8', 'utf8bom', 'utf16le']) {
        let buf = Buffer.from(content, enc === 'utf16le' ? 'utf16le' : 'utf8');
        if (enc === 'utf8bom') buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
        if (enc === 'utf16le') buf = Buffer.concat([Buffer.from([0xff, 0xfe]), buf]);
        fs.writeFileSync(p, buf);
        for (const [offset, length] of windows) {
          const mem = await readLocal(p, p, { offset, length });
          const streamed = await readLocal(p, p, { offset, length, streamThreshold: 0 });
          assert.deepEqual(streamed, mem, `${JSON.stringify(content.slice(0, 20))} ${enc} offset=${offset} length=${length}`);
        }
      }
    }
  });
});

describe('read_file: directories, images, binary, errors', () => {
  const s = setup();

  test('a directory is not an error: notice + depth-2 listing', async () => {
    const d = path.join(s.dir, 'tree');
    fs.mkdirSync(path.join(d, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a.txt'), 'a');
    fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'b');
    fs.writeFileSync(path.join(d, 'sub', 'deeper', 'c.txt'), 'c');
    const r = await call(s.tools, 'read_file', { path: d });
    assert.equal(r.isError, undefined);
    assert.equal(
      textOf(r),
      'This is a directory, not a file. Use the list_directory tool instead of read_file for directories.\n\n' +
        ['[FILE] a.txt', '[DIR] sub', `[FILE] ${path.join('sub', 'b.txt')}`, `[DIR] ${path.join('sub', 'deeper')}`].join('\n'),
    );
  });

  test('png/jpeg/gif/webp come back as image blocks', async () => {
    for (const [name, bytes, mime] of [
      ['pic.png', PNG, 'image/png'],
      ['pic.JPG', JPEG, 'image/jpeg'],
      ['pic.jpeg', JPEG, 'image/jpeg'],
      ['pic.gif', GIF, 'image/gif'],
      ['pic.webp', WEBP, 'image/webp'],
    ]) {
      const p = path.join(s.dir, name);
      fs.writeFileSync(p, bytes);
      const r = await call(s.tools, 'read_file', { path: p, offset: 5, length: 1 });
      assert.equal(r.isError, undefined, name);
      assert.deepEqual(r.content, [
        { type: 'text', text: `Image file: ${p} (${mime})\n` },
        { type: 'image', data: bytes.toString('base64'), mimeType: mime },
      ]);
    }
  });

  test('images over 10MB are an error', async () => {
    const p = path.join(s.dir, 'huge.png');
    fs.writeFileSync(p, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    const r = await call(s.tools, 'read_file', { path: p });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /^Error: Image file too large: .*huge\.png \(\d+ bytes; images are limited to 10MB\)$/);
  });

  test('svg is text, not an image block', async () => {
    const p = path.join(s.dir, 'icon.svg');
    fs.writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg">\n<rect/>\n</svg>\n');
    const r = await call(s.tools, 'read_file', { path: p });
    assert.equal(r.content.length, 1);
    assert.equal(textOf(r), '[Reading 3 lines from start (total: 3 lines, 0 remaining)]\n\n<svg xmlns="http://www.w3.org/2000/svg">\n<rect/>\n</svg>');
  });

  test('a .png that is not really an image is read as what it is', async () => {
    const p = path.join(s.dir, 'fake.png');
    fs.writeFileSync(p, 'just text\n');
    const r = await call(s.tools, 'read_file', { path: p });
    assert.equal(textOf(r), '[Reading 1 lines from start (total: 1 lines, 0 remaining)]\n\njust text');
  });

  test('binary files get the non-error notice (NUL, %PDF-, bmp, high-byte noise)', async () => {
    const noise = Buffer.alloc(4000);
    for (let i = 0; i < noise.length; i++) noise[i] = 0x80 + ((i * 37) % 0x7f); // no NULs, invalid UTF-8
    const cases = [
      ['data.bin', Buffer.from([0x41, 0x42, 0x00, 0x43, 0x44])],
      ['doc.pdf', Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n')],
      ['pic.bmp', Buffer.concat([Buffer.from('BM'), Buffer.alloc(60)])],
      ['noise.dat', noise],
    ];
    for (const [name, bytes] of cases) {
      const p = path.join(s.dir, name);
      fs.writeFileSync(p, bytes);
      const r = await call(s.tools, 'read_file', { path: p });
      assert.equal(r.isError, undefined, name);
      assert.equal(
        textOf(r),
        `Cannot read binary file as text: ${name} (${bytes.length} bytes)\n\n` +
          'Use start_process with tools like xxd, file, or a Python/Node script to inspect binary files.',
      );
    }
  });

  test('binary heuristic: multibyte UTF-8 and ANSI escapes are text; UTF-16 BOM beats NULs', () => {
    assert.equal(looksBinary(Buffer.from('Ąžuolas — 日本語のテキスト 🎉\n'.repeat(50))), false);
    assert.equal(looksBinary(Buffer.from('\x1b[31mred\x1b[0m\tok\r\n\f\v\x07')), false);
    assert.equal(looksBinary(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])), false);
    assert.equal(looksBinary(Buffer.from('hi', 'utf16le')), true);
    assert.equal(looksBinary(Buffer.alloc(0)), false);
    // 5% invalid bytes stays text, 20% is binary.
    const mostly = Buffer.from('a'.repeat(95) + '\x01\x02\x03\x04\x05', 'latin1');
    assert.equal(looksBinary(mostly), false);
    const lots = Buffer.from('a'.repeat(80) + '\x01'.repeat(20), 'latin1');
    assert.equal(looksBinary(lots), true);
    // A multibyte sequence cut off by the sample boundary is fine only when the sample is truncated.
    const cut = Buffer.from('abc' + 'é').subarray(0, 4);
    assert.equal(looksBinary(cut, true), false);
  });

  test('missing file -> File not found', async () => {
    const p = path.join(s.dir, 'nope.txt');
    const r = await call(s.tools, 'read_file', { path: p });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: File not found: ${p}`);
  });

  test('unreadable file -> Permission denied (+ Full Disk Access hint on macOS)', { skip: isRoot }, async () => {
    const p = path.join(s.dir, 'locked.txt');
    fs.writeFileSync(p, 'secret');
    fs.chmodSync(p, 0o000);
    try {
      const r = await call(s.tools, 'read_file', { path: p });
      assert.equal(r.isError, true);
      const t = textOf(r);
      assert.ok(t.startsWith(`Error: Permission denied: ${p}`), t);
      if (process.platform === 'darwin') assert.match(t, /System Settings > Privacy & Security > Full Disk Access/);
    } finally {
      fs.chmodSync(p, 0o644);
    }
  });
});

describe('allowedDirectories enforcement', () => {
  const s = setup();
  let allowed;
  let outside;
  before(() => {
    allowed = path.join(s.dir, 'allowed');
    outside = path.join(s.dir, 'outside');
    fs.mkdirSync(allowed);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(allowed, 'in.txt'), 'inside\n');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(allowed, 'escape.txt'));
    fs.symlinkSync(outside, path.join(allowed, 'escape-dir'));
    fs.symlinkSync(path.join(allowed, 'in.txt'), path.join(allowed, 'ok-link.txt'));
    fs.symlinkSync(path.join(outside, 'not-yet.txt'), path.join(allowed, 'dangling.txt'));
    s.ctx.config.set('allowedDirectories', [allowed]);
  });
  const denied = (p) => `Error: Path not allowed: ${p}. Must be within one of these directories: ${allowed}`;

  test('reads inside are allowed, outside are denied', async () => {
    assert.match(textOf(await call(s.tools, 'read_file', { path: path.join(allowed, 'in.txt') })), /inside$/);
    const p = path.join(outside, 'secret.txt');
    const r = await call(s.tools, 'read_file', { path: p });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), denied(p));
  });

  test('a symlink inside the allowed dir that points outside is denied', async () => {
    for (const p of [path.join(allowed, 'escape.txt'), path.join(allowed, 'escape-dir', 'secret.txt')]) {
      const r = await call(s.tools, 'read_file', { path: p });
      assert.equal(r.isError, true, p);
      assert.equal(textOf(r), denied(p));
    }
    const lst = await call(s.tools, 'list_directory', { path: path.join(allowed, 'escape-dir') });
    assert.equal(lst.isError, true);
    const ok = await call(s.tools, 'read_file', { path: path.join(allowed, 'ok-link.txt') });
    assert.match(textOf(ok), /inside$/);
  });

  test('writes through escaping symlinks (existing or dangling) are denied and create nothing', async () => {
    const r1 = await call(s.tools, 'write_file', { path: path.join(allowed, 'escape.txt'), content: 'x', mode: 'rewrite' });
    assert.equal(r1.isError, true);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n');
    const r2 = await call(s.tools, 'write_file', { path: path.join(allowed, 'dangling.txt'), content: 'x' });
    assert.equal(r2.isError, true);
    assert.match(textOf(r2), /^Error: Path not allowed: .*dangling\.txt \(a symbolic link to .*not-yet\.txt\)/);
    assert.equal(fs.existsSync(path.join(outside, 'not-yet.txt')), false);
    const r3 = await call(s.tools, 'write_file', { path: path.join(allowed, 'escape-dir', 'new.txt'), content: 'x' });
    assert.equal(r3.isError, true);
    assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  });

  test('every tool checks its path params', async () => {
    const o = path.join(outside, 'secret.txt');
    const checks = [
      ['read_multiple_files', { paths: [o] }],
      ['write_file', { path: path.join(outside, 'w.txt'), content: 'x' }],
      ['create_directory', { path: path.join(outside, 'newdir') }],
      ['list_directory', { path: outside }],
      ['move_file', { source: o, destination: path.join(allowed, 'moved.txt') }],
      ['move_file', { source: path.join(allowed, 'in.txt'), destination: path.join(outside, 'moved.txt') }],
      ['get_file_info', { path: o }],
    ];
    for (const [name, args] of checks) {
      const r = await call(s.tools, name, args);
      const t = textOf(r);
      assert.match(t, /Path not allowed: /, `${name} ${JSON.stringify(args)}`);
      if (name !== 'read_multiple_files') assert.equal(r.isError, true, name);
    }
    assert.equal(fs.existsSync(path.join(outside, 'newdir')), false);
    assert.equal(fs.existsSync(path.join(outside, 'w.txt')), false);
    assert.equal(fs.existsSync(path.join(allowed, 'in.txt')), true);
  });

  test('config changes apply on the next call', async () => {
    const p = path.join(outside, 'secret.txt');
    s.ctx.config.set('allowedDirectories', []);
    try {
      assert.match(textOf(await call(s.tools, 'read_file', { path: p })), /secret$/);
    } finally {
      s.ctx.config.set('allowedDirectories', [allowed]);
    }
    assert.equal((await call(s.tools, 'read_file', { path: p })).isError, true);
  });
});

describe('read_file: URLs', () => {
  const s = setup();
  let server;
  let base;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(lines(5, 'row').join('\n') + '\n');
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"a": 1}');
      } else if (req.url === '/img') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
      } else if (req.url === '/slow') {
        // never answers
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    s.ctx.config.set('allowedDirectories', [s.dir]); // URLs are not path-checked
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test('text bodies are paginated like files', async () => {
    const url = `${base}/text`;
    const r = await call(s.tools, 'read_file', { path: url });
    assert.equal(textOf(r), `[Reading 5 lines from start (total: 5 lines, 0 remaining)]\n\n${lines(5, 'row').join('\n')}`);
    const page = await call(s.tools, 'read_file', { path: url, offset: 1, length: 2 });
    assert.equal(
      textOf(page),
      '[Reading 2 lines from line 1 (total: 5 lines, 2 remaining)]\n\nrow1\nrow2\n\n[... 2 more lines. Call read_file with offset=3 to continue]',
    );
    const tail = await call(s.tools, 'read_file', { path: url, offset: -1 });
    assert.equal(textOf(tail), '[Reading last 1 lines (total: 5 lines)]\n\nrow4');
    const json = await call(s.tools, 'read_file', { path: `${base}/json`, isUrl: true });
    assert.equal(textOf(json), '[Reading 1 lines from start (total: 1 lines, 0 remaining)]\n\n{"a": 1}');
  });

  test('image content types become image blocks', async () => {
    const url = `${base}/img`;
    const r = await call(s.tools, 'read_file', { path: url });
    assert.deepEqual(r.content, [
      { type: 'text', text: `Image file: ${url} (image/png)\n` },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
    ]);
  });

  test('HTTP errors are reported with the status', async () => {
    const r = await call(s.tools, 'read_file', { path: `${base}/missing` });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), 'Error: Failed to fetch URL: HTTP error! Status: 404');
  });

  test('connection failures are reported', async () => {
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const port = closed.address().port;
    await new Promise((r) => closed.close(r));
    const r = await call(s.tools, 'read_file', { path: `http://127.0.0.1:${port}/x` });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /^Error: Failed to fetch URL: /);
  });

  test('timeouts produce the timeout message', async () => {
    const url = `${base}/slow`;
    await assert.rejects(readUrl(url, { offset: 0, length: 10, timeoutMs: 150 }), {
      message: `URL fetch timed out after 150ms: ${url}`,
    });
  });
});

describe('read_multiple_files', () => {
  const s = setup();
  test('summary first, then each readable file; failures never fail the call', async () => {
    const a = path.join(s.dir, 'a.txt');
    const img = path.join(s.dir, 'b.png');
    const bin = path.join(s.dir, 'c.bin');
    const missing = path.join(s.dir, 'missing.txt');
    fs.writeFileSync(a, 'one\ntwo\n');
    fs.writeFileSync(img, PNG);
    fs.writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
    const r = await call(s.tools, 'read_multiple_files', { paths: [a, img, missing, bin] });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.content, [
      {
        type: 'text',
        text: [`${a}: text/plain (text)`, `${img}: image/png (image)`, `${missing}: Error - File not found: ${missing}`, `${bin}: binary`].join('\n'),
      },
      { type: 'text', text: `\n--- ${a} contents: ---\n[Reading 2 lines from start (total: 2 lines, 0 remaining)]\n\none\ntwo` },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
      {
        type: 'text',
        text:
          `\n--- ${bin} contents: ---\nCannot read binary file as text: c.bin (4 bytes)\n\n` +
          'Use start_process with tools like xxd, file, or a Python/Node script to inspect binary files.',
      },
    ]);
  });

  test('uses fileReadLineLimit and accepts a JSON-encoded array', async () => {
    const p = path.join(s.dir, 'many.txt');
    fs.writeFileSync(p, lines(10).join('\n'));
    s.ctx.config.set('fileReadLineLimit', 3);
    try {
      const r = await call(s.tools, 'read_multiple_files', { paths: JSON.stringify([p]) });
      assert.equal(
        r.content[1].text,
        `\n--- ${p} contents: ---\n[Reading 3 lines from start (total: 10 lines, 7 remaining)]\n\nline0\nline1\nline2` +
          '\n\n[... 7 more lines. Call read_file with offset=3 to continue]',
      );
    } finally {
      s.ctx.config.set('fileReadLineLimit', 1000);
    }
  });

  test('rejects an empty list and more than 50 paths', () => {
    const def = s.tools.find((t) => t.name === 'read_multiple_files');
    const schema = z.object(def.inputSchema);
    assert.equal(schema.safeParse({ paths: [] }).success, false);
    assert.equal(schema.safeParse({ paths: Array(51).fill('/x') }).success, false);
    assert.equal(schema.safeParse({ paths: Array(50).fill('/x') }).success, true);
  });
});

describe('write_file', () => {
  const s = setup();

  test('creates missing parent directories and reports the line count', async () => {
    const p = path.join(s.dir, 'new', 'deep', 'file.txt');
    const r = await call(s.tools, 'write_file', { path: p, content: 'a\nb\nc' });
    assert.equal(r.isError, undefined);
    assert.equal(textOf(r), `Successfully wrote to ${p} (3 lines)`);
    assert.equal(fs.readFileSync(p, 'utf8'), 'a\nb\nc');
    const p2 = path.join(s.dir, 'trailing.txt');
    // Same counting as read_file: a trailing newline does not start another line.
    assert.equal(textOf(await call(s.tools, 'write_file', { path: p2, content: 'a\n' })), `Successfully wrote to ${p2} (1 line)`);
  });

  test('refuses to overwrite existing content when mode is omitted', async () => {
    const p = path.join(s.dir, 'guarded.txt');
    fs.writeFileSync(p, 'precious');
    const r = await call(s.tools, 'write_file', { path: p, content: 'oops' });
    assert.equal(r.isError, true);
    assert.equal(
      textOf(r),
      `Error: Write rejected to prevent accidental data loss: ${p} already exists with content (8 bytes), and no 'mode' was specified — ` +
        "the default mode 'rewrite' would REPLACE the entire file. Retry with an explicit mode: 'append' to add your content to the " +
        "end of the existing file, or 'rewrite' to replace all existing content.",
    );
    assert.equal(fs.readFileSync(p, 'utf8'), 'precious');
    // null / "" for mode means "omitted" too.
    assert.equal((await call(s.tools, 'write_file', { path: p, content: 'oops', mode: null })).isError, true);
    assert.equal((await call(s.tools, 'write_file', { path: p, content: 'oops', mode: '' })).isError, true);
    assert.equal(fs.readFileSync(p, 'utf8'), 'precious');
  });

  test('empty existing files are not guarded', async () => {
    const p = path.join(s.dir, 'empty.txt');
    fs.writeFileSync(p, '');
    assert.equal(textOf(await call(s.tools, 'write_file', { path: p, content: 'x' })), `Successfully wrote to ${p} (1 line)`);
  });

  test('rewrite replaces, append adds raw content', async () => {
    const p = path.join(s.dir, 'modes.txt');
    fs.writeFileSync(p, 'old content\n');
    assert.equal(textOf(await call(s.tools, 'write_file', { path: p, content: 'first', mode: 'rewrite' })), `Successfully wrote to ${p} (1 line)`);
    assert.equal(textOf(await call(s.tools, 'write_file', { path: p, content: 'second\nthird', mode: 'append' })), `Successfully appended to ${p} (2 lines)`);
    assert.equal(fs.readFileSync(p, 'utf8'), 'firstsecond\nthird');
    const fresh = path.join(s.dir, 'append-new.txt');
    assert.equal(textOf(await call(s.tools, 'write_file', { path: fresh, content: 'x', mode: 'append' })), `Successfully appended to ${fresh} (1 line)`);
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'x');
  });

  test('appending to a UTF-16LE file keeps its encoding', async () => {
    const p = path.join(s.dir, 'u16-append.txt');
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab\n', 'utf16le')]));
    await call(s.tools, 'write_file', { path: p, content: 'čd\n', mode: 'append' });
    assert.equal(textOf(await call(s.tools, 'read_file', { path: p })), '[Reading 2 lines from start (total: 2 lines, 0 remaining)]\n\nab\nčd');
  });

  test('adds a chunking tip above fileWriteLineLimit', async () => {
    s.ctx.config.set('fileWriteLineLimit', 3);
    try {
      const p = path.join(s.dir, 'big.txt');
      const r = await call(s.tools, 'write_file', { path: p, content: lines(5).join('\n'), mode: 'rewrite' });
      assert.equal(
        textOf(r),
        `Successfully wrote to ${p} (5 lines)\n\n💡 Tip: this write had 5 lines (limit 3). For large files write in chunks: ` +
          "first call with mode 'rewrite', then mode 'append' for the rest.",
      );
      const ok = await call(s.tools, 'write_file', { path: p, content: 'a\nb\nc', mode: 'rewrite' });
      assert.equal(textOf(ok), `Successfully wrote to ${p} (3 lines)`);
    } finally {
      s.ctx.config.set('fileWriteLineLimit', 50);
    }
  });

  test('a directory target is an error', async () => {
    const d = path.join(s.dir, 'adir');
    fs.mkdirSync(d);
    const r = await call(s.tools, 'write_file', { path: d, content: 'x', mode: 'rewrite' });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: Cannot write to ${d}: it is a directory`);
  });

  test('a file in the parent path is an error', async () => {
    const f = path.join(s.dir, 'plain.txt');
    fs.writeFileSync(f, 'x');
    const r = await call(s.tools, 'write_file', { path: path.join(f, 'child.txt'), content: 'x' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /a parent path component is not a directory/);
  });
});

describe('create_directory', () => {
  const s = setup();
  test('mkdir -p, idempotent, file in the way is an error', async () => {
    const d = path.join(s.dir, 'x', 'y', 'z');
    assert.equal(textOf(await call(s.tools, 'create_directory', { path: d })), `Successfully created directory ${d}`);
    assert.ok(fs.statSync(d).isDirectory());
    assert.equal(textOf(await call(s.tools, 'create_directory', { path: d })), `Directory already exists: ${d}`);
    const f = path.join(s.dir, 'file');
    fs.writeFileSync(f, '');
    const r = await call(s.tools, 'create_directory', { path: f });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: Cannot create directory ${f}: a file with that name already exists`);
    const under = await call(s.tools, 'create_directory', { path: path.join(f, 'sub') });
    assert.equal(under.isError, true);
    assert.match(textOf(under), /a parent path component is not a directory/);
  });
});

describe('list_directory', () => {
  const s = setup();
  let root;
  before(() => {
    root = path.join(s.dir, 'root');
    fs.mkdirSync(path.join(root, 'adir', 'inner', 'innermost'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Zdir'));
    fs.writeFileSync(path.join(root, 'b.txt'), '');
    fs.writeFileSync(path.join(root, 'A.txt'), '');
    fs.writeFileSync(path.join(root, 'c'), '');
    fs.writeFileSync(path.join(root, 'adir', 'x.txt'), '');
    fs.writeFileSync(path.join(root, 'adir', 'inner', 'y.txt'), '');
    fs.writeFileSync(path.join(root, 'Zdir', 'z.txt'), '');
    fs.symlinkSync(path.join(root, 'adir'), path.join(root, 'link-to-adir'));
  });

  test('default depth 2: sorted case-insensitively, children after their dir, links not followed', async () => {
    const r = await call(s.tools, 'list_directory', { path: root });
    assert.equal(r.isError, undefined);
    assert.equal(
      textOf(r),
      [
        '[FILE] A.txt',
        '[DIR] adir',
        `[DIR] ${path.join('adir', 'inner')}`,
        `[FILE] ${path.join('adir', 'x.txt')}`,
        '[FILE] b.txt',
        '[FILE] c',
        `[LINK] link-to-adir -> ${path.join(root, 'adir')}`,
        '[DIR] Zdir',
        `[FILE] ${path.join('Zdir', 'z.txt')}`,
      ].join('\n'),
    );
  });

  test('depth 1 lists direct children only; deeper depths recurse', async () => {
    const one = await call(s.tools, 'list_directory', { path: root, depth: '1' });
    assert.equal(
      textOf(one),
      ['[FILE] A.txt', '[DIR] adir', '[FILE] b.txt', '[FILE] c', `[LINK] link-to-adir -> ${path.join(root, 'adir')}`, '[DIR] Zdir'].join('\n'),
    );
    const four = textOf(await call(s.tools, 'list_directory', { path: root, depth: 4 }));
    assert.ok(four.includes(`[DIR] ${path.join('adir', 'inner', 'innermost')}`));
    assert.ok(four.includes(`[FILE] ${path.join('adir', 'inner', 'y.txt')}`));
    const three = textOf(await call(s.tools, 'list_directory', { path: root, depth: 3 }));
    assert.ok(three.includes(`[FILE] ${path.join('adir', 'inner', 'y.txt')}`));
  });

  test('nested dirs show 100 entries plus a warning; the top level caps at 1000', async () => {
    const big = path.join(s.dir, 'big');
    fs.mkdirSync(path.join(big, 'sub'), { recursive: true });
    for (let i = 0; i < 105; i++) fs.writeFileSync(path.join(big, 'sub', `f${String(i).padStart(3, '0')}`), '');
    const out = textOf(await call(s.tools, 'list_directory', { path: big })).split('\n');
    assert.equal(out.length, 1 + 100 + 1);
    assert.equal(out[0], '[DIR] sub');
    assert.equal(out[100], `[FILE] ${path.join('sub', 'f099')}`);
    assert.equal(out[101], '[WARNING] sub: 5 items hidden (showing first 100 of 105 total)');

    const wide = path.join(s.dir, 'wide');
    fs.mkdirSync(wide);
    for (let i = 0; i < 1003; i++) fs.writeFileSync(path.join(wide, `w${String(i).padStart(4, '0')}`), '');
    const wideOut = textOf(await call(s.tools, 'list_directory', { path: wide, depth: 1 })).split('\n');
    assert.equal(wideOut.length, 1001);
    assert.equal(wideOut[999], '[FILE] w0999');
    assert.equal(wideOut[1000], '[WARNING] wide: 3 items hidden (showing first 1000 of 1003 total)');
  });

  test('unreadable subdirectories are marked [DENIED]', { skip: isRoot }, async () => {
    const d = path.join(s.dir, 'denied');
    fs.mkdirSync(path.join(d, 'locked'), { recursive: true });
    fs.writeFileSync(path.join(d, 'locked', 'hidden.txt'), '');
    fs.chmodSync(path.join(d, 'locked'), 0o000);
    try {
      const r = await call(s.tools, 'list_directory', { path: d });
      assert.equal(r.isError, undefined);
      assert.equal(textOf(r), '[DIR] locked\n[DENIED] locked — not accessible');
    } finally {
      fs.chmodSync(path.join(d, 'locked'), 0o755);
    }
  });

  test('missing root, file root and empty dir', async () => {
    const missing = path.join(s.dir, 'missing-dir');
    const r1 = await call(s.tools, 'list_directory', { path: missing });
    assert.equal(r1.isError, true);
    assert.equal(textOf(r1), `Error: Directory not found: ${missing}`);
    const r2 = await call(s.tools, 'list_directory', { path: path.join(root, 'b.txt') });
    assert.equal(r2.isError, true);
    assert.equal(textOf(r2), `Error: Not a directory: ${path.join(root, 'b.txt')}`);
    const empty = path.join(s.dir, 'empty-dir');
    fs.mkdirSync(empty);
    assert.equal(textOf(await call(s.tools, 'list_directory', { path: empty })), '(empty directory)');
  });
});

describe('move_file', () => {
  const s = setup();

  test('renames, creating the destination parent', async () => {
    const src = path.join(s.dir, 'src.txt');
    const dst = path.join(s.dir, 'nested', 'dir', 'dst.txt');
    fs.writeFileSync(src, 'payload');
    const r = await call(s.tools, 'move_file', { source: src, destination: dst });
    assert.equal(textOf(r), `Successfully moved ${src} to ${dst}`);
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'payload');
  });

  test('never overwrites an existing destination', async () => {
    const a = path.join(s.dir, 'a.txt');
    const b = path.join(s.dir, 'b.txt');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    const r = await call(s.tools, 'move_file', { source: a, destination: b });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: Destination already exists: ${b}`);
    assert.equal(fs.readFileSync(a, 'utf8'), 'A');
    assert.equal(fs.readFileSync(b, 'utf8'), 'B');
    // a dangling symlink at the destination also counts as existing
    const dangling = path.join(s.dir, 'dangling-dst');
    fs.symlinkSync(path.join(s.dir, 'nowhere'), dangling);
    assert.equal(textOf(await call(s.tools, 'move_file', { source: a, destination: dangling })), `Error: Destination already exists: ${dangling}`);
  });

  test('moves a symlink itself, not its target', async () => {
    const target = path.join(s.dir, 'target.txt');
    const link = path.join(s.dir, 'link.txt');
    const moved = path.join(s.dir, 'links', 'moved-link.txt');
    fs.writeFileSync(target, 'T');
    fs.symlinkSync(target, link);
    const r = await call(s.tools, 'move_file', { source: link, destination: moved });
    assert.equal(textOf(r), `Successfully moved ${link} to ${moved}`);
    assert.equal(fs.existsSync(link), false);
    assert.ok(fs.lstatSync(moved).isSymbolicLink());
    assert.equal(fs.readlinkSync(moved), target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'T');
  });

  test('missing source, moving a directory into itself', async () => {
    const missing = path.join(s.dir, 'ghost.txt');
    const r = await call(s.tools, 'move_file', { source: missing, destination: path.join(s.dir, 'x.txt') });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: Source not found: ${missing}`);
    const d = path.join(s.dir, 'selfdir');
    fs.mkdirSync(d);
    const r2 = await call(s.tools, 'move_file', { source: d, destination: path.join(d, 'inside') });
    assert.equal(r2.isError, true);
    assert.match(textOf(r2), /into itself/);
  });

  test('moves directories', async () => {
    const d = path.join(s.dir, 'dir-src');
    fs.mkdirSync(path.join(d, 'k'), { recursive: true });
    fs.writeFileSync(path.join(d, 'k', 'f.txt'), 'f');
    const dst = path.join(s.dir, 'dir-dst');
    assert.equal(textOf(await call(s.tools, 'move_file', { source: d, destination: dst })), `Successfully moved ${d} to ${dst}`);
    assert.equal(fs.readFileSync(path.join(dst, 'k', 'f.txt'), 'utf8'), 'f');
  });

  test('cross-device fallback copies (links verbatim) and removes the source', async () => {
    const src = path.join(s.dir, 'xdev');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'f.txt'), 'data');
    fs.symlinkSync('sub/f.txt', path.join(src, 'rel-link'));
    const dst = path.join(s.dir, 'xdev-dst');
    await moveAcrossDevices(src, dst);
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.readFileSync(path.join(dst, 'sub', 'f.txt'), 'utf8'), 'data');
    assert.equal(fs.readlinkSync(path.join(dst, 'rel-link')), 'sub/f.txt');
  });
});

describe('get_file_info', () => {
  const s = setup();
  const infoOf = (text) => Object.fromEntries(text.split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

  test('text file: fields in order, plain ISO dates, line counts', async () => {
    const p = path.join(s.dir, 'info.txt');
    fs.writeFileSync(p, 'a\nb\nc\n');
    fs.chmodSync(p, 0o640);
    const r = await call(s.tools, 'get_file_info', { path: p });
    const t = textOf(r);
    assert.deepEqual(
      t.split('\n').map((l) => l.split(': ')[0]),
      ['path', 'size', 'created', 'modified', 'accessed', 'isDirectory', 'isFile', 'isSymbolicLink', 'permissions', 'fileType', 'lineCount', 'lastLine', 'appendPosition'],
    );
    const info = infoOf(t);
    assert.equal(info.path, p);
    assert.equal(info.size, '6');
    for (const k of ['created', 'modified', 'accessed']) assert.match(info[k], ISO);
    assert.equal(info.isDirectory, 'false');
    assert.equal(info.isFile, 'true');
    assert.equal(info.isSymbolicLink, 'false');
    assert.equal(info.permissions, '640');
    assert.equal(info.fileType, 'text');
    assert.equal(info.lineCount, '3');
    assert.equal(info.lastLine, '2');
    assert.equal(info.appendPosition, '3');
  });

  test('empty file, directory, image, binary', async () => {
    const empty = path.join(s.dir, 'empty.txt');
    fs.writeFileSync(empty, '');
    const e = infoOf(textOf(await call(s.tools, 'get_file_info', { path: empty })));
    assert.deepEqual([e.lineCount, e.lastLine, e.appendPosition], ['0', '-1', '0']);

    const d = infoOf(textOf(await call(s.tools, 'get_file_info', { path: s.dir })));
    assert.equal(d.isDirectory, 'true');
    assert.equal(d.fileType, 'directory');
    assert.equal(d.lineCount, undefined);

    const img = path.join(s.dir, 'i.png');
    fs.writeFileSync(img, PNG);
    const i = infoOf(textOf(await call(s.tools, 'get_file_info', { path: img })));
    assert.equal(i.fileType, 'image');
    assert.equal(i.lineCount, undefined);

    const bin = path.join(s.dir, 'b.bin');
    fs.writeFileSync(bin, Buffer.from([0, 1, 2]));
    assert.equal(infoOf(textOf(await call(s.tools, 'get_file_info', { path: bin }))).fileType, 'binary');
  });

  test('a symlink is described itself (lstat) with its target', async () => {
    const target = path.join(s.dir, 'tgt.txt');
    const link = path.join(s.dir, 'lnk.txt');
    fs.writeFileSync(target, 'x\n');
    fs.symlinkSync(target, link);
    const t = textOf(await call(s.tools, 'get_file_info', { path: link }));
    const info = infoOf(t);
    assert.equal(info.path, link);
    assert.equal(info.isSymbolicLink, 'true');
    assert.equal(info.symlinkTarget, target);
    assert.equal(info.isFile, 'false');
    assert.ok(t.indexOf('symlinkTarget') === t.indexOf('isSymbolicLink') + 'isSymbolicLink: true\n'.length);
  });

  test('missing -> File not found', async () => {
    const p = path.join(s.dir, 'none');
    const r = await call(s.tools, 'get_file_info', { path: p });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), `Error: File not found: ${p}`);
  });
});

describe('through a real MCP client', () => {
  let client;
  let env;
  let dir;
  before(async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    env = await makeCtx();
    dir = tmpDir('mcpc-fs-mcp-');
    const server = new McpServer({ name: 'fs-test', version: '0' }, { capabilities: { tools: {} } });
    // Registered the way server.ts does it (other modules are not needed here).
    for (const def of filesystemTools(env.ctx)) {
      server.registerTool(
        def.name,
        { description: def.description, inputSchema: z.object(def.inputSchema).passthrough(), annotations: def.annotations },
        async (args) => {
          try {
            const out = await def.handler(args);
            return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
          }
        },
      );
    }
    const [c, t] = InMemoryTransport.createLinkedPair();
    await server.connect(t);
    client = new Client({ name: 'fs-test-client', version: '0' });
    await client.connect(c);
  });
  after(async () => {
    await client.close();
    rmrf(dir);
    env.cleanup();
  });

  test('published schemas: integer params with defaults, length has no baked-in default', async () => {
    const { tools } = await client.listTools();
    const read = tools.find((t) => t.name === 'read_file');
    assert.deepEqual(read.inputSchema.required, ['path']);
    assert.equal(read.inputSchema.properties.offset.type, 'integer');
    assert.equal(read.inputSchema.properties.offset.default, 0);
    assert.equal(read.inputSchema.properties.length.type, 'integer');
    assert.equal(read.inputSchema.properties.length.default, undefined);
    const list = tools.find((t) => t.name === 'list_directory');
    assert.equal(list.inputSchema.properties.depth.default, 2);
    const write = tools.find((t) => t.name === 'write_file');
    assert.deepEqual(write.inputSchema.properties.mode.enum, ['rewrite', 'append']);
  });

  test('string numbers and nulls from clients are accepted', async () => {
    const p = path.join(dir, 'f.txt');
    fs.writeFileSync(p, lines(6).join('\n'));
    const r = await client.callTool({ name: 'read_file', arguments: { path: p, offset: '2', length: '2', isUrl: 'false' } });
    assert.equal(textOf(r), '[Reading 2 lines from line 2 (total: 6 lines, 2 remaining)]\n\nline2\nline3\n\n[... 2 more lines. Call read_file with offset=4 to continue]');
    const r2 = await client.callTool({ name: 'read_file', arguments: { path: p, offset: null, length: null } });
    assert.match(textOf(r2), /^\[Reading 6 lines from start/);
    const bad = await client.callTool({ name: 'read_file', arguments: { path: p, length: 'lots' } });
    assert.equal(bad.isError, true);
  });
});
