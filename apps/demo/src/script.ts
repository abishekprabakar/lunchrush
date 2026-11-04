import { plural } from './journal';
import type { DemoWorld } from './world';

/** One beat of the guided lunch rush. `at` is milliseconds from the start. */
export interface ScriptStep {
  at: number;
  caption?: string | ((world: DemoWorld) => string);
  run?: (world: DemoWorld, ids: Map<string, string>) => void;
  last?: boolean;
}

const item = (name: string) => [{ name, qty: 1 }];

/**
 * About 30 seconds that show the whole idea: an internet outage, a device
 * dropping off the Wi-Fi, two devices editing the same order apart, a stale
 * status tap, and everything reconnecting. Order numbers are deterministic:
 * the drive-thru takes D1 and D2, the counter takes C1 and C2.
 */
export const LUNCH_RUSH_SCRIPT: ScriptStep[] = [
  {
    at: 0,
    caption: 'Lunch rush. The drive-thru tablet, the counter and the kitchen display share the store Wi-Fi and sync to the cloud.',
  },
  { at: 500, run: (w, ids) => ids.set('D1', w.stations['drive-thru'].newOrder([...item('chicken sandwich'), ...item('waffle fries')], 'Ana')) },
  { at: 1_500, run: (w, ids) => ids.set('C1', w.stations.counter.newOrder(item('nuggets'), 'Ben')) },
  { at: 3_000, run: (w, ids) => w.stations.kitchen.advance(ids.get('D1')!) },
  {
    at: 4_500,
    caption: 'The internet goes down. Orders keep flowing over the store Wi-Fi.',
    run: (w) => w.setInternet(false),
  },
  { at: 6_000, run: (w, ids) => ids.set('D2', w.stations['drive-thru'].newOrder(item('chicken sandwich'), 'Cam')) },
  { at: 7_000, run: (w, ids) => ids.set('C2', w.stations.counter.newOrder(item('salad'), 'Dee')) },
  { at: 8_000, run: (w, ids) => w.stations.kitchen.advance(ids.get('C1')!) },
  {
    at: 9_500,
    caption: 'The drive-thru tablet drops off the Wi-Fi too. While apart, the tablet and the counter both add something to order D2.',
    run: (w) => w.setIsolated('drive-thru', true),
  },
  { at: 10_800, run: (w, ids) => w.stations['drive-thru'].addItem(ids.get('D2')!, item('cookie')[0]) },
  { at: 11_800, run: (w, ids) => w.stations.counter.addItem(ids.get('D2')!, item('lemonade')[0]) },
  { at: 12_800, run: (w, ids) => w.stations.kitchen.advance(ids.get('C2')!, 'ready') },
  {
    at: 13_500,
    caption: 'The kitchen marks C2 ready. The offline tablet still shows C2 as new, and someone taps “Start cooking”.',
  },
  { at: 14_300, run: (w, ids) => w.stations['drive-thru'].advance(ids.get('C2')!, 'cooking') },
  {
    at: 16_500,
    caption: (w) =>
      w.engine === 'crdt'
        ? 'The tablet is back on the Wi-Fi. Both new items on D2 survive, and the stale “cooking” loses to “ready”. Watch the sync log.'
        : 'The tablet is back on the Wi-Fi. Naive sync keeps whichever whole copy was saved last. Watch the ⚠ lines in the sync log.',
    run: (w) => w.setIsolated('drive-thru', false),
  },
  {
    at: 21_500,
    caption: 'The internet is back. The store catches the cloud up.',
    run: (w) => w.setInternet(true),
  },
  { at: 26_500, caption: resultCaption, last: true },
];

export const SCRIPT_LENGTH_MS = 26_500;

function resultCaption(w: DemoWorld): string {
  const { orders, items, wentBack } = w.score();
  if (w.engine === 'crdt') {
    return `Done. Every screen and the cloud show ${orders.kept} of ${orders.total} orders and ${items.kept} of ${items.total} items, and the stale tap was ignored. Now switch to Naive and play again.`;
  }
  const losses = [
    orders.kept < orders.total && `${orders.total - orders.kept} of ${orders.total} orders vanished`,
    items.kept < items.total && `${items.total - items.kept} of ${items.total} items vanished`,
    wentBack > 0 && `${plural(wentBack, 'order')} went back a stage`,
  ].filter((loss): loss is string => Boolean(loss));
  if (losses.length === 0) return 'Done. This time nothing was lost, but only thanks to lucky timing. Switch to CRDT and play again.';
  return `Done. Every screen agrees, but ${joinWithAnd(losses)}. Now switch to CRDT and play again.`;
}

function joinWithAnd(parts: string[]): string {
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
