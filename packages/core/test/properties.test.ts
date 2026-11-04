/**
 * Property-based tests: fast-check generates hundreds of random histories
 * (edits on 3 devices, messages reordered, duplicated and dropped) and we check
 * that the guarantees hold for every one of them. When a check fails, fast-check
 * shrinks the history to a minimal counterexample.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { byteSize, joinDocs, Replica, vvIncludes, type DocState } from '../src';
import { cmdsArb, skewsArb, World } from './harness';

const picksArb = fc.array(fc.nat(), { maxLength: 20 });

function expectAllIdentical(world: World): void {
  const [a, b, c] = world.replicas;
  expect(b.state()).toEqual(a.state());
  expect(c.state()).toEqual(a.state());
  expect(b.orders()).toEqual(a.orders());
  expect(c.orders()).toEqual(a.orders());
}

function expectNothingLost(world: World): void {
  for (const replica of world.replicas) {
    const orders = new Map(replica.orders().map((o) => [o.id, o]));
    for (const id of world.created) {
      if (!world.cleanedUp.has(id)) expect(orders.has(id), `order ${id} lost on ${replica.id}`).toBe(true);
    }
    for (const [itemId, orderId] of world.addedItems) {
      if (world.removedItems.has(itemId) || world.cleanedUp.has(orderId)) continue;
      const items = orders.get(orderId)?.items.map((i) => i.id) ?? [];
      expect(items, `item ${itemId} lost on ${replica.id}`).toContain(itemId);
    }
    for (const order of orders.values()) {
      expect(order.status, `status of ${order.id} on ${replica.id}`).toBe(world.expectedStatus(order.id));
    }
    for (const id of world.canceled) {
      // a canceled order never returns to an active stage; only a concurrent pick-up can beat it
      const status = orders.get(id)?.status;
      if (status) expect(['canceled', 'picked_up'], `canceled ${id} came back on ${replica.id}`).toContain(status);
    }
  }
}

describe('convergence under a hostile network', () => {
  it('3 replicas end identical when edits are broadcast and delivered in random order with duplicates', () => {
    fc.assert(
      fc.property(skewsArb, cmdsArb({ drops: false }), picksArb, (skews, cmds, picks) => {
        const world = new World(skews, true);
        world.run(cmds);
        world.flush(picks);
        expectAllIdentical(world);
        expectNothingLost(world);
      }),
      { numRuns: 300 },
    );
  });

  it('3 replicas end identical with pure version-vector anti-entropy, even when messages are dropped', () => {
    fc.assert(
      fc.property(skewsArb, cmdsArb({ drops: true }), picksArb, (skews, cmds, picks) => {
        const world = new World(skews, false);
        world.run(cmds);
        world.flush(picks);
        world.settle(); // the network heals: a few reliable gossip rounds
        expectAllIdentical(world);
        expectNothingLost(world);
      }),
      { numRuns: 300 },
    );
  });

  it('3 replicas end identical when broadcast and anti-entropy mix on a lossy network', () => {
    fc.assert(
      fc.property(skewsArb, cmdsArb({ drops: true }), picksArb, (skews, cmds, picks) => {
        const world = new World(skews, true);
        world.run(cmds);
        world.flush(picks);
        world.settle();
        expectAllIdentical(world);
        expectNothingLost(world);
      }),
      { numRuns: 300 },
    );
  });
});

/** Three replica states that have drifted apart, with some partial syncing in between. */
const divergedStates = fc
  .tuple(skewsArb, cmdsArb({ drops: true, maxLength: 60 }))
  .map(([skews, cmds]) => {
    const world = new World(skews, true);
    world.run(cmds);
    return world.replicas;
  });

describe('the merge is a join (a lattice least upper bound)', () => {
  it('is commutative, associative and idempotent', () => {
    fc.assert(
      fc.property(divergedStates, (replicas) => {
        const [a, b, c]: DocState[] = replicas.map((r) => r.state());
        expect(joinDocs(a, b)).toEqual(joinDocs(b, a));
        expect(joinDocs(joinDocs(a, b), c)).toEqual(joinDocs(a, joinDocs(b, c)));
        expect(joinDocs(a, a)).toEqual(a);
        expect(joinDocs(joinDocs(a, b), b)).toEqual(joinDocs(a, b)); // re-merging is harmless
      }),
      { numRuns: 300 },
    );
  });
});

describe('delta sync sends exactly what is missing', () => {
  it('merging the delta gives the same result as merging the full state, and nothing the peer has is sent', () => {
    fc.assert(
      fc.property(divergedStates, fc.nat(2), fc.nat(2), (replicas, i, j) => {
        fc.pre(i !== j);
        const sender = replicas[i];
        const receiver = replicas[j];
        const peerVv = receiver.versionVector();
        const delta = sender.deltaFor(peerVv);

        const viaDelta = new Replica('copy-a');
        viaDelta.merge(receiver.fullState());
        viaDelta.merge(delta);
        const viaFull = new Replica('copy-b');
        viaFull.merge(receiver.fullState());
        viaFull.merge(sender.fullState());
        expect(viaDelta.state()).toEqual(viaFull.state());

        for (const dot of dotsIn(delta)) expect(vvIncludes(peerVv, dot), `resent ${dot}`).toBe(false);
        const full = sender.fullState();
        expect(byteSize([delta.orders, delta.context])).toBeLessThanOrEqual(byteSize([full.orders, full.context]));
      }),
      { numRuns: 300 },
    );
  });
});

/** Every dot mentioned by a piece of state in the delta (adds, tombstones, register writes). */
function dotsIn(doc: DocState): string[] {
  const dots: string[] = [];
  for (const order of Object.values(doc.orders)) {
    dots.push(...Object.keys(order.adds), ...Object.keys(order.tombs));
    if (order.value?.info) dots.push(order.value.info.dot);
    if (order.value?.status) dots.push(order.value.status.dot);
    for (const item of Object.values(order.value?.items ?? {})) {
      dots.push(...Object.keys(item.adds), ...Object.keys(item.tombs));
      if (item.value) dots.push(item.value.dot);
    }
  }
  return dots;
}
