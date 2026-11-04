import { canMoveTo, statusRank, type OrderView, type Status } from '@lunchrush/core';
import { createEngine, type EngineKind } from './engines';
import { SimNode, type WireMessage } from './gossip';
import { Network, type LinkConfig } from './network';
import { makeRng } from './rng';
import { Simulation } from './simulation';
import { generateWorkload, type Device, type Intent } from './workload';

export const DEVICES: readonly Device[] = ['drive-thru', 'counter', 'kitchen'];
export const CLOUD = 'cloud';

/** Simulated time 0 is noon on a weekday, so device clocks read realistic epoch milliseconds. */
const NOON = Date.UTC(2026, 10, 3, 12, 0, 0);

export interface LunchRushConfig {
  /** Online period before the outage. */
  warmupMs: number;
  /** How long the internet (every device-to-cloud link) is down. */
  outageMs: number;
  /** How long to keep running after reconnecting, with no new edits. */
  tailMs: number;
  warmup: { orders: number; statusEdits: number };
  outage: { orders: number; statusEdits: number };
  gossipIntervalMs: number;
  lan: LinkConfig;
  internet: LinkConfig;
  clockSkewMs: Record<string, number>;
  /** When false, the drive-thru tablet and kitchen display can't reach each other and sync through the counter. */
  driveThruSeesKitchen: boolean;
}

export const LUNCH_RUSH: LunchRushConfig = {
  warmupMs: 60_000,
  outageMs: 600_000,
  tailMs: 60_000,
  warmup: { orders: 20, statusEdits: 10 },
  outage: { orders: 200, statusEdits: 100 },
  gossipIntervalMs: 1_000,
  // In-store Wi-Fi: fast, a little lossy.
  lan: { latencyMs: 5, jitterMs: 10, loss: 0.02, duplicate: 0.01, bytesPerSecond: 2_500_000 },
  // The store's internet uplink: slower, and shared by every device in the store.
  internet: { latencyMs: 40, jitterMs: 40, loss: 0.01, duplicate: 0.005, bytesPerSecond: 250_000, pipe: 'store-uplink' },
  clockSkewMs: { 'drive-thru': 1_200, counter: -700, kitchen: 300, cloud: 0 },
  driveThruSeesKitchen: false,
};

export interface LunchRushResult {
  engine: EngineKind;
  seed: number;
  ordersCreated: number;
  itemsCreated: number;
  statusPlanned: number;
  /** Status edits a device actually made. */
  statusApplied: number;
  /** Status edits a device refused: it didn't know the order yet, or its own screen didn't allow the change. */
  statusSkipped: number;
  /** Orders created on some device but missing on at least one node at the end. */
  ordersLost: number;
  /** Items missing from orders that did survive. */
  itemsLost: number;
  /** Surviving orders whose final status is not the furthest stage any device set. */
  statusLost: number;
  /** Order or item rows that appear more than once, or that nobody created. */
  duplicates: number;
  /** All four nodes show exactly the same orders at the end. */
  identicalAtEnd: boolean;
  /** Time from reconnecting until all four nodes had converged; null if they never did. */
  convergeMs: number | null;
  bytesLan: number;
  bytesInternet: number;
  /** Bytes of sync answers that arrived, and how many of them taught the receiver nothing new. */
  payloadBytes: number;
  redundantBytes: number;
  messagesSent: number;
  messagesLost: number;
  messagesDuplicated: number;
}

/**
 * The lunch-rush outage: three devices and a cloud node. After a short online
 * warm-up the internet drops, staff keep taking and progressing orders on the
 * LAN, then the internet comes back and the cloud catches up.
 */
export function runLunchRush(engine: EngineKind, seed: number, config: LunchRushConfig = LUNCH_RUSH): LunchRushResult {
  const sim = new Simulation();
  const net = new Network<WireMessage>(sim, makeRng(seed * 3 + 1));
  const phaseRng = makeRng(seed * 3 + 2);
  const outageStart = config.warmupMs;
  const reconnectAt = outageStart + config.outageMs;
  const workload = generateWorkload(makeRng(seed * 3 + 3), [
    { start: 0, end: outageStart, ...config.warmup },
    { start: outageStart, end: reconnectAt, ...config.outage },
  ]);

  // Topology: devices see each other on the LAN; each reaches the cloud over the shared uplink.
  const nodes = new Map<string, SimNode>();
  for (const id of [...DEVICES, CLOUD]) {
    const skew = config.clockSkewMs[id] ?? 0;
    nodes.set(id, new SimNode(id, createEngine(engine, id, () => NOON + sim.now + skew), net));
  }
  for (const [i, a] of DEVICES.entries()) {
    for (const b of DEVICES.slice(i + 1)) {
      const blocked = !config.driveThruSeesKitchen && [a, b].includes('drive-thru') && [a, b].includes('kitchen');
      if (!blocked) net.connect(a, b, 'lan', config.lan);
    }
    net.connect(a, CLOUD, 'internet', config.internet);
  }
  for (const node of nodes.values()) node.start(sim, config.gossipIntervalMs, phaseRng() * config.gossipIntervalMs);

  // The staff's work. Each status edit only happens if the device's own screen allows it.
  const created = new Map<string, string[]>(); // orderId -> itemIds
  const furthest = new Map<string, Status>();
  let statusApplied = 0;
  let statusSkipped = 0;
  const perform = (intent: Intent) => {
    const store = nodes.get(intent.device)!.engine.store;
    if (intent.kind === 'order') {
      store.createOrder(intent.orderId, intent.info);
      for (const { itemId, item } of intent.items) store.addItem(intent.orderId, itemId, item);
      created.set(intent.orderId, intent.items.map((i) => i.itemId));
      return;
    }
    const seen = store.order(intent.orderId);
    if (!seen || !canMoveTo(seen.status, intent.status)) {
      statusSkipped++;
      return;
    }
    store.setStatus(intent.orderId, intent.status);
    statusApplied++;
    const before = furthest.get(intent.orderId) ?? 'new';
    if (statusRank(intent.status) > statusRank(before)) furthest.set(intent.orderId, intent.status);
  };
  for (const intent of workload) sim.at(intent.at, () => perform(intent));

  // The outage.
  sim.at(outageStart, () => DEVICES.forEach((d) => net.cut(d, CLOUD)));
  sim.at(reconnectAt, () => DEVICES.forEach((d) => net.heal(d, CLOUD)));

  let convergedAt: number | null = null;
  net.onDeliver = () => {
    if (convergedAt !== null || sim.now < reconnectAt) return;
    const prints = [...nodes.values()].map((n) => n.engine.fingerprint());
    if (prints.every((p) => p === prints[0])) convergedAt = sim.now;
  };

  sim.runUntil(reconnectAt + config.tailMs);

  // Score the end state of every node against what the staff actually did.
  const views = [...nodes.values()].map((n) => n.engine.store.orders());
  const lostOrders = new Set<string>();
  const lostItems = new Set<string>();
  const lostStatus = new Set<string>();
  let duplicates = 0;
  for (const view of views) {
    const byId = new Map<string, OrderView>(view.map((o) => [o.id, o]));
    duplicates += view.length - byId.size + view.filter((o) => !created.has(o.id)).length;
    for (const [orderId, itemIds] of created) {
      const order = byId.get(orderId);
      if (!order) {
        lostOrders.add(orderId);
        continue;
      }
      const shown = order.items.map((i) => i.id);
      duplicates += shown.length - new Set(shown).size;
      for (const itemId of itemIds) if (!shown.includes(itemId)) lostItems.add(itemId);
      if (order.status !== (furthest.get(orderId) ?? 'new')) lostStatus.add(orderId);
    }
  }

  return {
    engine,
    seed,
    ordersCreated: created.size,
    itemsCreated: sum([...created.values()].map((items) => items.length)),
    statusPlanned: workload.filter((i) => i.kind === 'status').length,
    statusApplied,
    statusSkipped,
    ordersLost: lostOrders.size,
    itemsLost: lostItems.size,
    statusLost: lostStatus.size,
    duplicates,
    identicalAtEnd: views.every((v) => JSON.stringify(v) === JSON.stringify(views[0])),
    convergeMs: convergedAt === null ? null : convergedAt - reconnectAt,
    bytesLan: net.stats.bytes.lan,
    bytesInternet: net.stats.bytes.internet,
    payloadBytes: sum([...nodes.values()].map((n) => n.received.payloadBytes)),
    redundantBytes: sum([...nodes.values()].map((n) => n.received.redundantBytes)),
    messagesSent: net.stats.sent,
    messagesLost: net.stats.lost,
    messagesDuplicated: net.stats.duplicated,
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
