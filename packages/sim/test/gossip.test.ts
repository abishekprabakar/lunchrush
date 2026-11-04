import { describe, expect, it } from 'vitest';
import {
  createEngine,
  makeRng,
  Network,
  SimNode,
  Simulation,
  type EngineKind,
  type LinkConfig,
  type WireMessage,
} from '../src';

const LAN: LinkConfig = { latencyMs: 5, jitterMs: 10, loss: 0, duplicate: 0, bytesPerSecond: 2_500_000 };

/** A few gossiping nodes on a network we control. */
function cluster(kind: EngineKind, ids: string[], links: [string, string][], link: LinkConfig = LAN) {
  const sim = new Simulation();
  const net = new Network<WireMessage>(sim, makeRng(7));
  const nodes = Object.fromEntries(
    ids.map((id) => [id, new SimNode(id, createEngine(kind, id, () => 1_000_000 + sim.now), net)]),
  );
  for (const [a, b] of links) net.connect(a, b, 'lan', link);
  ids.forEach((id, i) => nodes[id].start(sim, 1_000, i * 137));
  const store = (id: string) => nodes[id].engine.store;
  const orderIds = (id: string) => store(id).orders().map((o) => o.id);
  return { sim, net, store, orderIds };
}

describe('anti-entropy gossip', () => {
  it('two devices converge by swapping version vectors and missing deltas', () => {
    const { sim, store, orderIds } = cluster('crdt-delta', ['counter', 'kitchen'], [['counter', 'kitchen']]);
    store('counter').createOrder('o1', { customer: 'Sam', channel: 'counter' });
    store('kitchen').createOrder('o2', { customer: 'Ana', channel: 'counter' });
    sim.runUntil(3_000);
    expect(orderIds('counter')).toEqual(['o1', 'o2']);
    expect(orderIds('kitchen')).toEqual(['o1', 'o2']);
  });

  it('multihop: drive-thru and kitchen stay in sync through the counter without a direct link', () => {
    const { sim, net, store, orderIds } = cluster(
      'crdt-delta',
      ['drive-thru', 'counter', 'kitchen'],
      [
        ['drive-thru', 'counter'],
        ['counter', 'kitchen'],
      ],
    );
    expect(net.isUp('drive-thru', 'kitchen')).toBe(false);
    store('drive-thru').createOrder('o1', { customer: 'Sam', channel: 'drive-thru' });
    sim.runUntil(5_000);
    expect(orderIds('kitchen')).toEqual(['o1']);
    store('kitchen').setStatus('o1', 'ready');
    sim.runUntil(10_000);
    expect(store('drive-thru').order('o1')?.status).toBe('ready');
  });

  it('both sides of a partition keep working and converge once it heals', () => {
    const { sim, net, store, orderIds } = cluster(
      'crdt-delta',
      ['drive-thru', 'counter', 'kitchen'],
      [
        ['drive-thru', 'counter'],
        ['counter', 'kitchen'],
        ['drive-thru', 'kitchen'],
      ],
    );
    store('counter').createOrder('o1', { customer: 'Sam', channel: 'counter' });
    sim.runUntil(3_000);
    net.cut('drive-thru', 'counter');
    net.cut('drive-thru', 'kitchen'); // the drive-thru tablet is on its own
    store('drive-thru').createOrder('o2', { customer: 'Ana', channel: 'drive-thru' });
    store('kitchen').setStatus('o1', 'cooking');
    sim.runUntil(30_000);
    expect(orderIds('kitchen')).toEqual(['o1']);
    expect(store('drive-thru').order('o1')?.status).toBe('new');
    net.heal('drive-thru', 'counter');
    sim.runUntil(35_000);
    for (const id of ['drive-thru', 'counter', 'kitchen']) {
      expect(orderIds(id)).toEqual(['o1', 'o2']);
      expect(store(id).order('o1')?.status).toBe('cooking');
    }
  });

  it('converges on a terrible network: 30% loss, 10% duplicates, heavy reordering', () => {
    const awful = { ...LAN, loss: 0.3, duplicate: 0.1, jitterMs: 400 };
    const ids = ['drive-thru', 'counter', 'kitchen'];
    const { sim, store } = cluster('crdt-delta', ids, [
      ['drive-thru', 'counter'],
      ['counter', 'kitchen'],
    ], awful);
    for (let n = 1; n <= 30; n++) {
      sim.at(n * 200, () => store(ids[n % 3]).createOrder(`o${n}`, { customer: `guest ${n}`, channel: ids[n % 3] }));
    }
    sim.runUntil(60_000);
    const views = ids.map((id) => JSON.stringify(store(id).orders()));
    expect(store('kitchen').orders()).toHaveLength(30);
    expect(new Set(views).size).toBe(1);
  });

  it('delta sync moves fewer bytes than full-state sync for the same edits', () => {
    const bytes = (kind: EngineKind) => {
      const { sim, net, store } = cluster(kind, ['counter', 'kitchen'], [['counter', 'kitchen']]);
      for (let n = 1; n <= 40; n++) {
        sim.at(n * 1_000, () => store('counter').createOrder(`o${n}`, { customer: `guest ${n}`, channel: 'counter' }));
      }
      sim.runUntil(45_000);
      expect(store('kitchen').orders()).toHaveLength(40);
      return net.stats.bytes.lan;
    };
    expect(bytes('crdt-delta')).toBeLessThan(bytes('crdt-full') / 5);
  });

  it('the naive baseline also converges, but loses an order taken during a partition', () => {
    const { sim, net, store, orderIds } = cluster('baseline', ['counter', 'kitchen'], [['counter', 'kitchen']]);
    net.cut('counter', 'kitchen');
    store('counter').createOrder('o1', { customer: 'Sam', channel: 'counter' });
    sim.runUntil(1_000);
    store('kitchen').createOrder('o2', { customer: 'Ana', channel: 'counter' });
    net.heal('counter', 'kitchen');
    sim.runUntil(5_000);
    expect(orderIds('counter')).toEqual(orderIds('kitchen'));
    expect(orderIds('counter')).toEqual(['o2']); // o1 is gone
  });
});
