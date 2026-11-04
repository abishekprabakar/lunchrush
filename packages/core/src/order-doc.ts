import { awFilter, awHas, awJoin, isEmpty, type AwMap } from './awmap';
import {
  ctxSince,
  ctxUnion,
  vvIncludes,
  type CausalContext,
  type Dot,
  type VersionVector,
} from './causal-context';
import { compareHlc, type Hlc } from './hlc';
import { forwardJoin, lwwJoin, type Write } from './register';

/** The stages of an order, in the only direction it can move. */
export const STATUSES = ['new', 'cooking', 'ready', 'picked_up'] as const;
export type Status = (typeof STATUSES)[number];

/** How far along a stage is: new = 0, cooking = 1, ... */
export function statusRank(status: Status): number {
  return STATUSES.indexOf(status);
}

const statusJoin = forwardJoin(statusRank);

export interface OrderInfo {
  customer: string;
  channel: string;
}

export interface LineItem {
  name: string;
  qty: number;
}

/**
 * The CRDT value of one order:
 *   info   - who ordered and where, a last-writer-wins register
 *   status - a forward-only register: merge keeps the furthest stage, never a stale earlier one
 *   items  - line items, an add-wins map of last-writer-wins registers
 */
export interface OrderValue {
  info?: Write<OrderInfo>;
  status?: Write<Status>;
  items: AwMap<Write<LineItem>>;
}

/**
 * Everything a replica knows: the orders (an add-wins map keyed by order id)
 * and the causal context listing every edit those orders already include.
 */
export interface DocState {
  orders: AwMap<OrderValue>;
  context: CausalContext;
}

export function emptyDoc(): DocState {
  return { orders: {}, context: {} };
}

function orderValue(info?: Write<OrderInfo>, status?: Write<Status>, items: OrderValue['items'] = {}): OrderValue {
  return { ...(info ? { info } : {}), ...(status ? { status } : {}), items };
}

function joinOrderValue(a: OrderValue | undefined, b: OrderValue | undefined): OrderValue | undefined {
  if (!a) return b;
  if (!b) return a;
  return orderValue(lwwJoin(a.info, b.info), statusJoin(a.status, b.status), awJoin(a.items, b.items, lwwJoin));
}

export function joinOrders(a: AwMap<OrderValue>, b: AwMap<OrderValue>): AwMap<OrderValue> {
  return awJoin(a, b, joinOrderValue);
}

/**
 * The merge. Every step is a set union or a max, so it is commutative,
 * associative and idempotent, and replicas can merge in any order, any number
 * of times, and still agree.
 */
export function joinDocs(a: DocState, b: DocState): DocState {
  return { orders: joinOrders(a.orders, b.orders), context: ctxUnion(a.context, b.context) };
}

/**
 * Cut out the part of `doc` that a peer with version vector `vv` is missing:
 * every piece whose dot the peer has not seen, plus the matching slice of the context.
 */
export function docSince(doc: DocState, vv: VersionVector): DocState {
  const keep = (dot: Dot) => !vvIncludes(vv, dot);
  const keepWrite = <T>(reg: Write<T> | undefined) => (reg && keep(reg.dot) ? reg : undefined);
  const filterValue = (v: OrderValue): OrderValue | undefined => {
    const info = keepWrite(v.info);
    const status = keepWrite(v.status);
    const items = awFilter(v.items, keep, (item) => keepWrite(item));
    if (!info && !status && isEmpty(items)) return undefined;
    return orderValue(info, status, items);
  };
  return { orders: awFilter(doc.orders, keep, filterValue), context: ctxSince(doc.context, vv) };
}

export interface ItemView {
  id: string;
  name: string;
  qty: number;
}

export interface OrderView {
  id: string;
  /** Missing only while the order's creation is still in flight from another device. */
  info?: OrderInfo;
  createdAt?: Hlc;
  status: Status;
  /** When the order first reached its current stage. */
  statusSince?: Hlc;
  items: ItemView[];
}

/** What the screen shows: present orders and present items, in a deterministic order. */
export function viewOrders(orders: AwMap<OrderValue>): OrderView[] {
  const views: OrderView[] = [];
  for (const [id, entry] of Object.entries(orders)) {
    if (!awHas(entry)) continue;
    const value = entry.value ?? orderValue();
    const items: ItemView[] = [];
    for (const [itemId, item] of Object.entries(value.items)) {
      if (awHas(item) && item.value) items.push({ id: itemId, ...item.value.value });
    }
    items.sort((x, y) => compareStrings(x.id, y.id));
    views.push({
      id,
      info: value.info?.value,
      createdAt: value.info?.hlc,
      status: value.status?.value ?? 'new',
      statusSince: value.status?.hlc,
      items,
    });
  }
  return views.sort(
    (x, y) =>
      (x.createdAt && y.createdAt ? compareHlc(x.createdAt, y.createdAt) : x.createdAt ? -1 : y.createdAt ? 1 : 0) ||
      compareStrings(x.id, y.id),
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
