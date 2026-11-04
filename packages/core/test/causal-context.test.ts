import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ctxFromDots,
  ctxIncludes,
  ctxSince,
  ctxSize,
  ctxToVv,
  ctxUnion,
  makeDot,
  parseDot,
  vvCovers,
  vvIncludes,
  type CausalContext,
} from '../src';

describe('dots and version vectors', () => {
  it('round-trips dots, including ids with dashes', () => {
    expect(parseDot(makeDot('drive-thru', 12))).toEqual({ replica: 'drive-thru', seq: 12 });
  });

  it('answers "have you seen this edit?" and "have you seen everything I have?"', () => {
    const vv = { counter: 3, kitchen: 1 };
    expect(vvIncludes(vv, 'counter:3')).toBe(true);
    expect(vvIncludes(vv, 'counter:4')).toBe(false);
    expect(vvIncludes(vv, 'drive-thru:1')).toBe(false);
    expect(vvCovers(vv, { counter: 2 })).toBe(true);
    expect(vvCovers(vv, { counter: 2, 'drive-thru': 1 })).toBe(false);
  });
});

describe('causal context', () => {
  it('tracks a gap from an out-of-order delta, and closes it when the missing edit arrives', () => {
    const ctx = ctxFromDots(['counter:1', 'counter:2', 'counter:4']);
    expect(ctx).toEqual({ counter: [[1, 2], [4, 4]] });
    expect(ctxToVv(ctx)).toEqual({ counter: 2 }); // the version vector stops at the gap
    const filled = ctxUnion(ctx, ctxFromDots(['counter:3']));
    expect(filled).toEqual({ counter: [[1, 4]] });
    expect(ctxToVv(filled)).toEqual({ counter: 4 });
  });

  it('slices off what a peer already has', () => {
    const ctx: CausalContext = { counter: [[1, 10]], kitchen: [[1, 2]] };
    expect(ctxSince(ctx, { counter: 7, kitchen: 5 })).toEqual({ counter: [[8, 10]] });
    expect(ctxSize(ctx)).toBe(12);
  });

  // Model-based check: a causal context must behave exactly like a plain Set of dots.
  const dotSet = fc
    .array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 1, max: 15 })), { maxLength: 30 })
    .map((pairs) => new Set(pairs.map(([r, n]) => makeDot(r, n))));

  it('property: behaves like a set of dots, with one canonical shape', () => {
    fc.assert(
      fc.property(dotSet, dotSet, fc.record({ a: fc.nat(15), b: fc.nat(15) }), (x, y, vv) => {
        const union = ctxUnion(ctxFromDots(x), ctxFromDots(y));
        const expected = new Set([...x, ...y]);
        expect(union).toEqual(ctxFromDots(expected)); // same set => same shape
        expect(ctxSize(union)).toBe(expected.size);
        for (const ranges of Object.values(union)) {
          // canonical: sorted, and neighbours never overlap or touch (else they would be one range)
          for (let k = 1; k < ranges.length; k++) expect(ranges[k][0]).toBeGreaterThan(ranges[k - 1][1] + 1);
        }
        for (const r of ['a', 'b', 'c']) {
          for (let n = 1; n <= 16; n++) {
            const dot = makeDot(r, n);
            expect(ctxIncludes(union, dot)).toBe(expected.has(dot));
            expect(ctxIncludes(ctxSince(union, vv), dot)).toBe(expected.has(dot) && !vvIncludes(vv, dot));
          }
        }
      }),
    );
  });
});
