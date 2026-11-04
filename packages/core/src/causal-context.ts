/**
 * Dots, version vectors and causal contexts: how replicas name edits and
 * summarize which edits they have already seen.
 */

/** A device id such as "drive-thru". Must not contain ":". */
export type ReplicaId = string;

/**
 * A dot names exactly one edit: the n-th edit made by a replica, written "replica:n".
 * Every piece of CRDT state remembers the dot of the edit that produced it.
 */
export type Dot = string;

export function makeDot(replica: ReplicaId, seq: number): Dot {
  return `${replica}:${seq}`;
}

export function parseDot(dot: Dot): { replica: ReplicaId; seq: number } {
  const i = dot.lastIndexOf(':');
  return { replica: dot.slice(0, i), seq: Number(dot.slice(i + 1)) };
}

/**
 * A version vector says "I have every edit 1..n from each replica",
 * e.g. { "drive-thru": 12, kitchen: 4 }. A missing replica means 0.
 */
export type VersionVector = Record<ReplicaId, number>;

export function vvIncludes(vv: VersionVector, dot: Dot): boolean {
  const { replica, seq } = parseDot(dot);
  return seq <= (vv[replica] ?? 0);
}

/** True if `a` has seen everything `b` has, entry by entry. */
export function vvCovers(a: VersionVector, b: VersionVector): boolean {
  return Object.entries(b).every(([replica, n]) => (a[replica] ?? 0) >= n);
}

/** Inclusive range of edit numbers. */
export type SeqRange = [first: number, last: number];

/**
 * A causal context is the exact set of edits a replica has seen, stored per
 * replica as sorted ranges that never overlap or touch. { counter: [[1, 40], [43, 45]] }
 * means edits 1-40 and 43-45 from the counter.
 *
 * Normally each replica has a single range starting at 1, which is just a
 * version vector. Gaps appear only while deltas arrive out of order, and close
 * as soon as the missing edits show up.
 */
export type CausalContext = Record<ReplicaId, SeqRange[]>;

export function ctxIncludes(ctx: CausalContext, dot: Dot): boolean {
  const { replica, seq } = parseDot(dot);
  return (ctx[replica] ?? []).some(([first, last]) => first <= seq && seq <= last);
}

export function ctxFromDots(dots: Iterable<Dot>): CausalContext {
  const byReplica: CausalContext = {};
  for (const dot of dots) {
    const { replica, seq } = parseDot(dot);
    (byReplica[replica] ??= []).push([seq, seq]);
  }
  return ctxUnion({}, byReplica);
}

export function ctxUnion(a: CausalContext, b: CausalContext): CausalContext {
  const out: CausalContext = {};
  for (const replica of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const ranges = mergeRanges([...(a[replica] ?? []), ...(b[replica] ?? [])]);
    if (ranges.length > 0) out[replica] = ranges;
  }
  return out;
}

/** The part of `ctx` that a peer whose version vector is `vv` has not seen yet. */
export function ctxSince(ctx: CausalContext, vv: VersionVector): CausalContext {
  const out: CausalContext = {};
  for (const [replica, ranges] of Object.entries(ctx)) {
    const seen = vv[replica] ?? 0;
    const unseen = ranges
      .filter(([, last]) => last > seen)
      .map(([first, last]): SeqRange => [Math.max(first, seen + 1), last]);
    if (unseen.length > 0) out[replica] = unseen;
  }
  return out;
}

/** The version vector inside a context: for each replica, the unbroken run of edits starting at 1. */
export function ctxToVv(ctx: CausalContext): VersionVector {
  const vv: VersionVector = {};
  for (const [replica, ranges] of Object.entries(ctx)) {
    if (ranges[0]?.[0] === 1) vv[replica] = ranges[0][1];
  }
  return vv;
}

/** How many edits the context contains. */
export function ctxSize(ctx: CausalContext): number {
  let n = 0;
  for (const ranges of Object.values(ctx)) {
    for (const [first, last] of ranges) n += last - first + 1;
  }
  return n;
}

/** Sort ranges and fuse any that overlap or touch, e.g. [1,3] + [4,6] -> [1,6]. */
function mergeRanges(ranges: SeqRange[]): SeqRange[] {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  const out: SeqRange[] = [];
  for (const [first, last] of sorted) {
    const prev = out[out.length - 1];
    if (prev && first <= prev[1] + 1) prev[1] = Math.max(prev[1], last);
    else out.push([first, last]);
  }
  return out;
}
