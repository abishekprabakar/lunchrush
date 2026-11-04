import { Replica, type Delta, type OrderView, type VersionVector } from '@lunchrush/core';
import { makeRng, type OrderStore } from '@lunchrush/sim';
import { Journal } from './journal';
import { DEVICE_LABEL, deviceOf, emptyIntended, orderLabel, STAGE_LABEL, Station, type Device } from './station';

/** The part of BroadcastChannel we use, so tests can pass an in-memory stand-in. */
export interface Channel {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

type TabMessage =
  | { type: 'summary'; from: string; vv: VersionVector }
  | { type: 'delta'; from: string; to: string; delta: Delta };

/**
 * Multi-tab mode: each browser tab is one device with its own replica, and tabs
 * sync through BroadcastChannel, with no server at all.
 *
 * The protocol is the same anti-entropy as everywhere else: every tab
 * periodically broadcasts its version vector, and any tab that has edits the
 * sender is missing answers with exactly those. New local edits are also pushed
 * straight away so other tabs update instantly.
 *
 * Each tab gets a fresh replica id ("kitchen.k3f9"), so a reloaded tab never
 * reuses edit numbers from its previous life.
 */
export class TabPeer {
  readonly id: string;
  readonly replica: Replica;
  readonly journal: Journal;
  readonly station: Station;
  online = true;
  onChange?: () => void;

  private readonly lastHeard = new Map<string, number>();
  private itemCount = 0;
  private readonly reportedStale = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly role: Device,
    private readonly channel: Channel,
    private readonly now: () => number = Date.now,
    suffix = Math.random().toString(36).slice(2, 6),
  ) {
    this.id = `${role}.${suffix}`;
    this.replica = new Replica(this.id, { now });
    this.journal = new Journal(now);
    const replica = this.replica;
    const pushing: OrderStore = {
      createOrder: (orderId, info) => this.push(replica.createOrder(orderId, info)),
      addItem: (orderId, itemId, item) => this.push(replica.addItem(orderId, itemId, item)),
      setStatus: (orderId, status) => this.push(replica.setStatus(orderId, status)),
      orders: () => replica.orders(),
      order: (orderId) => replica.order(orderId),
    };
    // Item ids start with the time in base 36, so items from different tabs list in the order they were added.
    const itemId = () => `i${now().toString(36)}${(++this.itemCount).toString(36)}`;
    this.station = new Station(role, pushing, this.journal, makeRng(hash(this.id)), emptyIntended(), `.${suffix}`, itemId);
    channel.onmessage = (event) => this.receive(event.data as TabMessage);
  }

  start(intervalMs = 600): void {
    this.timer = setInterval(() => this.gossip(), intervalMs);
    this.gossip();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.journal.add('network', online ? 'This tab is back on the network' : 'This tab went offline: it keeps working on its own');
    if (online) this.gossip();
    this.onChange?.();
  }

  orders(): OrderView[] {
    return this.replica.orders();
  }

  /** Devices of the other tabs heard from in the last few seconds. */
  connectedPeers(): string[] {
    const recent = [...this.lastHeard].filter(([, at]) => this.now() - at < 2_500).map(([id]) => deviceOf(id));
    return [...new Set(recent)].sort();
  }

  private gossip(): void {
    if (this.online) this.post({ type: 'summary', from: this.id, vv: this.replica.versionVector() });
  }

  private push(delta: Delta): Delta {
    if (this.online) this.post({ type: 'delta', from: this.id, to: '*', delta });
    this.onChange?.();
    return delta;
  }

  private post(message: TabMessage): void {
    this.channel.postMessage(message);
  }

  private receive(message: TabMessage): void {
    if (!this.online || message.from === this.id) return;
    this.lastHeard.set(message.from, this.now());
    if (message.type === 'summary') {
      if (this.replica.hasEditsMissingFrom(message.vv)) {
        this.post({ type: 'delta', from: this.id, to: message.from, delta: this.replica.deltaFor(message.vv) });
      }
      return;
    }
    if (message.to !== '*' && message.to !== this.id) return;
    const result = this.replica.merge(message.delta);
    if (result.newEdits > 0) {
      const sender = DEVICE_LABEL[deviceOf(message.from) as Device] ?? message.from;
      this.journal.add('sync', `${sender} tab → this tab: ${result.newEdits} new edit${result.newEdits === 1 ? '' : 's'}`);
    }
    for (const { orderId, write, winner } of result.staleStatusWrites) {
      if (this.reportedStale.has(write.dot)) continue;
      this.reportedStale.add(write.dot);
      this.journal.add(
        'stale',
        `${deviceOf(write.hlc.node)}'s “${STAGE_LABEL[write.value].toLowerCase()}” on ${orderLabel(orderId)} arrived after “${STAGE_LABEL[winner.value].toLowerCase()}” and lost: status only moves forward`,
      );
    }
    if (result.newEdits > 0 || result.staleStatusWrites.length > 0) this.onChange?.();
  }
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
