import { describe, expect, it } from 'vitest';
import { CLOUD, DemoWorld } from '../src/world';
import { DEVICES } from '../src/station';

const EPOCH = Date.UTC(2026, 10, 3, 12, 0);

function playedThrough(engine: 'crdt' | 'naive') {
  const world = new DemoWorld(engine, { epoch: EPOCH });
  world.play();
  world.advanceTo(28_000);
  return world;
}

describe('the guided lunch rush', () => {
  it('with the CRDT, every order and item reaches every screen and the cloud, and the stale tap loses', () => {
    const world = playedThrough('crdt');
    expect(world.score()).toEqual({ orders: { kept: 4, total: 4 }, items: { kept: 7, total: 7 }, wentBack: 0 });
    for (const node of [...DEVICES, CLOUD]) {
      const d2 = world.orders(node).find((o) => o.id === 'D2');
      expect(d2?.items.map((i) => i.name)).toEqual(['chicken sandwich', 'cookie', 'lemonade']); // in the order added
      expect(world.orders(node).find((o) => o.id === 'C2')?.status).toBe('ready');
    }
    const stale = world.journal.entries.filter((e) => e.kind === 'stale');
    expect(stale.map((e) => e.text)).toEqual([
      'Drive-thru’s “cooking” on C2 arrived after “ready” and lost: status only moves forward'.replace('’', "'"),
    ]);
    expect(world.journal.entries.filter((e) => e.kind === 'loss')).toEqual([]);
    expect(world.caption?.text).toMatch(/^Done\. Every screen and the cloud show 4 of 4 orders and 7 of 7 items/);
    expect(world.cloudLag()).toEqual({ inSync: true, missingEdits: 0 });
    expect(world.playing).toBe(false);
  });

  it('with naive last-write-wins, the same rush loses work and says so', () => {
    const world = playedThrough('naive');
    const score = world.score();
    expect(score.items.kept).toBeLessThan(score.items.total);
    expect(world.journal.entries.some((e) => e.kind === 'loss' && /lemonade vanished from D2/.test(e.text))).toBe(true);
    expect(world.caption?.text).toBe(
      'Done. Every screen agrees, but 1 of 7 items vanished and 1 order went back a stage. Now switch to CRDT and play again.',
    );
  });
});

describe('network controls', () => {
  it('a cut Wi-Fi link stops sync between two devices until it is restored', () => {
    const world = new DemoWorld('crdt', { epoch: EPOCH });
    world.setLan('drive-thru', 'counter', false);
    world.setLan('drive-thru', 'kitchen', false);
    world.setInternet(false);
    const id = world.stations['drive-thru'].newOrder();
    world.advanceTo(5_000);
    expect(world.orders('counter').map((o) => o.id)).not.toContain(id);
    world.setLan('drive-thru', 'kitchen', true);
    world.advanceTo(8_000);
    expect(world.orders('counter').map((o) => o.id)).toContain(id); // multihop: through the kitchen
  });

  it('the cloud falls behind while the internet is cut and catches up after', () => {
    const world = new DemoWorld('crdt', { epoch: EPOCH });
    world.setInternet(false);
    world.stations.counter.newOrder();
    world.advanceTo(4_000);
    expect(world.cloudLag().inSync).toBe(false);
    expect(world.uplink()).toBeUndefined();
    world.setInternet(true);
    world.advanceTo(8_000);
    expect(world.cloudLag()).toEqual({ inSync: true, missingEdits: 0 });
    expect(world.uplink()).toBe('counter');
  });

  it('finished orders refuse edits on the screen that shows them finished, except picking up a canceled one', () => {
    const world = new DemoWorld('crdt', { epoch: EPOCH });
    const counter = world.stations.counter;
    const id = counter.newOrder();
    expect(counter.cancel(id)).toBe(true);
    expect(counter.addItem(id)).toBe(false);
    expect(counter.advance(id)).toBe(true); // canceled -> picked up
    expect(counter.advance(id)).toBe(false);
  });
});
