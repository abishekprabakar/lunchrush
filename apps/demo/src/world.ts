import {
  BaselineReplica,
  isNewerVersion,
  Replica,
  statusRank,
  type BaselineDoc,
  type BaselineVersion,
  type Delta,
  type OrderView,
  type VersionVector,
} from '@lunchrush/core';
import {
  isStoreUplink,
  makeRng,
  Network,
  SimNode,
  Simulation,
  singleUplink,
  type LinkConfig,
  type OrderStore,
  type SyncEngine,
  type WireMessage,
} from '@lunchrush/sim';
import { Journal, plural } from './journal';
import { LUNCH_RUSH_SCRIPT, type ScriptStep } from './script';
import {
  counter,
  DEVICE_LABEL,
  DEVICES,
  deviceOf,
  emptyIntended,
  orderLabel,
  STAGE_LABEL,
  Station,
  type Device,
  type Intended,
} from './station';

export type EngineChoice = 'crdt' | 'naive';
export const CLOUD = 'cloud';

const GOSSIP_MS = 600;
const LAN: LinkConfig = { latencyMs: 20, jitterMs: 40, loss: 0, duplicate: 0, bytesPerSecond: 2_500_000 };
const INTERNET: LinkConfig = { latencyMs: 120, jitterMs: 80, loss: 0, duplicate: 0, bytesPerSecond: 250_000, pipe: 'store-uplink' };

export interface Caption {
  step: number;
  total: number;
  text: string;
}

export interface Score {
  orders: { kept: number; total: number };
  items: { kept: number; total: number };
  /** Orders showing an earlier stage than one a device actually set. */
  wentBack: number;
}

/**
 * The single-page demo: three devices and a cloud node on the simulated network
 * from packages/sim, driven in real time by the page. Every device runs its own
 * replica (CRDT) or its own whole-document copy (naive), and syncs only through
 * gossip messages, exactly as in the benchmark.
 */
export class DemoWorld {
  readonly journal: Journal;
  readonly stations: Record<Device, Station>;
  caption: Caption | null = null;
  playing = false;

  private readonly sim = new Simulation();
  private readonly net: Network<WireMessage>;
  private readonly stores = new Map<string, OrderStore>();
  private readonly replicas = new Map<string, Replica>();
  private readonly baselines = new Map<string, BaselineReplica>();
  private readonly activity = new Map<string, number>();
  private readonly reportedStale = new Set<string>();
  private readonly intended: Intended = emptyIntended();
  private readonly epoch: number;

  constructor(
    readonly engine: EngineChoice,
    options: { seed?: number; epoch?: number } = {},
  ) {
    const seed = options.seed ?? 7;
    this.epoch = options.epoch ?? noonToday();
    this.journal = new Journal(() => this.epoch + this.sim.now);
    this.net = new Network(this.sim, makeRng(seed));
    const phase = makeRng(seed + 1);
    const gossip = singleUplink(CLOUD, GOSSIP_MS);
    for (const id of [...DEVICES, CLOUD]) {
      const node = new SimNode(id, this.makeEngine(id), this.net, this.sim, gossip);
      node.start(GOSSIP_MS, phase() * GOSSIP_MS);
    }
    for (const [i, a] of DEVICES.entries()) {
      for (const b of DEVICES.slice(i + 1)) this.net.connect(a, b, 'lan', LAN);
      this.net.connect(a, CLOUD, 'internet', INTERNET);
    }
    const rng = makeRng(seed + 2);
    const itemIds = counter('i'); // shared, so items list in the order they were added on any device
    this.stations = Object.fromEntries(
      DEVICES.map((d) => [d, new Station(d, this.stores.get(d)!, this.journal, rng, this.intended, '', itemIds)]),
    ) as Record<Device, Station>;
  }

  // ---- Time

  get now(): number {
    return this.sim.now;
  }

  advanceTo(ms: number): void {
    if (ms > this.sim.now) this.sim.runUntil(ms);
  }

  // ---- Network controls

  get internetUp(): boolean {
    return DEVICES.some((d) => this.net.isUp(d, CLOUD));
  }

  setInternet(up: boolean): void {
    for (const d of DEVICES) {
      if (up) this.net.heal(d, CLOUD);
      else this.net.cut(d, CLOUD);
    }
    this.journal.add('network', up ? 'Internet restored' : 'Internet cut: the store is offline');
  }

  lanUp(a: Device, b: Device): boolean {
    return this.net.isUp(a, b);
  }

  setLan(a: Device, b: Device, up: boolean): void {
    if (this.net.isUp(a, b) === up) return;
    if (up) this.net.heal(a, b);
    else this.net.cut(a, b);
    this.journal.add('network', `Wi-Fi between ${DEVICE_LABEL[a]} and ${DEVICE_LABEL[b]} ${up ? 'restored' : 'cut'}`);
  }

  /** Cut or restore every Wi-Fi link of one device. */
  setIsolated(device: Device, isolated: boolean): void {
    for (const other of DEVICES) if (other !== device) this.setLan(device, other, !isolated);
  }

  lanPeers(device: Device): Device[] {
    return DEVICES.filter((d) => d !== device && this.net.isUp(device, d));
  }

  /** The device currently carrying the store's cloud traffic, if the internet is up. */
  uplink(): Device | undefined {
    return DEVICES.find((d) => this.net.isUp(d, CLOUD) && isStoreUplink(d, this.lanPeers(d)));
  }

  /** True if edits crossed this link in the last moment, so the diagram can light it up. */
  recentlyActive(a: string, b: string): boolean {
    const at = this.activity.get(linkKey(a, b));
    return at !== undefined && this.sim.now - at < 450;
  }

  // ---- Reading

  orders(node: string): OrderView[] {
    return this.stores.get(node)!.orders();
  }

  versionVector(node: string): VersionVector | undefined {
    return this.replicas.get(node)?.versionVector();
  }

  documentVersion(node: string): BaselineVersion | undefined {
    return this.baselines.get(node)?.version();
  }

  /** How far the cloud is behind the store: missing edits for the CRDT, just in-sync or not for naive. */
  cloudLag(): { inSync: boolean; missingEdits?: number } {
    const cloudVv = this.versionVector(CLOUD);
    if (cloudVv) {
      // For each device's own edits, the furthest any device has seen, minus what the cloud has.
      const missingEdits = DEVICES.reduce((sum, author) => {
        const furthest = Math.max(...DEVICES.map((d) => this.versionVector(d)![author] ?? 0));
        return sum + Math.max(0, furthest - (cloudVv[author] ?? 0));
      }, 0);
      return { inSync: missingEdits === 0, missingEdits };
    }
    const cloud = this.documentVersion(CLOUD)!;
    return {
      inSync: DEVICES.every((d) => {
        const v = this.documentVersion(d)!;
        return v.savedAt === cloud.savedAt && v.savedBy === cloud.savedBy;
      }),
    };
  }

  /** Did every order, item and stage people entered make it to every screen and the cloud? */
  score(): Score {
    const views = [...DEVICES, CLOUD].map((n) => new Map(this.orders(n).map((o) => [o.id, o])));
    const everywhere = (orderId: string) => views.every((v) => v.has(orderId));
    let wentBack = 0;
    for (const [orderId, stage] of this.intended.furthest) {
      if (views.some((v) => v.has(orderId) && v.get(orderId)!.status !== stage)) wentBack++;
    }
    const itemsKept = [...this.intended.items].filter(([itemId, orderId]) =>
      views.every((v) => v.get(orderId)?.items.some((i) => i.id === itemId)),
    ).length;
    return {
      orders: { kept: [...this.intended.orders].filter(everywhere).length, total: this.intended.orders.size },
      items: { kept: itemsKept, total: this.intended.items.size },
      wentBack,
    };
  }

  // ---- The guided lunch rush

  play(script: ScriptStep[] = LUNCH_RUSH_SCRIPT): void {
    const start = this.sim.now;
    const total = script.filter((s) => s.caption).length;
    let step = 0;
    const ids = new Map<string, string>();
    this.playing = true;
    for (const s of script) {
      this.sim.at(start + s.at, () => {
        if (s.caption) {
          const text = typeof s.caption === 'function' ? s.caption(this) : s.caption;
          this.caption = { step: ++step, total, text };
          this.journal.add('story', text);
        }
        s.run?.(this, ids);
        if (s.last) this.playing = false;
      });
    }
  }

  // ---- Engines with a sync log

  private makeEngine(id: string): SyncEngine {
    const now = () => this.epoch + this.sim.now;
    if (this.engine === 'crdt') {
      const replica = new Replica(id, { now });
      this.replicas.set(id, replica);
      this.stores.set(id, replica);
      return {
        kind: 'crdt-delta',
        store: replica,
        summary: () => replica.versionVector(),
        respond: (vv) => (replica.hasEditsMissingFrom(vv as VersionVector) ? replica.deltaFor(vv as VersionVector) : undefined),
        receive: (payload, from) => {
          const result = replica.merge(payload as Delta);
          if (result.newEdits > 0) {
            this.activity.set(linkKey(from, id), this.sim.now);
            this.journal.add('sync', `${nodeLabel(from)} → ${nodeLabel(id)}: ${plural(result.newEdits, 'new edit')}`);
          }
          for (const { orderId, write, winner } of result.staleStatusWrites) {
            if (this.reportedStale.has(write.dot)) continue;
            this.reportedStale.add(write.dot);
            this.journal.add(
              'stale',
              `${nodeLabel(deviceOf(write.hlc.node))}'s “${STAGE_LABEL[write.value].toLowerCase()}” on ${orderLabel(orderId)} arrived after “${STAGE_LABEL[winner.value].toLowerCase()}” and lost: status only moves forward`,
            );
          }
          return result.newEdits > 0;
        },
        fingerprint: () => JSON.stringify(replica.versionVector()),
      };
    }

    const doc = new BaselineReplica(id, now);
    this.baselines.set(id, doc);
    this.stores.set(id, doc);
    return {
      kind: 'baseline',
      store: doc,
      summary: () => doc.version(),
      respond: (peer) => (isNewerVersion(doc.version(), peer as BaselineVersion) ? doc.fullState() : undefined),
      receive: (payload, from) => {
        const before = doc.orders();
        if (!doc.merge(payload as BaselineDoc)) return false;
        this.activity.set(linkKey(from, id), this.sim.now);
        const losses = describeLosses(before, doc.orders());
        this.journal.add(
          losses.length > 0 ? 'loss' : 'sync',
          `${nodeLabel(id)} replaced its whole copy with ${nodeLabel(from)}'s newer one${losses.length > 0 ? `: ${losses.join('; ')}` : ''}`,
        );
        return true;
      },
      fingerprint: () => JSON.stringify(doc.version()),
    };
  }
}

/** What a whole-document replacement threw away, in words. */
function describeLosses(before: OrderView[], after: OrderView[]): string[] {
  const now = new Map(after.map((o) => [o.id, o]));
  const losses: string[] = [];
  for (const old of before) {
    const kept = now.get(old.id);
    if (!kept) {
      losses.push(`order ${orderLabel(old.id)} vanished`);
      continue;
    }
    for (const item of old.items) {
      if (!kept.items.some((i) => i.id === item.id)) losses.push(`${item.name} vanished from ${orderLabel(old.id)}`);
    }
    if (statusRank(kept.status) < statusRank(old.status)) {
      losses.push(`${orderLabel(old.id)} went back from ${STAGE_LABEL[old.status].toLowerCase()} to ${STAGE_LABEL[kept.status].toLowerCase()}`);
    }
  }
  return losses;
}

function nodeLabel(id: string): string {
  return id === CLOUD ? 'Cloud' : (DEVICE_LABEL[id as Device] ?? id);
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function noonToday(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}
