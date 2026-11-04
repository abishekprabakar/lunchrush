import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { byteSize, isEmptyDelta, Replica, utf8Length } from '../src';

function busyCounter(orders: number) {
  const counter = new Replica('counter', { now: () => 1_000 });
  for (let n = 1; n <= orders; n++) {
    counter.createOrder(`o${n}`, { customer: `guest ${n}`, channel: 'counter' });
    counter.addItem(`o${n}`, `o${n}-i1`, { name: 'sandwich', qty: 1 });
  }
  return counter;
}

describe('version-vector delta sync', () => {
  it('sends nothing to a peer that is already up to date', () => {
    const counter = busyCounter(5);
    const kitchen = new Replica('kitchen');
    kitchen.merge(counter.deltaFor(kitchen.versionVector()));
    expect(isEmptyDelta(counter.deltaFor(kitchen.versionVector()))).toBe(true);
  });

  it('sends only the edits the peer is missing', () => {
    const counter = busyCounter(50);
    const kitchen = new Replica('kitchen');
    kitchen.merge(counter.fullState());
    counter.setStatus('o7', 'ready');

    const delta = counter.deltaFor(kitchen.versionVector());
    expect(Object.keys(delta.orders)).toEqual(['o7']);
    expect(delta.context).toEqual({ counter: [[101, 101]] });
    expect(byteSize(delta)).toBeLessThan(byteSize(counter.fullState()) / 20);

    kitchen.merge(delta);
    expect(kitchen.order('o7')?.status).toBe('ready');
    expect(kitchen.state()).toEqual(counter.state());
  });

  it('relays edits across hops: drive-thru and kitchen sync only through the counter', () => {
    const now = () => 1_000;
    const driveThru = new Replica('drive-thru', { now });
    const counter = new Replica('counter', { now });
    const kitchen = new Replica('kitchen', { now });
    driveThru.createOrder('o1', { customer: 'Ana', channel: 'drive-thru' });
    kitchen.createOrder('o2', { customer: 'Ben', channel: 'counter' });
    const hop = (from: Replica, to: Replica) => to.merge(from.deltaFor(to.versionVector()));
    hop(driveThru, counter);
    hop(kitchen, counter);
    hop(counter, driveThru);
    hop(counter, kitchen);
    expect(driveThru.orders().map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(kitchen.state()).toEqual(driveThru.state());
    expect(kitchen.versionVector()).toEqual({ 'drive-thru': 1, kitchen: 1 });
  });

  it('a gap from out-of-order deltas holds the version vector back until anti-entropy fills it', () => {
    const counter = new Replica('counter');
    const kitchen = new Replica('kitchen');
    const edits = [
      counter.createOrder('o1', { customer: 'Sam', channel: 'counter' }),
      counter.addItem('o1', 'i1', { name: 'fries', qty: 1 }),
      counter.setStatus('o1', 'cooking'),
    ];
    kitchen.merge(edits[0]);
    kitchen.merge(edits[2]); // edits[1] was lost on the network
    expect(kitchen.versionVector()).toEqual({ counter: 1 });
    expect(kitchen.order('o1')?.items).toEqual([]);

    const repair = counter.deltaFor(kitchen.versionVector());
    expect(repair.context).toEqual({ counter: [[2, 3]] });
    kitchen.merge(repair);
    expect(kitchen.versionVector()).toEqual({ counter: 3 });
    expect(kitchen.state()).toEqual(counter.state());
  });

  it('a delta merged without its base keeps the data but does not claim to be up to date', () => {
    const counter = busyCounter(3);
    const kitchen = new Replica('kitchen');
    const driveThru = new Replica('drive-thru');
    kitchen.merge(counter.fullState());
    counter.setStatus('o2', 'ready');
    const forKitchen = counter.deltaFor(kitchen.versionVector());

    const result = driveThru.merge(forKitchen); // delivered to the wrong device
    expect(result).toEqual({ newEdits: 0, baseCovered: false });
    expect(driveThru.versionVector()).toEqual({});
    expect(driveThru.order('o2')?.status).toBe('ready');

    driveThru.merge(counter.deltaFor(driveThru.versionVector()));
    expect(driveThru.state()).toEqual(counter.state());
  });
});

describe('message sizes', () => {
  it('counts UTF-8 bytes exactly like TextEncoder', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
      }),
    );
    for (const odd of ['\ud800', '\ud800x', 'x\udc00', '\udc00\ud800', '😀']) {
      expect(utf8Length(odd)).toBe(new TextEncoder().encode(odd).length);
    }
  });

  it('knows cheaply whether a peer is missing anything', () => {
    const counter = busyCounter(2);
    const kitchen = new Replica('kitchen');
    expect(counter.hasEditsMissingFrom(kitchen.versionVector())).toBe(true);
    kitchen.merge(counter.fullState());
    expect(counter.hasEditsMissingFrom(kitchen.versionVector())).toBe(false);
  });
});
