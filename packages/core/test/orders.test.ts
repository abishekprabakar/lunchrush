import { describe, expect, it } from 'vitest';
import { compareHlc, Replica } from '../src';

/** Two devices that start in sync. Each has its own controllable wall clock. */
function twoDevices(skewMs = 0) {
  let time = 1_000;
  const tick = (ms = 10) => (time += ms);
  const counter = new Replica('counter', { now: () => time });
  const kitchen = new Replica('kitchen', { now: () => time + skewMs });
  const syncBoth = () => {
    kitchen.merge(counter.deltaFor(kitchen.versionVector()));
    counter.merge(kitchen.deltaFor(counter.versionVector()));
  };
  return { counter, kitchen, tick, syncBoth };
}

describe('orders as an add-wins map', () => {
  it('creates an order with items and shows it in the view', () => {
    const { counter } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.addItem('o1', 'i1', { name: 'sandwich', qty: 1 });
    expect(counter.order('o1')).toMatchObject({
      info: { customer: 'Sam', channel: 'counter' },
      status: 'new',
      items: [{ id: 'i1', name: 'sandwich', qty: 1 }],
    });
  });

  it('add wins: an order cancelled on one device survives a concurrent edit on another', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    syncBoth();
    // offline: the counter cancels while the kitchen, not knowing, starts cooking it
    tick();
    counter.cancelOrder('o1');
    tick();
    kitchen.setStatus('o1', 'cooking');
    syncBoth();
    expect(counter.order('o1')?.status).toBe('cooking');
    expect(kitchen.order('o1')?.status).toBe('cooking');
    // a cancel made after seeing every edit does remove it, everywhere
    counter.cancelOrder('o1');
    syncBoth();
    expect(counter.order('o1')).toBeUndefined();
    expect(kitchen.order('o1')).toBeUndefined();
  });

  it('add wins for line items too: a concurrent quantity change keeps a removed item', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.addItem('o1', 'fries', { name: 'fries', qty: 1 });
    syncBoth();
    tick();
    counter.removeItem('o1', 'fries');
    tick();
    kitchen.updateItem('o1', 'fries', { name: 'fries', qty: 2 });
    syncBoth();
    expect(counter.order('o1')?.items).toEqual([{ id: 'fries', name: 'fries', qty: 2 }]);
    expect(kitchen.order('o1')?.items).toEqual(counter.order('o1')?.items);
  });

  it('a removed item does not come back when an old delta is replayed', () => {
    const { counter, kitchen } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    const addFries = counter.addItem('o1', 'fries', { name: 'fries', qty: 1 });
    kitchen.merge(counter.fullState());
    kitchen.merge(counter.removeItem('o1', 'fries'));
    kitchen.merge(addFries); // a duplicate, late copy of the add
    kitchen.merge(addFries);
    expect(kitchen.order('o1')?.items).toEqual([]);
  });

  it('shows an order whose items arrived before its creation, then fills in the details', () => {
    const { counter, kitchen } = twoDevices();
    const create = counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    const add = counter.addItem('o1', 'i1', { name: 'nuggets', qty: 8 });
    kitchen.merge(add); // delivered out of order
    expect(kitchen.order('o1')).toMatchObject({ info: undefined, items: [{ name: 'nuggets' }] });
    expect(kitchen.versionVector()).toEqual({}); // edit 2 is held in a gap; edit 1 is missing
    kitchen.merge(create);
    expect(kitchen.order('o1')?.info?.customer).toBe('Sam');
    expect(kitchen.versionVector()).toEqual({ counter: 2 });
  });
});

describe('status is a forward-only register', () => {
  it('a stale "cooking" never overwrites "ready", even when it has the later timestamp', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices(-60_000); // kitchen clock a minute slow
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    syncBoth();
    // offline: the kitchen finishes the order, and the counter, not knowing, marks it cooking
    tick();
    const ready = kitchen.setStatus('o1', 'ready');
    tick();
    const cooking = counter.setStatus('o1', 'cooking');
    expect(compareHlc(cooking.clock, ready.clock)).toBe(1); // last-writer-wins would pick "cooking"
    syncBoth();
    expect(counter.order('o1')?.status).toBe('ready');
    expect(kitchen.order('o1')?.status).toBe('ready');
  });

  it('concurrent stages resolve to the furthest one, regardless of time or device id', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    syncBoth();
    tick();
    counter.setStatus('o1', 'picked_up');
    tick();
    kitchen.setStatus('o1', 'ready'); // later, and "kitchen" > "counter", but an earlier stage
    syncBoth();
    expect(counter.order('o1')?.status).toBe('picked_up');
    expect(kitchen.state()).toEqual(counter.state());
  });

  it('when two devices reach the same stage, both keep the earlier write', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    syncBoth();
    tick();
    const first = kitchen.setStatus('o1', 'ready');
    tick();
    counter.setStatus('o1', 'ready');
    syncBoth();
    expect(counter.order('o1')?.statusSince).toEqual(first.clock);
    expect(kitchen.state()).toEqual(counter.state());
  });

  it('refuses to move an order backwards locally', () => {
    const { counter } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.setStatus('o1', 'ready');
    expect(() => counter.setStatus('o1', 'cooking')).toThrow(/only moves forward/);
    expect(() => counter.setStatus('o1', 'ready')).toThrow(/only moves forward/);
    expect(counter.order('o1')?.status).toBe('ready');
  });
});

describe('info and line items are last-writer-wins on the HLC', () => {
  it('an edit made after seeing another wins, even if its wall clock is behind', () => {
    const { counter, kitchen, syncBoth } = twoDevices(-60_000); // kitchen clock a minute slow
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.addItem('o1', 'fries', { name: 'fries', qty: 1 });
    counter.updateItem('o1', 'fries', { name: 'fries', qty: 2 });
    syncBoth();
    kitchen.updateItem('o1', 'fries', { name: 'fries', qty: 3 });
    syncBoth();
    expect(counter.order('o1')?.items).toEqual([{ id: 'fries', name: 'fries', qty: 3 }]);
  });
});
