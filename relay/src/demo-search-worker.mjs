// Runs the pattern matching of a demo search off the main thread. Reviewer-supplied
// regular expressions and globs can backtrack catastrophically; the runtime terminates
// this worker at the search deadline, so the agent itself never stalls.
//
// The runtime has already walked and path-checked every candidate; this worker only
// reads those regular files (no directory traversal, no symlinks) and matches them.

import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

const LINE_MAX = 2_000;

function globToRegExp(glob, ignoreCase) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) out += "\\{";
      else {
        out += `(?:${glob.slice(i + 1, close).split(",").map(escape).join("|")})`;
        i = close;
      }
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) out += "\\[";
      else {
        const body = glob.slice(i + 1, close).replace(/\\/g, "\\\\").replace(/^!/, "^");
        out += `[${body}]`;
        i = close;
      }
    } else out += escape(c);
  }
  return new RegExp(`^${out}$`, ignoreCase ? "i" : "");
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const hasGlob = (s) => /[*?[\]{}]/.test(s);

/** '|'-separated globs, '!glob' excludes. Case-sensitive like the production engine. */
function filePatternFilter(filePattern) {
  if (!filePattern) return () => true;
  const parts = filePattern.split("|").map((p) => p.trim()).filter(Boolean);
  const include = parts.filter((p) => !p.startsWith("!")).map((p) => ({ p, re: globToRegExp(p, false) }));
  const exclude = parts.filter((p) => p.startsWith("!")).map((p) => ({ p: p.slice(1), re: globToRegExp(p.slice(1), false) }));
  const test = ({ p, re }, entry) => re.test(p.includes("/") ? entry.rel : entry.name);
  return (entry) => (include.length === 0 || include.some((g) => test(g, entry))) && !exclude.some((g) => test(g, entry));
}

function nameMatcher(pattern, ignoreCase) {
  if (hasGlob(pattern)) {
    const re = globToRegExp(pattern, ignoreCase);
    return (entry) => re.test(pattern.includes("/") ? entry.rel : entry.name);
  }
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  return (entry) => {
    const hay = pattern.includes("/") ? entry.rel : entry.name;
    return (ignoreCase ? hay.toLowerCase() : hay).includes(needle);
  };
}

function searchFiles(opts) {
  const results = [];
  const matchName = nameMatcher(opts.pattern, opts.ignoreCase);
  const wanted = filePatternFilter(opts.filePattern);
  const exact = opts.ignoreCase ? opts.pattern.toLowerCase() : opts.pattern;
  for (const entry of opts.entries) {
    if (!entry.isDir && !wanted(entry)) continue;
    if (!matchName(entry)) continue;
    results.push({ type: entry.isDir ? "dir" : "file", file: entry.virtual });
    if (results.length >= opts.maxResults) return { results, limitReached: true };
    const name = opts.ignoreCase ? entry.name.toLowerCase() : entry.name;
    if (opts.earlyTermination && !entry.isDir && name === exact) return { results, earlyTerminated: true };
  }
  return { results };
}

function searchContent(opts) {
  const results = [];
  let matchCount = 0;
  let contextCount = 0;
  const flags = opts.ignoreCase ? "i" : "";
  const re = new RegExp(opts.literalSearch ? escape(opts.pattern) : opts.pattern, flags);
  const wanted = filePatternFilter(opts.filePattern);
  for (const entry of opts.entries) {
    if (entry.isDir || !wanted(entry)) continue;
    let buf;
    try {
      buf = fs.readFileSync(entry.real);
    } catch {
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) continue;
    const lines = buf.toString("utf8").replace(/^﻿/, "").split(/\r\n|\r|\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const emitted = new Set();
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i].slice(0, LINE_MAX);
      if (!re.test(text)) continue;
      const from = Math.max(0, i - opts.contextLines);
      const to = Math.min(lines.length - 1, i + opts.contextLines);
      for (let j = from; j <= to; j += 1) {
        if (emitted.has(j)) continue;
        emitted.add(j);
        const isMatch = j === i || re.test(lines[j].slice(0, LINE_MAX));
        results.push({ type: isMatch ? "match" : "context", file: entry.virtual, line: j + 1, text: lines[j].slice(0, LINE_MAX) });
        if (isMatch) matchCount += 1;
        else contextCount += 1;
        if (results.length >= opts.maxResults) return { results, matchCount, contextCount, limitReached: true };
      }
    }
  }
  return { results, matchCount, contextCount };
}

try {
  const outcome = workerData.searchType === "content" ? searchContent(workerData) : searchFiles(workerData);
  parentPort.postMessage({ ok: true, ...outcome });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err instanceof SyntaxError ? "invalid pattern" : "search failed" });
}
