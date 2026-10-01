// Small shared helpers for the macOS installer. Node built-ins only: the installer runs before
// any `npm ci`, so it must not depend on packages from either workspace.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

/** A failure the user can act on; `hint` is printed after the message. */
export class InstallerError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.hint = hint;
  }
}

/**
 * The flow reached a step only the user can do (a browser login, a dashboard setting, a
 * confirmation that non-interactive mode cannot give). Not an error: re-running continues.
 */
export class Checkpoint extends Error {
  constructor(message, { instructions = [], resume } = {}) {
    super(message);
    this.instructions = instructions;
    this.resume = resume;
  }
}

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, CHECKPOINT: 3 });

/** Runs a command to completion; never throws for a non-zero exit or a missing binary. */
export function run(cmd, args = [], { env, cwd, timeoutMs = 120_000, input } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    cwd,
    input,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error ? (r.error.code ?? r.error.message) : null,
  };
}

/** Runs a command attached to this terminal (for npm, wrangler login and similar). */
export function runInherit(cmd, args = [], { env, cwd } = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, cwd });
  return r.error ? null : r.status;
}

/**
 * Runs a command, streaming its output to ours while also capturing it (to parse, for
 * example, the URL `wrangler deploy` prints). stdin stays attached to the terminal.
 */
export function runTee(cmd, args = [], { env, cwd, out = process.stdout, err = process.stderr } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ["inherit", "pipe", "pipe"] });
    } catch (e) {
      resolve({ status: null, output: "", error: e.code ?? e.message });
      return;
    }
    let output = "";
    const keep = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 1024 * 1024) output = output.slice(-512 * 1024);
    };
    child.stdout.on("data", (c) => { keep(c); out.write(c); });
    child.stderr.on("data", (c) => { keep(c); err.write(c); });
    child.on("error", (e) => resolve({ status: null, output, error: e.code ?? e.message }));
    child.on("close", (status) => resolve({ status, output, error: null }));
  });
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function mode(st) {
  return st.mode & 0o777;
}

export function octal(m) {
  return (m & 0o777).toString(8).padStart(4, "0");
}

export function expandHome(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Writes `content` through an exclusive temp file in the same directory and renames it into
 * place, so a reader never sees a partial file and the final mode never depends on umask.
 */
export function writeFileAtomic(file, content, fileMode = 0o600) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, fileMode);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, fileMode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Quotes a value for a copy-pasteable shell command. */
export function shQuote(s) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `fn` until it returns a truthy value or `timeoutMs` passes; returns the last value. */
export async function poll(fn, { timeoutMs, intervalMs = 1000 }) {
  const end = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < end) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}
