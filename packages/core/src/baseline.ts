import type { ItemView, LineItem, OrderInfo, OrderView, Status } from './order-doc';

/**
 * The naive approach many apps start with, kept here as a baseline to compare against.
 *
 * Every device holds a plain copy of the whole document and stamps it with the
 * wall-clock time of its last edit. To sync, devices send the whole document,
 * and the one with the later timestamp replaces the other. It always converges,
 * but when two devices edit while offline, everything one of them did is thrown away.
 */
export interface BaselineOrder {
  info: OrderInfo;
  status: Status;
  items: Record<string, LineItem>;
}

export interface BaselineDoc {
  orders: Record<string, BaselineOrder>;
  savedAt: number;
  savedBy: string;
}

export class BaselineReplica {
  private doc: BaselineDoc = { orders: {}, savedAt: 0, savedBy: '' };

  constructor(
    readonly id: string,
    private readonly now: () => number = Date.now,
  ) {}

  createOrder(orderId: string, info: OrderInfo): BaselineDoc {
    return this.edit((doc) => {
      doc.orders[orderId] = { info: { ...info }, status: 'new', items: {} };
    });
  }

  addItem(orderId: string, itemId: string, item: LineItem): BaselineDoc {
    return this.updateItem(orderId, itemId, item);
  }

  updateItem(orderId: string, itemId: string, item: LineItem): BaselineDoc {
    return this.edit((doc) => {
      this.mustFind(doc, orderId).items[itemId] = { ...item };
    });
  }

  removeItem(orderId: string, itemId: string): BaselineDoc {
    return this.edit((doc) => {
      delete this.mustFind(doc, orderId).items[itemId];
    });
  }

  setStatus(orderId: string, status: Status): BaselineDoc {
    return this.edit((doc) => {
      this.mustFind(doc, orderId).status = status;
    });
  }

  cancelOrder(orderId: string): BaselineDoc {
    return this.setStatus(orderId, 'canceled');
  }

  removeFinishedOrder(orderId: string): BaselineDoc {
    return this.edit((doc) => {
      this.mustFind(doc, orderId);
      delete doc.orders[orderId];
    });
  }

  fullState(): BaselineDoc {
    return structuredClone(this.doc);
  }

  /** Whole-document last-write-wins: keep whichever copy was saved later. Returns true if ours was replaced. */
  merge(remote: BaselineDoc): boolean {
    const remoteIsNewer =
      remote.savedAt > this.doc.savedAt || (remote.savedAt === this.doc.savedAt && remote.savedBy > this.doc.savedBy);
    if (remoteIsNewer) this.doc = structuredClone(remote);
    return remoteIsNewer;
  }

  orders(): OrderView[] {
    return Object.entries(this.doc.orders)
      .map(([id, order]) => ({
        id,
        info: { ...order.info },
        status: order.status,
        items: Object.entries(order.items)
          .map(([itemId, item]): ItemView => ({ id: itemId, ...item }))
          .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
      }))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  order(orderId: string): OrderView | undefined {
    return this.orders().find((o) => o.id === orderId);
  }

  private edit(change: (doc: BaselineDoc) => void): BaselineDoc {
    change(this.doc);
    this.doc.savedAt = this.now();
    this.doc.savedBy = this.id;
    return this.fullState();
  }

  private mustFind(doc: BaselineDoc, orderId: string): BaselineOrder {
    const order = doc.orders[orderId];
    if (!order) throw new Error(`unknown order ${orderId}`);
    return order;
  }
}
