import { statusRank } from '@lunchrush/core';
import { describe, expect, it } from 'vitest';
import { generateWorkload, LUNCH_RUSH, makeRng, renderResults, runLunchRush, type LunchRushResult } from '../src';

describe('the workload', () => {
  const intents = generateWorkload(makeRng(9), [
    { start: 0, end: 60_000, orders: 20, statusEdits: 10 },
    { start: 60_000, end: 660_000, orders: 200, statusEdits: 100 },
  ]);

  it('has the requested number of orders and status edits in each phase', () => {
    const during = (kind: string, from: number, to: number) =>
      intents.filter((i) => i.kind === kind && i.at >= from && i.at < to).length;
    expect(during('order', 0, 60_000)).toBe(20);
    expect(during('order', 60_000, 660_000)).toBe(200);
    expect(during('status', 0, 60_000)).toBe(10);
    expect(during('status', 60_000, 660_000)).toBe(100);
  });

  it('only moves each order forward, and only after it exists', () => {
    const created = new Map<string, number>();
    const stage = new Map<string, number>();
    for (const intent of intents) {
      if (intent.kind === 'order') {
        created.set(intent.orderId, intent.at);
        continue;
      }
      expect(intent.at - created.get(intent.orderId)!).toBeGreaterThanOrEqual(20_000);
      expect(statusRank(intent.status)).toBeGreaterThan(stage.get(intent.orderId) ?? 0);
      stage.set(intent.orderId, statusRank(intent.status));
      const kitchenStep = intent.status === 'cooking' || intent.status === 'ready';
      expect(kitchenStep ? ['kitchen'] : ['drive-thru', 'counter']).toContain(intent.device);
    }
  });
});

describe('the lunch-rush outage (full scenario: 10 minutes offline, 200 orders, 100 status edits)', () => {
  const results = Object.fromEntries(
    (['crdt-delta', 'crdt-full', 'baseline'] as const).map((engine) => [engine, runLunchRush(engine, 1)]),
  ) as Record<string, LunchRushResult>;

  it.each(['crdt-delta', 'crdt-full'])('%s loses nothing, duplicates nothing and converges after reconnect', (engine) => {
    const r = results[engine];
    expect(r.ordersCreated).toBe(220);
    expect(r).toMatchObject({ ordersLost: 0, itemsLost: 0, statusLost: 0, duplicates: 0, identicalAtEnd: true });
    expect(r.statusSkipped).toBe(0);
    expect(r.convergeMs).not.toBeNull();
    expect(r.messagesLost).toBeGreaterThan(0); // the network really was lossy
    expect(r.messagesDuplicated).toBeGreaterThan(0);
  });

  it('delta sync sends far fewer bytes than full-state sync', () => {
    const total = (r: LunchRushResult) => r.bytesLan + r.bytesInternet;
    expect(total(results['crdt-delta'])).toBeLessThan(total(results['crdt-full']) / 10);
  });

  it('the naive baseline converges onto data with holes in it', () => {
    const r = results.baseline;
    expect(r.identicalAtEnd).toBe(true);
    expect(r.ordersLost).toBeGreaterThan(0);
  });

  it('single uplink cuts internet bytes and redundant answers without losing anything', () => {
    const before = runLunchRush('crdt-delta', 1, { ...LUNCH_RUSH, singleUplink: false });
    const after = results['crdt-delta'];
    expect(LUNCH_RUSH.singleUplink).toBe(true);
    expect(after.bytesInternet).toBeLessThan(before.bytesInternet / 2);
    expect(after.redundantBytes / after.payloadBytes).toBeLessThan(before.redundantBytes / before.payloadBytes / 5);
    expect(after).toMatchObject({ ordersLost: 0, itemsLost: 0, statusLost: 0, identicalAtEnd: true });
  });

  it('is deterministic: the same seed gives the same numbers', () => {
    expect(runLunchRush('crdt-delta', 1)).toEqual(results['crdt-delta']);
  });

  it('renders a results table with a row per engine', () => {
    const markdown = renderResults(Object.values(results), LUNCH_RUSH, 'test');
    expect(markdown).toContain('| CRDT, delta sync | 0 | 0 | 0 | 0 |');
    expect(markdown).toContain('| Naive last-write-wins |');
    expect(markdown).toMatch(/delta sync sent \*\*[\d.]+x fewer bytes\*\*/);
  });
});
