import { awLiveDots, isEmpty, type AwMap } from './awmap';
import {
  ctxFromDots,
  ctxSize,
  ctxToVv,
  ctxUnion,
  makeDot,
  vvCovers,
  type Dot,
  type ReplicaId,
  type VersionVector,
} from './causal-context';
import { HlcClock, type Hlc } from './hlc';
import {
  docSince,
  emptyDoc,
  joinDocs,
  joinOrders,
  isFinished,
  statusRank,
  viewOrders,
  type DocState,
  type LineItem,
  type OrderInfo,
  type OrderValue,
  type OrderView,
  type Status,
} from './order-doc';

/**
 * A delta is a small piece of state, shaped exactly like a full state, so it is
 * merged with the same join.
 *
 * `since` is the version vector the delta was cut against. The delta contains
 * everything the sender had beyond `since`, so its context can only be trusted
 * by a receiver that already has everything up to `since`, like a patch file
 * that needs the right base. A delta with `since: {}` (a single local edit, or a
 * full state) can be applied anywhere.
 */
export interface Delta extends DocState {
  from: ReplicaId;
  since: VersionVector;
  /** The sender's clock, so the receiver's next edit sorts after everything it just learned. */
  clock: Hlc;
}

export interface MergeResult {
  /** How many edits the receiver learned about for the first time. */
  newEdits: number;
  /** False if the receiver lacked the delta's base: it kept the data but did not advance its version vector. */
  baseCovered: boolean;
}

export interface ReplicaOptions {
  /** Physical clock in ms. Injected so tests and the simulator can control time. */
  now?: () => number;
}

/** One device's copy of the orders. */
export class Replica {
  private doc: DocState = emptyDoc();
  private seq = 0;
  private idCounter = 0;
  private readonly clock: HlcClock;

  constructor(
    readonly id: ReplicaId,
    options: ReplicaOptions = {},
  ) {
    if (id.includes(':')) throw new Error(`replica id must not contain ":" (got ${id})`);
    this.clock = new HlcClock(id, options.now);
  }

  // ---- Local edits. Each returns a delta holding just that edit, ready to broadcast.

  createOrder(orderId: string, info: OrderInfo): Delta {
    return this.edit((dot, hlc) => ({
      [orderId]: {
        adds: { [dot]: true },
        tombs: {},
        value: { info: { value: info, hlc, dot }, status: { value: 'new', hlc, dot }, items: {} },
      },
    }));
  }

  addItem(orderId: string, itemId: string, item: LineItem): Delta {
    return this.updateItem(orderId, itemId, item);
  }

  /** Add or overwrite a line item. Counts as an edit to the order, so it survives a concurrent cleanup. */
  updateItem(orderId: string, itemId: string, item: LineItem): Delta {
    return this.edit((dot, hlc) => ({
      [orderId]: {
        adds: { [dot]: true },
        tombs: {},
        value: { items: { [itemId]: { adds: { [dot]: true }, tombs: {}, value: { value: { ...item }, hlc, dot } } } },
      },
    }));
  }

  /** Remove a line item. Only removes the adds this device has seen; a concurrent add elsewhere survives. */
  removeItem(orderId: string, itemId: string): Delta {
    const seen = awLiveDots(this.doc.orders[orderId]?.value?.items[itemId]);
    return this.edit((dot) => ({
      [orderId]: { adds: {}, tombs: {}, value: { items: { [itemId]: { adds: {}, tombs: { [dot]: seen } } } } },
    }));
  }

  /**
   * Move an order to a later stage. Moving backwards (or to the same stage) is
   * refused: the merge would ignore such a write anyway, so it is almost
   * certainly a bug in the caller.
   */
  setStatus(orderId: string, status: Status): Delta {
    const current = this.statusOf(orderId);
    if (statusRank(status) <= statusRank(current)) {
      throw new Error(`order ${orderId} is already ${current}; status only moves forward`);
    }
    return this.edit((dot, hlc) => ({
      [orderId]: { adds: { [dot]: true }, tombs: {}, value: { status: { value: status, hlc, dot }, items: {} } },
    }));
  }

  /**
   * Cancel an order by moving it to the final stage. The order stays in the map,
   * and since no stage is further than "canceled", no concurrent edit can revive it.
   */
  cancelOrder(orderId: string): Delta {
    return this.setStatus(orderId, 'canceled');
  }

  /**
   * Remove a picked-up or canceled order from the map to free the screen.
   * Like any add-wins removal it only covers edits this device has seen, so a
   * concurrent edit elsewhere brings the order back, still in its finished stage.
   */
  removeFinishedOrder(orderId: string): Delta {
    const status = this.statusOf(orderId);
    if (!isFinished(status)) throw new Error(`order ${orderId} is ${status}; only finished orders can be removed`);
    const seen = awLiveDots(this.doc.orders[orderId]);
    return this.edit((dot) => ({ [orderId]: { adds: {}, tombs: { [dot]: seen } } }));
  }

  /** The local stage of an order, even one removed from the map. */
  statusOf(orderId: string): Status {
    return this.doc.orders[orderId]?.value?.status?.value ?? 'new';
  }

  /** A unique id for a new order or item, e.g. "order-kitchen-3". */
  newId(kind: string): string {
    return `${kind}-${this.id}-${++this.idCounter}`;
  }

  // ---- Sync

  versionVector(): VersionVector {
    return ctxToVv(this.doc.context);
  }

  /** Exactly what a peer with version vector `peerVv` is missing. */
  deltaFor(peerVv: VersionVector): Delta {
    return { from: this.id, since: { ...peerVv }, clock: this.clock.current(), ...docSince(this.doc, peerVv) };
  }

  /** The whole state as a delta. This is what full-state sync sends every time. */
  fullState(): Delta {
    return this.deltaFor({});
  }

  merge(delta: Delta): MergeResult {
    this.clock.receive(delta.clock);
    const before = ctxSize(this.doc.context);
    const baseCovered = vvCovers(this.versionVector(), delta.since);
    this.doc = {
      orders: joinOrders(this.doc.orders, delta.orders),
      // Without the base we keep the data (merging data is always safe) but we
      // cannot claim the delta's edits as seen. Anti-entropy fills the gap later.
      context: baseCovered ? ctxUnion(this.doc.context, delta.context) : this.doc.context,
    };
    return { newEdits: ctxSize(this.doc.context) - before, baseCovered };
  }

  // ---- Reading

  orders(): OrderView[] {
    return viewOrders(this.doc.orders);
  }

  order(orderId: string): OrderView | undefined {
    return this.orders().find((o) => o.id === orderId);
  }

  /** The raw CRDT state, for tests and debugging views. Treat as read-only. */
  state(): DocState {
    return this.doc;
  }

  private edit(build: (dot: Dot, hlc: Hlc) => AwMap<OrderValue>): Delta {
    const dot = makeDot(this.id, ++this.seq);
    const hlc = this.clock.now();
    const delta: Delta = {
      from: this.id,
      since: {},
      clock: hlc,
      orders: build(dot, hlc),
      context: ctxFromDots([dot]),
    };
    this.doc = joinDocs(this.doc, delta);
    return delta;
  }
}

export function isEmptyDelta(delta: Delta): boolean {
  return isEmpty(delta.orders) && isEmpty(delta.context);
}

/** Size of a message on the wire, as UTF-8 JSON. */
export function byteSize(message: unknown): number {
  return new TextEncoder().encode(JSON.stringify(message)).length;
}
