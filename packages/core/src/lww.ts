import type { Dot } from './causal-context';
import { compareHlc, type Hlc } from './hlc';

/**
 * Last-writer-wins register: holds one value plus the timestamp of the write
 * that set it. Merging two registers keeps the write with the larger HLC.
 * `dot` names the edit that wrote it, so delta sync can tell whether a peer has it.
 */
export interface Lww<T> {
  value: T;
  hlc: Hlc;
  dot: Dot;
}

export function lwwJoin<T>(a: Lww<T> | undefined, b: Lww<T> | undefined): Lww<T> | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareHlc(a.hlc, b.hlc) >= 0 ? a : b;
}
