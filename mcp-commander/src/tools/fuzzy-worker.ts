import { parentPort, workerData } from 'node:worker_threads';
import { findClosestMatch } from './fuzzy.js';

// Worker entry for runFuzzySearch (fuzzy.ts): one search per worker, result posted back once.
const { text, query } = workerData as { text: string; query: string };
try {
  parentPort?.postMessage({ ok: true, match: findClosestMatch(text, query) });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
