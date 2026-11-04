import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareHlc, HlcClock, type Hlc } from '../src';

describe('hybrid logical clock', () => {
  it('keeps moving forward when the wall clock stalls or jumps backwards', () => {
    let wall = 1000;
    const clock = new HlcClock('counter', () => wall);
    const a = clock.now();
    const b = clock.now(); // same wall time
    wall = 500; // clock jumped backwards (NTP correction, dead battery...)
    const c = clock.now();
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
    expect(c.wall).toBe(1000);
  });

  it('orders an edit after anything it has seen, even with a slow wall clock', () => {
    const fastKitchen = new HlcClock('kitchen', () => 60_000); // a minute ahead
    const slowCounter = new HlcClock('counter', () => 1_000);
    const cooking = fastKitchen.now();
    slowCounter.receive(cooking);
    const ready = slowCounter.now();
    expect(compareHlc(ready, cooking)).toBe(1);
  });

  it('breaks exact wall/counter ties with the device id', () => {
    const a: Hlc = { wall: 5, counter: 0, node: 'counter' };
    const b: Hlc = { wall: 5, counter: 0, node: 'kitchen' };
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, a)).toBe(1);
    expect(compareHlc(a, { ...a })).toBe(0);
  });

  it('property: every timestamp is greater than all earlier local and received ones', () => {
    const step = fc.oneof(
      fc.record({ kind: fc.constant('local' as const), wall: fc.integer({ min: 0, max: 50 }) }),
      fc.record({
        kind: fc.constant('receive' as const),
        wall: fc.integer({ min: 0, max: 50 }),
        remote: fc.record({ wall: fc.integer({ min: 0, max: 80 }), counter: fc.nat(5), node: fc.constant('peer') }),
      }),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        let wall = 0;
        const clock = new HlcClock('me', () => wall);
        let highest: Hlc | undefined;
        for (const s of steps) {
          wall = s.wall;
          if (s.kind === 'receive') {
            clock.receive(s.remote);
            if (!highest || compareHlc(s.remote, highest) > 0) highest = s.remote;
          } else {
            const t = clock.now();
            if (highest) expect(compareHlc(t, highest)).toBe(1);
            highest = t;
          }
        }
      }),
    );
  });
});
