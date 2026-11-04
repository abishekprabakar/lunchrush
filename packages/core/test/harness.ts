/**
 * A tiny randomized world for property tests: three replicas, a message queue
 * that the test reorders, duplicates and (optionally) drops, and a log of every
 * edit so we can check afterwards that nothing was lost.
 */
import fc from 'fast-check';
import { canMoveTo, isFinished, Replica, STATUSES, statusRank, type Delta, type Status, type VersionVector } from '../src';

const MENU = ['sandwich', 'nuggets', 'fries', 'lemonade', 'cookie'];

export type Op =
  | { k: 'create' }
  | { k: 'add'; o: number; name: string; qty: number }
  | { k: 'update'; o: number; i: number; qty: number }
  | { k: 'remove'; o: number; i: number }
  | { k: 'status'; o: number; s: number } // s picks one of the stages ahead of the current one
  | { k: 'cancel'; o: number }
  | { k: 'cleanup'; o: number };

export type Cmd =
  | { t: 'op'; r: number; op: Op; tick: number }
  | { t: 'gossip'; asker: number; peer: number } // `asker` sends its version vector to `peer`
  | { t: 'deliver'; pick: number; keepCopy: boolean } // keepCopy => the message will arrive again later
  | { t: 'drop'; pick: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.constant({ k: 'create' as const }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant('add' as const), o: fc.nat(), name: fc.constantFrom(...MENU), qty: fc.integer({ min: 1, max: 3 }) }), weight: 3 },
  { arbitrary: fc.record({ k: fc.constant('update' as const), o: fc.nat(), i: fc.nat(), qty: fc.integer({ min: 1, max: 9 }) }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant('remove' as const), o: fc.nat(), i: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant('status' as const), o: fc.nat(), s: fc.nat() }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant('cancel' as const), o: fc.nat() }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant('cleanup' as const), o: fc.nat() }), weight: 1 },
);

export function cmdsArb(options: { drops: boolean; maxLength?: number }): fc.Arbitrary<Cmd[]> {
  const replica = fc.nat(2);
  const cmd: fc.Arbitrary<Cmd> = fc.oneof(
    { arbitrary: fc.record({ t: fc.constant('op' as const), r: replica, op: opArb, tick: fc.nat(3) }), weight: 4 },
    { arbitrary: fc.record({ t: fc.constant('gossip' as const), asker: replica, peer: replica }), weight: 2 },
    { arbitrary: fc.record({ t: fc.constant('deliver' as const), pick: fc.nat(), keepCopy: fc.boolean() }), weight: 4 },
    ...(options.drops ? [{ arbitrary: fc.record({ t: fc.constant('drop' as const), pick: fc.nat() }), weight: 1 }] : []),
  );
  // size: 'max' so fast-check really explores long histories instead of mostly tiny ones
  return fc.array(cmd, { minLength: 10, maxLength: options.maxLength ?? 120, size: 'max' });
}

/** Clock skew per device, so the HLC has to cope with disagreeing wall clocks. */
export const skewsArb = fc.array(fc.integer({ min: -5_000, max: 5_000 }), { minLength: 3, maxLength: 3 });

type Message = { to: number; delta: Delta } | { to: number; asker: number; vv: VersionVector };

export class World {
  time = 10_000;
  readonly replicas: Replica[];
  readonly inFlight: Message[] = [];

  // Bookkeeping for the "nothing was lost" checks.
  readonly created = new Set<string>();
  readonly canceled = new Set<string>();
  readonly cleanedUp = new Set<string>();
  readonly addedItems = new Map<string, string>(); // itemId -> orderId
  readonly removedItems = new Set<string>();
  readonly statusWrites = new Map<string, Status[]>();
  private readonly furthestSeen = new Map<string, number>(); // `${replica}/${order}` -> stage rank

  constructor(
    skews: number[],
    private readonly broadcastEdits: boolean,
  ) {
    this.replicas = ['drive-thru', 'counter', 'kitchen'].map(
      (id, i) => new Replica(id, { now: () => this.time + skews[i] }),
    );
  }

  run(cmds: Cmd[]): void {
    for (const cmd of cmds) this.step(cmd);
  }

  step(cmd: Cmd): void {
    switch (cmd.t) {
      case 'op': {
        this.time += cmd.tick;
        const delta = this.edit(this.replicas[cmd.r], cmd.op);
        this.checkStatusesOnlyMoveForward();
        if (delta && this.broadcastEdits) {
          for (let to = 0; to < 3; to++) if (to !== cmd.r) this.inFlight.push({ to, delta });
        }
        break;
      }
      case 'gossip':
        if (cmd.asker !== cmd.peer) {
          this.inFlight.push({ to: cmd.peer, asker: cmd.asker, vv: this.replicas[cmd.asker].versionVector() });
        }
        break;
      case 'deliver':
        if (this.inFlight.length > 0) this.deliver(cmd.pick % this.inFlight.length, cmd.keepCopy);
        break;
      case 'drop':
        if (this.inFlight.length > 0) this.inFlight.splice(cmd.pick % this.inFlight.length, 1);
        break;
    }
  }

  /** Deliver everything still in flight, in an order chosen by `picks`. */
  flush(picks: number[]): void {
    for (let n = 0; this.inFlight.length > 0; n++) {
      const pick = picks.length > 0 ? picks[n % picks.length] + n : 0;
      this.deliver(pick % this.inFlight.length, false);
    }
  }

  /** Reliable anti-entropy between every pair until nobody learns anything new. */
  settle(): void {
    for (let round = 0; round < 10; round++) {
      let learned = 0;
      for (const a of this.replicas) {
        for (const b of this.replicas) {
          if (a !== b) learned += b.merge(a.deltaFor(b.versionVector())).newEdits;
          this.checkStatusesOnlyMoveForward();
        }
      }
      if (learned === 0) return;
    }
    throw new Error('replicas did not settle');
  }

  private deliver(index: number, keepCopy: boolean): void {
    const message = keepCopy ? this.inFlight[index] : this.inFlight.splice(index, 1)[0];
    const receiver = this.replicas[message.to];
    if ('delta' in message) {
      receiver.merge(message.delta);
      this.checkStatusesOnlyMoveForward();
    } else {
      this.inFlight.push({ to: message.asker, delta: receiver.deltaFor(message.vv) });
    }
  }

  private edit(r: Replica, op: Op): Delta | undefined {
    if (op.k === 'create') {
      const id = r.newId('order');
      this.created.add(id);
      const delta = r.createOrder(id, { customer: `guest ${id}`, channel: r.id });
      this.recordStatus(id, delta);
      return delta;
    }
    const known = Object.keys(r.state().orders); // includes cleaned-up orders, so edits can race a cleanup
    if (known.length === 0) return undefined;
    const orderId = known[op.o % known.length];
    // Devices follow the local rules: items can't change on finished orders, status only moves as canMoveTo allows.
    const current = r.statusOf(orderId);
    const itemEdit = op.k === 'add' || op.k === 'update' || op.k === 'remove';
    if (itemEdit && isFinished(current)) return undefined;
    switch (op.k) {
      case 'add': {
        const itemId = r.newId('item');
        this.addedItems.set(itemId, orderId);
        return r.addItem(orderId, itemId, { name: op.name, qty: op.qty });
      }
      case 'update':
      case 'remove': {
        const items = r.order(orderId)?.items ?? [];
        if (items.length === 0) return undefined;
        const item = items[op.i % items.length];
        if (op.k === 'update') return r.updateItem(orderId, item.id, { name: item.name, qty: op.qty });
        this.removedItems.add(item.id);
        return r.removeItem(orderId, item.id);
      }
      case 'status': {
        const ahead = STATUSES.filter((s) => s !== 'canceled' && canMoveTo(current, s)); // includes picking up a canceled order
        if (ahead.length === 0) return undefined;
        const delta = r.setStatus(orderId, ahead[op.s % ahead.length]);
        this.recordStatus(orderId, delta);
        return delta;
      }
      case 'cancel': {
        if (!canMoveTo(current, 'canceled')) return undefined;
        this.canceled.add(orderId);
        const delta = r.cancelOrder(orderId);
        this.recordStatus(orderId, delta);
        return delta;
      }
      case 'cleanup': {
        if (!r.order(orderId) || !isFinished(r.statusOf(orderId))) return undefined;
        this.cleanedUp.add(orderId);
        return r.removeFinishedOrder(orderId);
      }
    }
  }

  private recordStatus(orderId: string, delta: Delta): void {
    const write = delta.orders[orderId].value?.status;
    if (!write) throw new Error('status edit without a status write');
    this.statusWrites.set(orderId, [...(this.statusWrites.get(orderId) ?? []), write.value]);
  }

  /** The status every replica should end on: the furthest stage anyone wrote, whatever the timestamps. */
  expectedStatus(orderId: string): Status | undefined {
    const writes = this.statusWrites.get(orderId) ?? [];
    return [...writes].sort((a, b) => statusRank(a) - statusRank(b)).pop();
  }

  /** On every device, at every moment, no order's status may ever move back to an earlier stage. */
  private checkStatusesOnlyMoveForward(): void {
    for (const replica of this.replicas) {
      for (const order of replica.orders()) {
        const key = `${replica.id}/${order.id}`;
        const rank = statusRank(order.status);
        if (rank < (this.furthestSeen.get(key) ?? 0)) {
          throw new Error(`${order.id} moved back to ${order.status} on ${replica.id}`);
        }
        this.furthestSeen.set(key, rank);
      }
    }
  }
}
