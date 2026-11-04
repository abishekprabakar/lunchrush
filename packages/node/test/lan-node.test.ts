import { afterEach, describe, expect, it } from 'vitest';
import { LanNode, type LanNodeOptions } from '../src';

const running: LanNode[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((n) => n.stop()));
});

async function start(options: LanNodeOptions): Promise<LanNode> {
  const node = await new LanNode({ gossipMs: 100, host: '127.0.0.1', ...options }).start();
  running.push(node);
  return node;
}

const syncUrl = (node: LanNode) => `ws://127.0.0.1:${node.port}/sync`;
const orderIds = (node: LanNode) => node.state().orders.map((o) => o.id);

async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('real network mode', () => {
  it('two devices sync orders over a WebSocket', async () => {
    const counter = await start({ name: 'counter' });
    const kitchen = await start({ name: 'kitchen', peers: [syncUrl(counter)] });
    counter.replica.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    await eventually(() => orderIds(kitchen).includes('o1'));
    kitchen.replica.setStatus('o1', 'cooking');
    await eventually(() => counter.state().orders[0]?.status === 'cooking');
    expect(kitchen.state().peers).toEqual(['counter']);
  });

  it('killing the relay does not stop the store, and a restarted, empty relay catches up', async () => {
    const relay = await start({ name: 'cloud' });
    const port = relay.port;
    const counter = await start({ name: 'counter', relay: syncUrl(relay) });
    const kitchen = await start({ name: 'kitchen', relay: syncUrl(relay), peers: [syncUrl(counter)] });
    counter.replica.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    await eventually(() => orderIds(relay).includes('o1') && orderIds(kitchen).includes('o1'));

    await relay.stop();
    running.splice(running.indexOf(relay), 1);
    counter.replica.createOrder('o2', { customer: 'Ana', channel: 'counter' });
    await eventually(() => orderIds(kitchen).includes('o2')); // straight over the LAN

    const fresh = await start({ name: 'cloud', port });
    expect(fresh.state().orders).toEqual([]);
    await eventually(() => fresh.state().fingerprint === counter.state().fingerprint, 8_000);
    expect(orderIds(fresh)).toEqual(['o1', 'o2']);
    expect(fresh.id).not.toBe(relay.id); // a new incarnation never reuses edit numbers
  });

  it('finds peers on the local network with UDP multicast', async () => {
    const counter = await start({ name: 'counter', discovery: true, host: '0.0.0.0' });
    const kitchen = await start({ name: 'kitchen', discovery: true, host: '0.0.0.0' });
    counter.replica.createOrder('o1', { customer: 'Sam', channel: 'counter' });
    await eventually(() => orderIds(kitchen).includes('o1'), 8_000);
    expect(kitchen.state().peers).toContain('counter');
  });

  it('serves a small HTTP API for scripts and curl', async () => {
    const counter = await start({ name: 'counter' });
    const base = `http://127.0.0.1:${counter.port}`;
    const created = await fetch(`${base}/orders`, { method: 'POST', body: JSON.stringify({ customer: 'Ben', items: ['nuggets'] }) });
    const { orderId } = (await created.json()) as { orderId: string };
    const moved = await fetch(`${base}/orders/${encodeURIComponent(orderId)}/status`, { method: 'POST', body: JSON.stringify({ status: 'ready' }) });
    expect(moved.status).toBe(200);
    const backwards = await fetch(`${base}/orders/${encodeURIComponent(orderId)}/status`, { method: 'POST', body: JSON.stringify({ status: 'cooking' }) });
    expect(backwards.status).toBe(409);
    const state = (await (await fetch(`${base}/state`)).json()) as { orders: { id: string; status: string; items: { name: string }[] }[] };
    expect(state.orders).toMatchObject([{ id: orderId, status: 'ready', items: [{ name: 'nuggets' }] }]);
  });
});
