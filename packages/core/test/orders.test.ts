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

  it('cleanup removes a finished order from the map everywhere, and refuses unfinished ones', () => {
    const { counter, kitchen, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.createOrder('o2', { customer: 'Ana', channel: 'counter' });
    counter.setStatus('o1', 'picked_up');
    syncBoth();
    counter.removeFinishedOrder('o1');
    syncBoth();
    expect(kitchen.orders().map((o) => o.id)).toEqual(['o2']);
    expect(() => counter.removeFinishedOrder('o2')).toThrow(/only finished orders/);
  });

  it('cleanup is add-wins: a concurrent edit brings a finished order back, still finished', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.setStatus('o1', 'ready');
    syncBoth();
    tick();
    counter.setStatus('o1', 'picked_up');
    counter.removeFinishedOrder('o1');
    tick();
    kitchen.addItem('o1', 'napkins', { name: 'napkins', qty: 1 }); // still sees "ready"
    syncBoth();
    expect(counter.order('o1')?.status).toBe('picked_up');
    // cleaning up again after seeing that edit removes it for good
    counter.removeFinishedOrder('o1');
    syncBoth();
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

describe('cancel is the final stage', () => {
  it('a canceled order stays canceled when another device edits it concurrently', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    syncBoth();
    // offline: the counter cancels while the kitchen, not knowing, keeps working on it
    tick();
    counter.cancelOrder('o1');
    tick();
    kitchen.setStatus('o1', 'ready');
    kitchen.addItem('o1', 'cookie', { name: 'cookie', qty: 1 });
    syncBoth();
    expect(counter.order('o1')?.status).toBe('canceled');
    expect(kitchen.order('o1')?.status).toBe('canceled');
    expect(counter.order('o1')?.items.map((i) => i.name)).toEqual(['cookie']); // the edit merged; it just doesn't revive the order
    expect(kitchen.state()).toEqual(counter.state());
  });

  it('a concurrent pick-up beats a cancel, because the customer has the food', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.setStatus('o1', 'ready');
    syncBoth();
    tick();
    kitchen.setStatus('o1', 'picked_up');
    tick();
    counter.cancelOrder('o1'); // later, but an earlier stage
    syncBoth();
    expect(counter.order('o1')?.status).toBe('picked_up');
    expect(kitchen.order('o1')?.status).toBe('picked_up');
  });
});

describe('finished orders are read-only on a device that sees them as finished', () => {
  it.each(['canceled', 'picked_up'] as const)('refuses every edit to a %s order', (finish) => {
    const { counter } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.addItem('o1', 'fries', { name: 'fries', qty: 1 });
    counter.setStatus('o1', finish);
    const refused = /finished orders can't be edited/;
    expect(() => counter.addItem('o1', 'cookie', { name: 'cookie', qty: 1 })).toThrow(refused);
    expect(() => counter.updateItem('o1', 'fries', { name: 'fries', qty: 2 })).toThrow(refused);
    expect(() => counter.removeItem('o1', 'fries')).toThrow(refused);
    expect(() => counter.setStatus('o1', 'ready')).toThrow(refused);
    expect(() => counter.cancelOrder('o1')).toThrow(refused);
    expect(() => counter.createOrder('o1', { customer: 'Sam', channel: 'counter' })).toThrow(refused);
    expect(() => counter.removeFinishedOrder('o1')).not.toThrow(); // cleanup is the one thing allowed
  });

  it('a device that sees an order canceled can still record the pick-up, and nothing else', () => {
    const { counter, kitchen, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    counter.setStatus('o1', 'ready');
    counter.cancelOrder('o1');
    syncBoth();
    // the customer shows up and takes the bag anyway: the kitchen records what physically happened
    kitchen.setStatus('o1', 'picked_up');
    syncBoth();
    expect(counter.order('o1')?.status).toBe('picked_up');
    expect(kitchen.state()).toEqual(counter.state());
    // now picked up, so every edit is refused, including going back to canceled
    expect(() => kitchen.cancelOrder('o1')).toThrow(/finished orders can't be edited/);
    expect(() => kitchen.setStatus('o1', 'picked_up')).toThrow(/finished orders can't be edited/);
  });

  it('still merges edits made elsewhere before that device saw the order finish', () => {
    const { counter, kitchen, tick, syncBoth } = twoDevices();
    counter.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    syncBoth();
    tick();
    counter.cancelOrder('o1');
    tick();
    kitchen.addItem('o1', 'cookie', { name: 'cookie', qty: 1 }); // kitchen still sees "new"
    counter.merge(kitchen.deltaFor(counter.versionVector()));
    expect(counter.order('o1')?.items.map((i) => i.name)).toEqual(['cookie']);
    expect(counter.order('o1')?.status).toBe('canceled');
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
