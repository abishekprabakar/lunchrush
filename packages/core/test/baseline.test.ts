import { describe, expect, it } from 'vitest';
import { BaselineReplica, Replica } from '../src';

/**
 * The same story run against both engines:
 * an order is placed and synced, then the internet drops. While offline, the
 * drive-thru adds a cookie and the counter adds a lemonade to the same order.
 * Then the devices reconnect and sync.
 */
describe('two offline devices edit the same order', () => {
  it('naive whole-document last-write-wins loses one of the edits', () => {
    let time = 1_000;
    const driveThru = new BaselineReplica('drive-thru', () => time);
    const counter = new BaselineReplica('counter', () => time);
    driveThru.createOrder('o1', { customer: 'Sam', channel: 'drive-thru' });
    driveThru.addItem('o1', 'i1', { name: 'sandwich', qty: 1 });
    counter.merge(driveThru.fullState());

    time = 2_000;
    driveThru.addItem('o1', 'i2', { name: 'cookie', qty: 2 });
    time = 3_000;
    counter.addItem('o1', 'i3', { name: 'lemonade', qty: 1 });

    const fromDriveThru = driveThru.fullState();
    const fromCounter = counter.fullState();
    driveThru.merge(fromCounter);
    counter.merge(fromDriveThru);

    expect(driveThru.orders()).toEqual(counter.orders()); // they agree...
    expect(driveThru.order('o1')?.items.map((i) => i.name)).toEqual(['sandwich', 'lemonade']); // ...but the cookie is gone
  });

  it('naive last-write-wins also drops whole orders taken offline', () => {
    let time = 1_000;
    const driveThru = new BaselineReplica('drive-thru', () => time);
    const counter = new BaselineReplica('counter', () => time);
    driveThru.createOrder('o1', { customer: 'Ana', channel: 'drive-thru' });
    time = 2_000;
    counter.createOrder('o2', { customer: 'Ben', channel: 'counter' });
    driveThru.merge(counter.fullState());
    expect(driveThru.orders().map((o) => o.id)).toEqual(['o2']); // Ana's order vanished
  });

  it('the CRDT keeps both edits', () => {
    let time = 1_000;
    const driveThru = new Replica('drive-thru', { now: () => time });
    const counter = new Replica('counter', { now: () => time });
    driveThru.createOrder('o1', { customer: 'Sam', channel: 'drive-thru' });
    driveThru.addItem('o1', 'i1', { name: 'sandwich', qty: 1 });
    counter.merge(driveThru.deltaFor(counter.versionVector()));

    time = 2_000;
    driveThru.addItem('o1', 'i2', { name: 'cookie', qty: 2 });
    time = 3_000;
    counter.addItem('o1', 'i3', { name: 'lemonade', qty: 1 });

    const fromDriveThru = driveThru.deltaFor(counter.versionVector());
    const fromCounter = counter.deltaFor(driveThru.versionVector());
    driveThru.merge(fromCounter);
    counter.merge(fromDriveThru);

    expect(driveThru.orders()).toEqual(counter.orders());
    expect(driveThru.order('o1')?.items.map((i) => i.name)).toEqual(['sandwich', 'cookie', 'lemonade']);
  });
});
