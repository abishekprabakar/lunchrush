import { canMoveTo, isFinished, statusRank, type LineItem, type OrderView, type Status } from '@lunchrush/core';
import { pick, randInt, type OrderStore, type Rng } from '@lunchrush/sim';
import type { Journal } from './journal';

export const DEVICES = ['drive-thru', 'counter', 'kitchen'] as const;
export type Device = (typeof DEVICES)[number];

export const DEVICE_LABEL: Record<Device, string> = { 'drive-thru': 'Drive-thru', counter: 'Counter', kitchen: 'Kitchen' };
const INITIAL: Record<Device, string> = { 'drive-thru': 'D', counter: 'C', kitchen: 'K' };

export const STAGE_LABEL: Record<Status, string> = {
  new: 'New',
  cooking: 'Cooking',
  ready: 'Ready',
  canceled: 'Canceled',
  picked_up: 'Picked up',
};

export const MENU = ['chicken sandwich', 'nuggets', 'waffle fries', 'lemonade', 'milkshake', 'cookie', 'salad'];
const NAMES = ['Ana', 'Ben', 'Cam', 'Dee', 'Eli', 'Fay', 'Gus', 'Ivy', 'Jo', 'Kai', 'Lu', 'Max'];

/** "drive-thru.k3f9" (a tab's replica id) -> "drive-thru". */
export function deviceOf(replicaId: string): string {
  return replicaId.split('.')[0];
}

/** "D3.k3f9" -> "D3", the number people see on the screen. */
export function orderLabel(orderId: string): string {
  return orderId.split('.')[0];
}

/** The next stage a person would tap, if this device's screen allows one. */
export function nextStage(status: Status): Status | undefined {
  const next: Partial<Record<Status, Status>> = {
    new: 'cooking',
    cooking: 'ready',
    ready: 'picked_up',
    canceled: 'picked_up',
  };
  const candidate = next[status];
  return candidate && canMoveTo(status, candidate) ? candidate : undefined;
}

/** Totals for scoring a run: what people meant to happen, whatever the engine kept. */
export interface Intended {
  orders: Set<string>;
  items: Map<string, string>; // itemId -> orderId
  furthest: Map<string, Status>;
}

/**
 * Everything a device's screen can do, written once for any store (the CRDT
 * replica or the naive baseline). Each action follows the same local rules as
 * the core (only forward, finished orders are read-only) and writes a line to
 * the sync log.
 */
export class Station {
  private orderCount = 0;

  constructor(
    readonly device: Device,
    private readonly store: OrderStore,
    private readonly journal: Journal,
    private readonly rng: Rng,
    private readonly intended: Intended,
    /** Appended to ids so two tabs playing the same device never clash. */
    private readonly idSuffix = '',
    /** Item ids sort in the order items were added, so screens list them that way. */
    private readonly nextItemId: () => string = counter('i'),
  ) {}

  orders(): OrderView[] {
    return this.store.orders();
  }

  newOrder(items: LineItem[] = randomItems(this.rng), customer = pick(this.rng, NAMES)): string {
    const orderId = `${INITIAL[this.device]}${++this.orderCount}${this.idSuffix}`;
    this.store.createOrder(orderId, { customer, channel: this.device });
    this.intended.orders.add(orderId);
    for (const item of items) this.addItemUnchecked(orderId, item);
    this.journal.add(
      'edit',
      `${DEVICE_LABEL[this.device]} took order ${orderLabel(orderId)} for ${customer}: ${items.map((i) => i.name).join(', ')}`,
    );
    return orderId;
  }

  addItem(orderId: string, item: LineItem = randomItems(this.rng, 1)[0]): boolean {
    const order = this.find(orderId);
    if (!order || isFinished(order.status)) return false;
    this.addItemUnchecked(orderId, item);
    this.journal.add('edit', `${DEVICE_LABEL[this.device]} added ${item.name} to ${orderLabel(orderId)}`);
    return true;
  }

  /** Move an order to `to`, or to the next stage if not given. */
  advance(orderId: string, to?: Status): boolean {
    const order = this.find(orderId);
    if (!order) return false;
    const target = to ?? nextStage(order.status);
    if (!target || !canMoveTo(order.status, target)) return false;
    this.store.setStatus(orderId, target);
    const before = this.intended.furthest.get(orderId) ?? 'new';
    if (statusRank(target) > statusRank(before)) this.intended.furthest.set(orderId, target);
    this.journal.add('edit', `${DEVICE_LABEL[this.device]} marked ${orderLabel(orderId)} ${STAGE_LABEL[target].toLowerCase()}`);
    return true;
  }

  cancel(orderId: string): boolean {
    return this.advance(orderId, 'canceled');
  }

  private addItemUnchecked(orderId: string, item: LineItem): void {
    const itemId = `${this.nextItemId()}${INITIAL[this.device]}${this.idSuffix}`;
    this.store.addItem(orderId, itemId, item);
    this.intended.items.set(itemId, orderId);
  }

  private find(orderId: string): OrderView | undefined {
    const order = this.store.order(orderId);
    if (!order) {
      this.journal.add('loss', `${DEVICE_LABEL[this.device]} can't find ${orderLabel(orderId)}: it is no longer on this screen`);
    }
    return order;
  }
}

/** "i0001", "i0002", ...: zero-padded so they sort as numbers. */
export function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(5, '0')}`;
}

export function emptyIntended(): Intended {
  return { orders: new Set(), items: new Map(), furthest: new Map() };
}

function randomItems(rng: Rng, count = randInt(rng, 1, 2)): LineItem[] {
  return Array.from({ length: count }, () => ({ name: pick(rng, MENU), qty: 1 }));
}
