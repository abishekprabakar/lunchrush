import {
  BaselineReplica,
  isNewerVersion,
  Replica,
  type BaselineDoc,
  type BaselineVersion,
  type Delta,
  type LineItem,
  type OrderInfo,
  type OrderView,
  type Status,
  type VersionVector,
} from '@lunchrush/core';

/**
 * crdt-delta: the CRDT, replying with exactly the edits a peer is missing.
 * crdt-full:  the same CRDT and merge, but replying with the whole state whenever the peer is missing anything.
 * baseline:   naive whole-document last-write-wins, replying with the whole document if ours is newer.
 */
export type EngineKind = 'crdt-delta' | 'crdt-full' | 'baseline';
export const ENGINE_KINDS: readonly EngineKind[] = ['crdt-delta', 'crdt-full', 'baseline'];

/** The edits and reads every engine supports, so one workload can drive any of them. */
export interface OrderStore {
  createOrder(orderId: string, info: OrderInfo): unknown;
  addItem(orderId: string, itemId: string, item: LineItem): unknown;
  setStatus(orderId: string, status: Status): unknown;
  orders(): OrderView[];
  order(orderId: string): OrderView | undefined;
}

/**
 * How a node syncs. Every gossip round a node sends `summary()` to each peer it
 * can reach. A peer that has something the node lacks answers with
 * `respond(summary)`, and the node applies the answer with `receive`.
 */
export interface SyncEngine {
  readonly kind: EngineKind;
  readonly store: OrderStore;
  summary(): unknown;
  respond(peerSummary: unknown): unknown | undefined;
  /** Apply a peer's answer. Returns false if it taught us nothing new. */
  receive(payload: unknown): boolean;
  /** Two nodes with equal fingerprints have converged. */
  fingerprint(): string;
}

export function createEngine(kind: EngineKind, id: string, now: () => number): SyncEngine {
  return kind === 'baseline' ? baselineEngine(new BaselineReplica(id, now)) : crdtEngine(kind, new Replica(id, { now }));
}

function crdtEngine(kind: 'crdt-delta' | 'crdt-full', replica: Replica): SyncEngine {
  return {
    kind,
    store: replica,
    summary: () => replica.versionVector(),
    respond: (summary) => {
      const peerVv = summary as VersionVector;
      if (!replica.hasEditsMissingFrom(peerVv)) return undefined;
      return kind === 'crdt-delta' ? replica.deltaFor(peerVv) : replica.fullState();
    },
    receive: (payload) => replica.merge(payload as Delta).newEdits > 0,
    fingerprint: () => {
      const context = replica.state().context;
      return JSON.stringify(Object.keys(context).sort().map((id) => [id, context[id]]));
    },
  };
}

function baselineEngine(replica: BaselineReplica): SyncEngine {
  return {
    kind: 'baseline',
    store: replica,
    summary: () => replica.version(),
    respond: (summary) =>
      isNewerVersion(replica.version(), summary as BaselineVersion) ? replica.fullState() : undefined,
    receive: (payload) => replica.merge(payload as BaselineDoc),
    fingerprint: () => {
      const { savedAt, savedBy } = replica.version();
      return `${savedAt}/${savedBy}`;
    },
  };
}
