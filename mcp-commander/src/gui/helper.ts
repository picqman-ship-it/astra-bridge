import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from '../types.js';

/**
 * Runs the native Accessibility helper (native/ax-helper.swift, built to dist/native/). One process
 * per call: a hung app can stall an AX call, so the helper bounds every message itself and this
 * side kills it (SIGKILL) when the call's time is up.
 */

export const HELPER_NAME = 'mcp-commander-ax';
export type HelperCommand = 'check' | 'apps' | 'windows' | 'tree' | 'act';
export type HelperResponse = Record<string, unknown>;
export type HelperRunner = (command: HelperCommand, request: Record<string, unknown>, timeoutMs: number) => Promise<HelperResponse>;

/** An expected GUI failure with a stable code (not_trusted, stale_ref, …); the message is user-facing. */
export class GuiError extends ToolError {
  constructor(readonly code: string, message: string, readonly details: HelperResponse = {}) {
    super(message);
  }
}

/** dist/native/mcp-commander-ax next to the compiled JS (dist/gui/helper.js). */
export function defaultHelperPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', HELPER_NAME);
}

export function unsupportedPlatform(platform: string): GuiError {
  return new GuiError(
    'unsupported_platform',
    `GUI tools use the macOS Accessibility API and are not available on this platform (${platform}). Nothing was done.`,
  );
}

export function nativeRunner(helperPath = defaultHelperPath()): HelperRunner {
  return (command, request, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (!fs.existsSync(helperPath)) {
        reject(
          new GuiError(
            'helper_missing',
            `The Accessibility helper is not built (${helperPath}). Install the Xcode Command Line Tools ` +
              '(xcode-select --install) and run npm run build on the Mac.',
          ),
        );
        return;
      }
      const child = execFile(
        helperPath,
        [command],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
        (err, stdout, stderr) => {
          const line = String(stdout).trim().split('\n').pop() ?? '';
          let parsed: HelperResponse | null = null;
          try {
            parsed = line ? (JSON.parse(line) as HelperResponse) : null;
          } catch {
            parsed = null;
          }
          if (parsed && parsed.ok === false) {
            const { ok: _ok, code, message, ...rest } = parsed;
            reject(new GuiError(String(code ?? 'helper_error'), String(message ?? 'The Accessibility helper failed.'), rest));
            return;
          }
          if (parsed && !err) {
            resolve(parsed);
            return;
          }
          if (err && (err as { killed?: boolean }).killed) {
            reject(new GuiError('timeout', `The Accessibility helper did not finish within ${timeoutMs} ms and was stopped.`));
            return;
          }
          const detail = String(stderr).trim().slice(0, 500) || (err ? err.message : 'no output');
          reject(new GuiError('helper_failed', `The Accessibility helper failed: ${detail}`));
        },
      );
      child.stdin?.on('error', () => {
        /* the helper exited before reading its request; the exit callback reports it */
      });
      child.stdin?.end(JSON.stringify(request));
    });
}
