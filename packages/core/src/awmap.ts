import type { Dot } from './causal-context';

/**
 * One key of an add-wins map.
 *
 *   adds  - dots of the edits that added or changed this key ("this key should exist")
 *   tombs - tombstones: each is keyed by the dot of a remove edit and lists the
 *           add-dots that the remover could see when it removed the key
 *   value - the key's value, itself a CRDT with its own merge
 *
 * The key is present if at least one add-dot is not covered by a tombstone.
 * A remove can only cancel adds it has already seen, so an add made at the same
 * time on another device survives. That is what "add wins" means.
 *
 * Tombstones are never deleted (see the limitations in the README).
 */
export interface AwEntry<V> {
  adds: Record<Dot, true>;
  tombs: Record<Dot, Dot[]>;
  value?: V;
}

export type AwMap<V> = Record<string, AwEntry<V>>;

type JoinValue<V> = (a: V | undefined, b: V | undefined) => V | undefined;

/** Merge two maps key by key: union the adds, union the tombstones, merge the values. */
export function awJoin<V>(a: AwMap<V>, b: AwMap<V>, joinValue: JoinValue<V>): AwMap<V> {
  const out: AwMap<V> = { ...a };
  for (const [key, eb] of Object.entries(b)) {
    const ea = a[key];
    if (!ea) {
      out[key] = eb;
      continue;
    }
    const value = joinValue(ea.value, eb.value);
    out[key] = {
      adds: { ...ea.adds, ...eb.adds },
      tombs: { ...ea.tombs, ...eb.tombs },
      ...(value === undefined ? {} : { value }),
    };
  }
  return out;
}

/** Add-dots that no tombstone has cancelled, sorted. */
export function awLiveDots(entry: AwEntry<unknown> | undefined): Dot[] {
  if (!entry) return [];
  const removed = new Set(Object.values(entry.tombs).flat());
  return Object.keys(entry.adds)
    .filter((dot) => !removed.has(dot))
    .sort();
}

export function awHas(entry: AwEntry<unknown> | undefined): boolean {
  return awLiveDots(entry).length > 0;
}

/**
 * Keep only the pieces made by edits that pass `keep`. Used to cut a delta out
 * of a full state. Keys left with nothing in them are dropped.
 */
export function awFilter<V>(
  map: AwMap<V>,
  keep: (dot: Dot) => boolean,
  filterValue: (value: V) => V | undefined,
): AwMap<V> {
  const out: AwMap<V> = {};
  for (const [key, entry] of Object.entries(map)) {
    const adds = pick(entry.adds, keep);
    const tombs = pick(entry.tombs, keep);
    const value = entry.value === undefined ? undefined : filterValue(entry.value);
    if (isEmpty(adds) && isEmpty(tombs) && value === undefined) continue;
    out[key] = { adds, tombs, ...(value === undefined ? {} : { value }) };
  }
  return out;
}

export function isEmpty(record: object): boolean {
  return Object.keys(record).length === 0;
}

function pick<T>(record: Record<Dot, T>, keep: (dot: Dot) => boolean): Record<Dot, T> {
  return Object.fromEntries(Object.entries(record).filter(([dot]) => keep(dot)));
}
