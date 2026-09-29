import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { errorResult, textResult, type ContentBlock, type ToolDef, type ToolResult } from '../types.js';
import type { RemoteConfig } from './config.js';
import {
  DurableStateError, FileLock, UnsyncedRecordError, canonicalJson, createExclusive, ensurePrivateDir, ownIdentity,
  processStatus, readJson, sha256, writeAtomic,
} from './durable.js';
import { assertIdempotencyKey } from './jobs.js';

/**
 * Optional duplicate protection for the remote mutating tools (write_file, edit_block, move_file,
 * create_directory, start_process, interact_with_process, force_terminate, kill_process, and the GUI
 * tools press_element and set_element_value).
 *
 * With an idempotencyKey, a call first claims the key on disk (atomically, across every remote
 * server process sharing this remote directory) with a fingerprint of tool + canonical arguments
 * and state "pending"; only then does the tool run; its result is recorded afterwards. A retry with
 * the same key and arguments gets the recorded result replayed — the action does not run again.
 * A retry while the first call has no recorded result (still running, or its process died between
 * acting and recording) is told the outcome is in progress/unknown, and the action is never re-run
 * automatically. The same key with different arguments is refused.
 *
 * Calls without a key behave exactly as before and have no duplicate protection. Keys are never
 * deleted or reused automatically; when idempotency.maxKeys is reached new keys are refused.
 * Records hold hashes of the arguments and the (bounded) tool result; the audit log gets neither.
 */

export const IDEMPOTENT_TOOLS = [
  'write_file', 'edit_block', 'move_file', 'create_directory', 'start_process', 'interact_with_process',
  'force_terminate', 'kill_process', 'press_element', 'set_element_value',
];

interface IdemRecord {
  v: 1;
  keyHash: string;
  tool: string;
  fingerprint: string;
  state: 'pending' | 'completed';
  createdAt: string;
  completedAt?: string;
  owner: { pid: number; identity: string | null };
  result?: { isError: boolean; content: ContentBlock[]; truncated: boolean };
}

const KEY_DESCRIPTION =
  'Optional (remote only). A unique id for this intended action, e.g. a fresh UUID; reuse it only to retry the SAME call. ' +
  'A retry with the same key does not run the action again: it returns the recorded result, or says the first call is ' +
  'still in progress / has an unknown outcome. Reusing a key with different arguments is refused. Without a key there is ' +
  'no duplicate protection.';

/** Keeps a recorded result within `max` bytes of JSON (text is cut, images are dropped). */
function boundResult(result: ToolResult, max: number): IdemRecord['result'] {
  const content = result.content;
  if (Buffer.byteLength(JSON.stringify(content)) <= max) return { isError: !!result.isError, content, truncated: false };
  let text = content
    .map((c) => (c.type === 'text' ? c.text : `[${c.mimeType} image not recorded]`))
    .join('\n');
  const budget = Math.max(256, max - 512);
  while (Buffer.byteLength(JSON.stringify(text)) > budget) text = text.slice(0, Math.floor(text.length * 0.8));
  return { isError: !!result.isError, content: [{ type: 'text', text: `${text}\n[… recorded result truncated]` }], truncated: true };
}

export class IdempotencyStore {
  readonly dir: string;
  private readonly lock: FileLock;
  /** Key hashes this process is executing right now. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly cfg: RemoteConfig) {
    this.dir = path.join(cfg.durableDir, 'idem');
    this.lock = new FileLock(path.join(cfg.durableDir, 'lock'));
  }

  private file(keyHash: string): string {
    return path.join(this.dir, `${keyHash}.json`);
  }

  private existingOutcome(rec: IdemRecord, tool: string, fingerprint: string): ToolResult {
    if (rec.fingerprint !== fingerprint || rec.tool !== tool) {
      return errorResult(
        `idempotencyKey was already used for a different call (${rec.tool === tool ? 'same tool, different arguments' : `tool ${rec.tool}`}). ` +
          'Nothing was executed. Use a new key for a new action.',
      );
    }
    if (rec.state === 'completed' && rec.result) {
      return {
        isError: rec.result.isError || undefined,
        content: [
          {
            type: 'text',
            text:
              `[idempotent replay: this key was first used at ${rec.createdAt}; below is the result RECORDED then. ` +
              'The action was NOT executed again, and the replay does not show the current state (e.g. a process it ' +
              `started may have exited since; check with list_sessions / read_process_output).${rec.result.truncated ? ' The recorded result was truncated.' : ''}]`,
          },
          ...rec.result.content,
        ],
      };
    }
    // Pending: in progress only if this process is running it right now; otherwise nobody can tell
    // whether it acted (its result was never recorded) — never guess, never rerun.
    const inFlight = rec.owner.pid === process.pid && this.inFlight.has(rec.keyHash);
    const ownerRuns = !inFlight && rec.owner.pid !== process.pid && processStatus(rec.owner.pid, rec.owner.identity) !== 'gone';
    return errorResult(
      inFlight
        ? `A call with this idempotencyKey started at ${rec.createdAt} is still in progress. It was NOT executed again; retry later to get its recorded result.`
        : `Outcome unknown: a call with this idempotencyKey started at ${rec.createdAt} has no recorded result ` +
            (ownerRuns
              ? '(the server process that took it is still running: it may still be working, or failed to record its result). '
              : '(the server process that took it stopped, or could not record its result). ') +
            'The action may or may not have taken effect. It was NOT executed again. Check the target (e.g. read the file ' +
            'or list the sessions), then use a new key if the action is still needed.',
    );
  }

  /** Runs `exec` at most once per key (see the module comment). */
  async run(tool: string, args: Record<string, unknown>, rawKey: unknown, exec: () => Promise<ToolResult>): Promise<ToolResult> {
    let key: string;
    try {
      key = assertIdempotencyKey(rawKey);
    } catch (err) {
      return errorResult((err as Error).message);
    }
    const keyHash = sha256(key);
    const fingerprint = sha256(canonicalJson({ tool, args }));
    const file = this.file(keyHash);

    let claimed: ToolResult | null;
    try {
      ensurePrivateDir(this.cfg.durableDir);
      ensurePrivateDir(this.dir);
      claimed = await this.lock.with(() => {
        const existing = readJson<IdemRecord>(file);
        if (existing) return this.existingOutcome(existing, tool, fingerprint);
        const count = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).length;
        if (count >= this.cfg.idempotency.maxKeys) {
          return errorResult(
            `Idempotency store is full (${count} keys; limit idempotency.maxKeys=${this.cfg.idempotency.maxKeys}). Nothing was executed. ` +
              'Keys are never deleted automatically; the owner has to archive old ones on the Mac (see the runbook).',
          );
        }
        const rec: IdemRecord = {
          v: 1,
          keyHash,
          tool,
          fingerprint,
          state: 'pending',
          createdAt: new Date().toISOString(),
          owner: { pid: process.pid, identity: ownIdentity() },
        };
        // Intent before action: after this, no retry with this key can run the action.
        try {
          if (!createExclusive(file, JSON.stringify(rec) + '\n')) throw new DurableStateError('key claimed concurrently');
        } catch (err) {
          // Published but not durable: we will not act, so take the claim back.
          if (err instanceof UnsyncedRecordError) fs.rmSync(file, { force: true });
          throw err;
        }
        this.inFlight.add(keyHash);
        return null;
      });
    } catch (err) {
      return errorResult(
        `Idempotency state is not usable, so the action was NOT executed (fail closed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (claimed) return claimed;

    let result: ToolResult;
    try {
      result = await exec();
    } catch (err) {
      result = errorResult(err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight.delete(keyHash);
    }

    try {
      const pending = readJson<IdemRecord>(file);
      if (!pending || pending.fingerprint !== fingerprint || pending.state !== 'pending') throw new DurableStateError('record changed');
      pending.state = 'completed';
      pending.completedAt = new Date().toISOString();
      pending.result = boundResult(result, this.cfg.idempotency.maxResultBytes);
      writeAtomic(file, JSON.stringify(pending) + '\n');
    } catch (err) {
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: 'text',
            text:
              `[warning: the action ran, but its result could not be recorded for idempotencyKey retries (${err instanceof Error ? err.message : String(err)}). ` +
              'A retry with this key will report an unknown outcome and will NOT run the action again.]',
          },
        ],
      };
    }
    return result;
  }
}

function normalize(value: ToolResult | string): ToolResult {
  return typeof value === 'string' ? textResult(value) : value;
}

/** Adds the optional idempotencyKey parameter to a remote tool. */
export function withIdempotency(base: ToolDef, store: IdempotencyStore): ToolDef {
  return {
    ...base,
    description: `${base.description} Remote: accepts an optional idempotencyKey for safe retries.`,
    inputSchema: { ...base.inputSchema, idempotencyKey: z.string().optional().describe(KEY_DESCRIPTION) },
    handler: async (args) => {
      const { idempotencyKey, ...rest } = args as Record<string, unknown>;
      if (idempotencyKey === undefined) return base.handler(rest as never);
      return store.run(base.name, rest, idempotencyKey, async () => normalize(await base.handler(rest as never)));
    },
  };
}
