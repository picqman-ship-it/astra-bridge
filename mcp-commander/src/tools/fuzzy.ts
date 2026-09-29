import { Worker } from 'node:worker_threads';

/**
 * Fuzzy matching for edit_block's "no exact match" fallback. The search algorithm is Desktop
 * Commander's (recursive halving on Levenshtein distance, then a greedy window shrink); the
 * distance itself is Myers' bit-parallel algorithm (blocked, any length), verified against the
 * plain two-row DP in the tests. All functions here are pure; runFuzzySearch runs the search in
 * a worker thread so a slow search can be cut off.
 * Desktop Commander MCP (MIT) attribution for the search algorithm: see LICENSE.
 */

export const FUZZY_THRESHOLD = 0.7;
export const FUZZY_TIMEOUT_MS = 30000;

/** Reference Levenshtein distance (two-row dynamic programming over UTF-16 code units). */
export function levenshteinDP(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

// Char code -> 1-based slot in the current pattern's match-mask table (0 = not in pattern).
// Module-level so it is allocated once; every call resets the entries it set.
const slotOf = new Int32Array(0x10000);

const enum Mode {
  /** Global distance of pattern vs the whole text. */
  Last,
  /** Global distance of pattern vs every prefix of text. */
  AllPrefixes,
  /** Free start (Sellers): best distance of pattern vs any substring of text, and where it ends. */
  SearchMin,
}

interface SearchResult {
  min: number;
  /** End offset (exclusive) of the first best-matching substring. */
  end: number;
}

/**
 * Myers' bit-vector edit distance (blocked for patterns of any length; Myers 1999, "A fast
 * bit-vector algorithm for approximate string matching based on dynamic programming").
 * Row 0 of the DP is 0,1,2,... for global distance and all zeros for substring search.
 */
function myers(pattern: string, text: string, mode: Mode): number | Int32Array | SearchResult {
  const m = pattern.length;
  const n = text.length;
  if (m === 0) {
    if (mode === Mode.Last) return n;
    if (mode === Mode.SearchMin) return { min: 0, end: 0 };
    const s = new Int32Array(n + 1);
    for (let j = 0; j <= n; j++) s[j] = j;
    return s;
  }
  const blocks = (m + 31) >>> 5;
  const codes: number[] = [];
  for (let i = 0; i < m; i++) {
    const c = pattern.charCodeAt(i);
    if (slotOf[c] === 0) {
      codes.push(c);
      slotOf[c] = codes.length;
    }
  }
  const peq = new Int32Array((codes.length + 1) * blocks); // slot 0 = all-zero masks
  for (let i = 0; i < m; i++) peq[slotOf[pattern.charCodeAt(i)] * blocks + (i >>> 5)] |= 1 << (i & 31);

  const P = new Int32Array(blocks).fill(-1);
  const M = new Int32Array(blocks);
  const lastHigh = 1 << ((m - 1) & 31);
  const high = 1 << 31;
  const scores = mode === Mode.AllPrefixes ? new Int32Array(n + 1) : null;
  if (scores) scores[0] = m;
  const hin0 = mode === Mode.SearchMin ? 0 : 1; // horizontal delta of DP row 0
  let score = m;
  let best = m;
  let bestEnd = 0;
  try {
    for (let j = 0; j < n; j++) {
      const base = slotOf[text.charCodeAt(j)] * blocks;
      let hin = hin0;
      for (let b = 0; b < blocks; b++) {
        let eq = peq[base + b];
        const pv = P[b];
        const mv = M[b];
        const xv = eq | mv;
        if (hin < 0) eq |= 1;
        const xh = (((eq & pv) + pv) ^ pv) | eq;
        let ph = mv | ~(xh | pv);
        let mh = pv & xh;
        const hb = b === blocks - 1 ? lastHigh : high;
        const hout = ph & hb ? 1 : mh & hb ? -1 : 0;
        ph <<= 1;
        mh <<= 1;
        if (hin < 0) mh |= 1;
        else if (hin > 0) ph |= 1;
        P[b] = mh | ~(xv | ph);
        M[b] = ph & xv;
        hin = hout;
      }
      score += hin;
      if (scores) scores[j + 1] = score;
      else if (score < best) {
        best = score;
        bestEnd = j + 1;
      }
    }
  } finally {
    for (const c of codes) slotOf[c] = 0;
  }
  if (scores) return scores;
  return mode === Mode.SearchMin ? { min: best, end: bestEnd } : score;
}

/** Levenshtein distance (fast path: strips common prefix/suffix, then bit-parallel). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let start = 0;
  let endA = a.length;
  let endB = b.length;
  while (start < endA && start < endB && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  return (x.length <= y.length ? myers(x, y, Mode.Last) : myers(y, x, Mode.Last)) as number;
}

/** scores[j] = levenshtein(pattern, text.slice(0, j)) for every j in 0..text.length. */
export function prefixDistances(pattern: string, text: string): Int32Array {
  return myers(pattern, text, Mode.AllPrefixes) as Int32Array;
}

/** 1 - distance / max(len); 1 when both strings are empty. */
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

/** Desktop Commander's name for similarity(). */
export const getSimilarityRatio = similarity;

function matchSimilarity(query: string, m: FuzzyMatch): number {
  const maxLen = Math.max(query.length, m.value.length);
  return maxLen === 0 ? 1 : 1 - m.distance / maxLen;
}

export interface FuzzyMatch {
  start: number;
  end: number;
  value: string;
  distance: number;
}

const reverse = (s: string): string => s.split('').reverse().join('');

/**
 * Greedy window shrink, exactly as the original: from text[start:end], drop leading chars while the
 * distance strictly improves, then trailing chars likewise. Instead of recomputing the distance for
 * every candidate window (O(window) passes), each phase gets all candidate distances from one
 * bit-parallel pass (suffixes via the reversed strings, prefixes directly) — same result, far faster.
 */
export function iterativeReduction(text: string, query: string, start: number, end: number): FuzzyMatch {
  const window = text.slice(start, end);
  // Phase 1: fixed end. dist(query, text[s:end]) = suffix[end - s].
  const suffix = prefixDistances(reverse(query), reverse(window));
  const d1 = (s: number) => suffix[end - s];
  let s = start;
  let best = d1(start);
  while (s < end && d1(s + 1) < best) {
    s++;
    best = d1(s);
  }
  // Phase 2: fixed start s. dist(query, text[s:e]) = prefix[e - s].
  const prefix = prefixDistances(query, text.slice(s, end));
  const d2 = (e: number) => prefix[e - s];
  let e = end;
  while (e > s && d2(e - 1) < best) {
    e--;
    best = d2(e);
  }
  return { start: s, end: e, value: text.slice(s, e), distance: best };
}

/** The original's shrink loop, one full distance per step. Kept as a test reference. */
export function iterativeReductionNaive(text: string, query: string, start: number, end: number): FuzzyMatch {
  let best = levenshtein(text.slice(start, end), query);
  let s = start;
  let e = end;
  while (s < e) {
    const next = levenshtein(text.slice(s + 1, e), query);
    if (next >= best) break;
    best = next;
    s++;
  }
  while (e > s) {
    const next = levenshtein(text.slice(s, e - 1), query);
    if (next >= best) break;
    best = next;
    e--;
  }
  return { start: s, end: e, value: text.slice(s, e), distance: best };
}

/**
 * Desktop Commander's recursiveFuzzyIndexOf: halve the range (halves overlap by the query length),
 * follow the half with the smaller distance, and stop when neither half beats the parent range.
 */
export function recursiveFuzzyIndexOf(
  text: string,
  query: string,
  start = 0,
  end = text.length,
  parentDistance = Infinity,
): FuzzyMatch {
  const q = query.length;
  let lo = start;
  let hi = end;
  let parent = parentDistance;
  for (;;) {
    if (hi - lo <= 2 * q) return iterativeReduction(text, query, lo, hi);
    const mid = lo + Math.floor((hi - lo) / 2);
    const leftEnd = Math.min(hi, mid + q);
    const rightStart = Math.max(lo, mid - q);
    const left = levenshtein(text.slice(lo, leftEnd), query);
    const right = levenshtein(text.slice(rightStart, hi), query);
    const best = Math.min(left, right, parent);
    if (parent === best) return iterativeReduction(text, query, lo, hi);
    if (left < right) hi = leftEnd;
    else lo = rightStart;
    parent = best;
  }
}

/**
 * Exact best match: the substring of `text` with the smallest edit distance to `query` (the first
 * one when several tie). One free-start bit-parallel pass finds the best end offset, a short
 * anchored pass over the reversed strings finds its start (preferring the length closest to the
 * query's).
 */
export function bestSubstringMatch(text: string, query: string): FuzzyMatch {
  const { min, end } = myers(query, text, Mode.SearchMin) as SearchResult;
  const from = Math.max(0, end - query.length - min); // a match within distance `min` is at most that long
  const scores = prefixDistances(reverse(query), reverse(text.slice(from, end))); // scores[k] = dist(query, text[end-k:end])
  let bestK = -1;
  for (let k = 0; k < scores.length; k++) {
    if (scores[k] !== min) continue;
    if (bestK < 0 || Math.abs(k - query.length) < Math.abs(bestK - query.length)) bestK = k;
  }
  if (bestK < 0) bestK = 0; // unreachable: the search pass guarantees a start exists
  const start = end - bestK;
  return { start, end, value: text.slice(start, end), distance: min };
}

/**
 * The most similar whole-line region around `m`. The best-scoring substring of a multi-line query
 * often starts or ends mid-line: with the indentation off, it starts inside the file's leading
 * whitespace; with a line missing near either end, dropping the unmatched chars scores better than
 * matching whole lines. Reported as "copy it exactly", such text corrupts the file when used as
 * old_string. Starts are tried on m's first line and the lines around it; for each, one prefix pass
 * scores every line end within reach, then one reversed pass re-picks the start for the chosen end.
 * Line boundaries follow the query: a query that starts (ends) with '\n' gets a region that does too.
 */
export function alignToLines(text: string, query: string, m: FuzzyMatch): FuzzyMatch {
  const q = query.length;
  if (q === 0) return m;
  const reach = 2 * q; // a region longer than twice the query is less than 50% similar
  const lead = query.charCodeAt(0) === 10;
  const trail = query.charCodeAt(q - 1) === 10;
  const isStart = (s: number) => s === 0 || (lead ? text.charCodeAt(s) === 10 : text.charCodeAt(s - 1) === 10);
  const isEnd = (e: number) => e === text.length || (trail ? text.charCodeAt(e - 1) === 10 : text.charCodeAt(e) === 10);

  let best: FuzzyMatch | undefined;
  let bestSim = -1;
  const consider = (s: number, e: number, distance: number) => {
    const sim = 1 - distance / Math.max(q, e - s);
    if (sim > bestSim) {
      bestSim = sim;
      best = { start: s, end: e, value: text.slice(s, e), distance };
    }
  };

  const starts: number[] = [];
  for (let s = Math.min(m.start, text.length); s >= 0 && starts.length < 2; s--) if (isStart(s)) starts.push(s);
  for (let s = m.start + 1; s < text.length; s++) {
    if (isStart(s)) {
      starts.push(s);
      break;
    }
  }
  for (const s of starts) {
    const limit = Math.min(text.length, s + reach);
    const d = prefixDistances(query, text.slice(s, limit)); // d[k] = dist(query, text[s:s+k])
    for (let e = s + 1; e <= limit; e++) if (isEnd(e)) consider(s, e, d[e - s]);
  }
  if (!best) return m;
  const e = (best as FuzzyMatch).end;
  const from = Math.max(0, e - reach);
  const r = prefixDistances(reverse(query), reverse(text.slice(from, e))); // r[k] = dist(query, text[e-k:e])
  for (let s = e - 1; s >= from; s--) if (isStart(s)) consider(s, e, r[e - s]);
  return best;
}

/**
 * What edit_block reports: the original's recursive search, cross-checked by the exact search.
 * The recursive halving ties (and wanders off) whenever both halves contain the query as a
 * subsequence — e.g. a slightly wrong old_string near the middle of a large file — so the exact
 * result wins whenever it is more similar; on equal similarity the original's result is kept.
 * A multi-line query is reported as whole lines (alignToLines) whenever that region still passes
 * the threshold, even if a partial-line region scores a little higher.
 */
export function findClosestMatch(text: string, query: string): FuzzyMatch {
  const original = recursiveFuzzyIndexOf(text, query);
  const exact = bestSubstringMatch(text, query);
  const best = matchSimilarity(query, exact) > matchSimilarity(query, original) ? exact : original;
  if (best.distance === 0 || !query.includes('\n')) return best;
  const a = alignToLines(text, query, original);
  const b = alignToLines(text, query, exact);
  const aligned = matchSimilarity(query, b) > matchSimilarity(query, a) ? b : a;
  const sim = matchSimilarity(query, aligned);
  return sim >= FUZZY_THRESHOLD || sim >= matchSimilarity(query, best) ? aligned : best;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * `prefix{-expected-}{+actual+}suffix` with the longest common prefix/suffix factored out
 * (never splitting a surrogate pair).
 */
export function highlightDifferences(expected: string, actual: string): string {
  const minLen = Math.min(expected.length, actual.length);
  let p = 0;
  while (p < minLen && expected.charCodeAt(p) === actual.charCodeAt(p)) p++;
  if (p > 0 && isHigh(expected.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < minLen - p && expected.charCodeAt(expected.length - 1 - s) === actual.charCodeAt(actual.length - 1 - s)) s++;
  if (s > 0 && isLow(expected.charCodeAt(expected.length - s))) s--;
  const common = expected.slice(0, p);
  const tail = expected.slice(expected.length - s);
  return `${common}{-${expected.slice(p, expected.length - s)}-}{+${actual.slice(p, actual.length - s)}+}${tail}`;
}

export class FuzzyTimeoutError extends Error {}

/** Runs findClosestMatch in a worker thread, terminating it after `timeoutMs`. */
export function runFuzzySearch(text: string, query: string, timeoutMs = FUZZY_TIMEOUT_MS): Promise<FuzzyMatch> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fuzzy-worker.js', import.meta.url), { workerData: { text, query } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new FuzzyTimeoutError(`Fuzzy search timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    worker.on('message', (msg: { ok: boolean; match?: FuzzyMatch; error?: string }) => {
      finish(() => (msg.ok && msg.match ? resolve(msg.match) : reject(new Error(`Fuzzy search worker failed: ${msg.error}`))));
    });
    worker.on('error', (err) => finish(() => reject(new Error(`Fuzzy search worker failed: ${err.message}`))));
    worker.on('exit', (code) => finish(() => reject(new Error(`Fuzzy search worker exited with code ${code}`))));
  });
}
