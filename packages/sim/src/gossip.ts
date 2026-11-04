import type { SyncEngine } from './engines';
import type { Network } from './network';
import type { Simulation } from './simulation';

export type WireMessage = { type: 'summary'; summary: unknown } | { type: 'payload'; payload: unknown };

/** Decides which of the peers a node can reach it should gossip with this round. */
export type PeerPolicy = (self: SimNode, reachable: string[], now: number) => string[];

export interface GossipOptions {
  /** Which reachable peers to gossip with each round. Default: all of them. */
  choosePeers?: PeerPolicy;
  /**
   * When a summary arrives from a peer we haven't heard from for this long,
   * answer it and also send our own summary straight back, so a fresh or
   * returning connection syncs both ways at once instead of waiting a round.
   * Off by default.
   */
  greetAfterMs?: number;
}

const everyone: PeerPolicy = (_self, reachable) => reachable;

/**
 * One simulated device (or the cloud) running anti-entropy gossip.
 *
 * Every `intervalMs` it sends its summary (for the CRDT, its version vector) to
 * the peers it can currently reach (all of them, unless a policy such as the
 * single uplink narrows it down). A peer that has something this node is
 * missing answers with it (for crdt-delta, exactly the missing edits). Since
 * every node also serves what it learned from others, two devices that can't
 * reach each other still sync through a device that reaches both: multihop.
 */
export class SimNode {
  /** Bytes of answers received, and how many of those bytes taught this node nothing new. */
  readonly received = { payloadBytes: 0, redundantBytes: 0 };
  /** When this node last heard anything from each peer. */
  readonly lastHeard = new Map<string, number>();
  /** When this node last sent each peer its summary, i.e. asked it for missing edits. */
  private readonly lastAsked = new Map<string, number>();
  private intervalMs = 0;

  constructor(
    readonly id: string,
    readonly engine: SyncEngine,
    private readonly net: Network<WireMessage>,
    private readonly sim: Simulation,
    private readonly options: GossipOptions = {},
  ) {
    net.attach(id, (message, from, bytes) => this.onMessage(message, from, bytes));
  }

  /** Start gossiping. `phaseMs` staggers nodes so they don't all fire at the same instant. */
  start(intervalMs: number, phaseMs: number): void {
    this.intervalMs = intervalMs;
    this.sim.every(intervalMs, () => this.gossip(), this.sim.now + phaseMs);
  }

  gossip(): void {
    const summary = this.engine.summary();
    for (const peer of this.peersToGossipWith(this.net.peersOf(this.id))) this.ask(peer, summary);
  }

  /**
   * Send a peer our summary. Skipped if we already asked it within the last half
   * interval (a greeting just before a regular round), because both questions
   * would get the same answer, sent twice.
   */
  private ask(peer: string, summary: unknown): void {
    const last = this.lastAsked.get(peer);
    if (last !== undefined && this.sim.now - last < this.intervalMs / 2) return;
    this.lastAsked.set(peer, this.sim.now);
    this.net.send(this.id, peer, { type: 'summary', summary });
  }

  private peersToGossipWith(reachable: string[]): string[] {
    return (this.options.choosePeers ?? everyone)(this, reachable, this.sim.now);
  }

  private onMessage(message: WireMessage, from: string, bytes: number): void {
    const lastHeard = this.lastHeard.get(from);
    this.lastHeard.set(from, this.sim.now);
    if (message.type === 'summary') {
      const payload = this.engine.respond(message.summary);
      if (payload !== undefined) this.net.send(this.id, from, { type: 'payload', payload });
      const { greetAfterMs } = this.options;
      const returning = lastHeard === undefined || this.sim.now - lastHeard > (greetAfterMs ?? Infinity);
      if (greetAfterMs !== undefined && returning && this.peersToGossipWith([from]).includes(from)) {
        this.ask(from, this.engine.summary());
      }
    } else {
      this.received.payloadBytes += bytes;
      if (!this.engine.receive(message.payload, from)) this.received.redundantBytes += bytes;
    }
  }
}
