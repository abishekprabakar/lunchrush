import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabPeer, type Channel } from '../src/tabs';

/** An in-memory stand-in for BroadcastChannel: messages reach every other tab asynchronously. */
function bus() {
  const members: Channel[] = [];
  return () => {
    const channel: Channel = {
      onmessage: null,
      postMessage: (message) => {
        const copy = structuredClone(message);
        for (const other of members) if (other !== channel) setTimeout(() => other.onmessage?.({ data: copy } as MessageEvent), 5);
      },
    };
    members.push(channel);
    return channel;
  };
}

describe('multi-tab mode', () => {
  afterEach(() => vi.useRealTimers());

  it('three tabs sync orders with no server, and an offline tab catches up when it reconnects', () => {
    vi.useFakeTimers();
    const join = bus();
    const [driveThru, counter, kitchen] = (['drive-thru', 'counter', 'kitchen'] as const).map(
      (role, i) => new TabPeer(role, join(), Date.now, `t${i}`),
    );
    for (const tab of [driveThru, counter, kitchen]) tab.start(600);

    const id = driveThru.station.newOrder();
    vi.advanceTimersByTime(100);
    expect(kitchen.orders().map((o) => o.id)).toEqual([id]);
    expect(kitchen.connectedPeers()).toEqual(['counter', 'drive-thru']);

    kitchen.setOnline(false);
    kitchen.station.advance(id); // cooking, made offline
    counter.station.addItem(id, { name: 'cookie', qty: 1 });
    vi.advanceTimersByTime(2_000);
    expect(driveThru.orders()[0].status).toBe('new');

    kitchen.setOnline(true);
    vi.advanceTimersByTime(2_000);
    for (const tab of [driveThru, counter, kitchen]) {
      expect(tab.orders()[0].status).toBe('cooking');
      expect(tab.orders()[0].items.map((i) => i.name)).toContain('cookie');
      tab.stop();
    }
    expect(kitchen.replica.state()).toEqual(driveThru.replica.state());
  });

  it('gives every tab its own replica id, so a reloaded tab never reuses edit numbers', () => {
    const join = bus();
    const a = new TabPeer('kitchen', join());
    const b = new TabPeer('kitchen', join());
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('kitchen.')).toBe(true);
  });
});
