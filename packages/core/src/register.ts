import type { Dot } from './causal-context';
import { compareHlc, type Hlc } from './hlc';

/**
 * A register holds a single write: a value, the HLC timestamp it was written
 * at, and the dot of the edit that wrote it (so delta sync can tell whether a
 * peer already has it).
 *
 * Merging two registers keeps one of the two writes. Different registers differ
 * only in *which* write they keep. As long as the rule picks the larger write
 * under some fixed total order, the merge is a max, so it is commutative,
 * associative and idempotent, and replicas converge.
 */
export interface Write<T> {
  value: T;
  hlc: Hlc;
  dot: Dot;
}

type RegisterJoin<T> = (a: Write<T> | undefined, b: Write<T> | undefined) => Write<T> | undefined;

/** Last-writer-wins: keep the write with the larger HLC. */
export function lwwJoin<T>(a: Write<T> | undefined, b: Write<T> | undefined): Write<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareHlc(a.hlc, b.hlc) >= 0 ? a : b;
}

/**
 * Forward-only: keep the write whose value is furthest along `rank`, whatever
 * its timestamp. When both writes have the same rank, keep the earlier one, so
 * the timestamp records when that stage was first reached.
 */
export function forwardJoin<T>(rank: (value: T) => number): RegisterJoin<T> {
  return (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const ahead = rank(a.value) - rank(b.value);
    if (ahead !== 0) return ahead > 0 ? a : b;
    return compareHlc(a.hlc, b.hlc) <= 0 ? a : b;
  };
}
