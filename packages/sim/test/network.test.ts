import { describe, expect, it } from 'vitest';
import { makeRng, Network, Simulation, type LinkConfig } from '../src';

const QUIET: LinkConfig = { latencyMs: 10, jitterMs: 0, loss: 0, duplicate: 0, bytesPerSecond: 1_000_000 };

function setup(config: Partial<LinkConfig> = {}) {
  const sim = new Simulation();
  const net = new Network<{ n: number; pad?: string }>(sim, makeRng(42));
  const received: { n: number; at: number; from: string }[] = [];
  net.attach('b', (m, from) => received.push({ n: m.n, at: sim.now, from }));
  net.attach('c', (m, from) => received.push({ n: m.n, at: sim.now, from }));
  net.connect('a', 'b', 'lan', { ...QUIET, ...config });
  return { sim, net, received };
}

describe('simulation clock', () => {
  it('runs events in time order, and same-time events in the order they were scheduled', () => {
    const sim = new Simulation();
    const order: string[] = [];
    sim.at(20, () => order.push('late'));
    sim.at(10, () => order.push('first'));
    sim.at(10, () => order.push('second'));
    sim.every(15, () => order.push(`tick@${sim.now}`));
    sim.runUntil(31);
    expect(order).toEqual(['first', 'second', 'tick@15', 'late', 'tick@30']);
    expect(sim.now).toBe(31);
  });
});

describe('simulated network', () => {
  it('delivers a fresh copy after latency plus transmission time, and counts bytes', () => {
    const { sim, net } = setup();
    const message = { n: 1 };
    let got: unknown;
    net.attach('b', (m) => (got = m));
    net.send('a', 'b', message);
    sim.runUntil(1_000);
    expect(got).toEqual(message);
    expect(got).not.toBe(message); // serialized and parsed, like a real wire
    expect(net.stats.bytes.lan).toBe(JSON.stringify(message).length);
  });

  it('queues messages behind each other on a slow link', () => {
    const { sim, net, received } = setup({ bytesPerSecond: 1_000, latencyMs: 0 });
    const pad = 'x'.repeat(984); // {"n":1,"pad":"xxx..."} is exactly 1000 bytes
    net.send('a', 'b', { n: 1, pad });
    net.send('a', 'b', { n: 2, pad });
    sim.runUntil(10_000);
    expect(received.map((r) => [r.n, Math.round(r.at)])).toEqual([
      [1, 1_000],
      [2, 2_000],
    ]);
  });

  it('links on the same pipe share bandwidth; separate links do not', () => {
    const sim = new Simulation();
    const net = new Network<{ pad: string }>(sim, makeRng(1));
    const arrivals: Record<string, number> = {};
    for (const id of ['cloud', 'x', 'y']) net.attach(id, (_m, from) => (arrivals[from] = sim.now));
    const slow = { ...QUIET, latencyMs: 0, bytesPerSecond: 1_000 };
    net.connect('a', 'cloud', 'internet', { ...slow, pipe: 'uplink' });
    net.connect('b', 'cloud', 'internet', { ...slow, pipe: 'uplink' });
    net.connect('a', 'x', 'lan', slow);
    net.connect('b', 'y', 'lan', slow);
    const pad = 'x'.repeat(990); // {"pad":"xxx..."} is exactly 1000 bytes
    net.send('a', 'cloud', { pad });
    net.send('b', 'cloud', { pad });
    sim.runUntil(10_000);
    expect(Math.round(arrivals.b)).toBe(2_000); // waited for a's message on the shared uplink
    net.send('a', 'x', { pad });
    net.send('b', 'y', { pad });
    sim.runUntil(20_000);
    expect(Math.round(arrivals.a)).toBe(11_000);
    expect(Math.round(arrivals.b)).toBe(11_000);
  });

  it('drops about the configured fraction of messages', () => {
    const { sim, net, received } = setup({ loss: 0.1 });
    for (let n = 0; n < 10_000; n++) net.send('a', 'b', { n });
    sim.runUntil(60_000);
    expect(received.length).toBeGreaterThan(8_800);
    expect(received.length).toBeLessThan(9_200);
    expect(net.stats.lost + received.length).toBe(10_000);
  });

  it('can deliver a message twice', () => {
    const { sim, net, received } = setup({ duplicate: 1 });
    net.send('a', 'b', { n: 7 });
    sim.runUntil(1_000);
    expect(received.map((r) => r.n)).toEqual([7, 7]);
  });

  it('a cut link carries nothing, loses what was in flight, and works again once healed', () => {
    const { sim, net, received } = setup({ latencyMs: 100 });
    net.send('a', 'b', { n: 1 });
    sim.runUntil(50);
    net.cut('a', 'b'); // n=1 is still in the air
    net.send('a', 'b', { n: 2 });
    expect(net.peersOf('a')).toEqual([]);
    sim.runUntil(500);
    net.heal('a', 'b');
    net.send('a', 'b', { n: 3 });
    sim.runUntil(1_000);
    expect(received.map((r) => r.n)).toEqual([3]);
    expect(net.peersOf('a')).toEqual(['b']);
  });
});
