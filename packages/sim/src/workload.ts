import { isFinished, type LineItem, type OrderInfo, type Status } from '@lunchrush/core';
import { pick, randInt, type Rng } from './rng';

export type Device = 'drive-thru' | 'counter' | 'kitchen';

/** Something a staff member does at a given moment. */
export type Intent =
  | {
      at: number;
      device: Device;
      kind: 'order';
      orderId: string;
      info: OrderInfo;
      items: { itemId: string; item: LineItem }[];
    }
  | { at: number; device: Device; kind: 'status'; orderId: string; status: Status };

export interface Phase {
  start: number;
  end: number;
  orders: number;
  statusEdits: number;
}

const MENU = ['chicken sandwich', 'nuggets', 'waffle fries', 'lemonade', 'milkshake', 'salad', 'cookie'];
const NAMES = ['Ana', 'Ben', 'Cam', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo'];

/**
 * What the staff do, generated up front and independently of any engine, so
 * every engine faces exactly the same lunch rush.
 *
 * Orders are taken at the drive-thru or the counter, with 1 to 3 items. Status
 * edits follow the kitchen flow: the kitchen marks orders cooking then ready,
 * and the device that took the order marks it picked up, or (1 time in 10)
 * cancels it. A status edit only targets an order created at least 20 s earlier
 * whose previous step was at least 15 s earlier.
 */
export function generateWorkload(rng: Rng, phases: Phase[]): Intent[] {
  const intents: Intent[] = [];
  const plan = new Map<string, { device: Device; stage: Status; createdAt: number; lastAt: number }>();
  let orderCount = 0;

  for (const phase of phases) {
    for (const at of uniformTimes(rng, phase.orders, phase.start, phase.end)) {
      const orderId = `order-${++orderCount}`;
      const device: Device = rng() < 0.5 ? 'drive-thru' : 'counter';
      const items = Array.from({ length: randInt(rng, 1, 3) }, (_, k) => ({
        itemId: `${orderId}-${k + 1}`,
        item: { name: pick(rng, MENU), qty: randInt(rng, 1, 2) },
      }));
      const info = { customer: `${pick(rng, NAMES)} #${orderCount}`, channel: device };
      intents.push({ at, device, kind: 'order', orderId, info, items });
      plan.set(orderId, { device, stage: 'new', createdAt: at, lastAt: at });
    }

    const waiting = (at: number) =>
      [...plan.entries()].filter(
        ([, p]) => !isFinished(p.stage) && p.createdAt <= at - 20_000 && p.lastAt <= at - 15_000,
      );
    for (let at of uniformTimes(rng, phase.statusEdits, phase.start + 30_000, phase.end)) {
      let candidates = waiting(at);
      while (candidates.length === 0 && at + 5_000 < phase.end) candidates = waiting((at += 5_000));
      if (candidates.length === 0) continue;
      const [orderId, p] = pick(rng, candidates);
      const status: Status = rng() < 0.1 ? 'canceled' : nextStage(p.stage);
      const device: Device = status === 'cooking' || status === 'ready' ? 'kitchen' : p.device;
      intents.push({ at, device, kind: 'status', orderId, status });
      p.stage = status;
      p.lastAt = at;
    }
  }
  return intents.sort((x, y) => x.at - y.at);
}

function nextStage(stage: Status): Status {
  if (stage === 'new') return 'cooking';
  if (stage === 'cooking') return 'ready';
  return 'picked_up';
}

function uniformTimes(rng: Rng, count: number, start: number, end: number): number[] {
  return Array.from({ length: count }, () => Math.floor(start + rng() * (end - start))).sort((a, b) => a - b);
}
