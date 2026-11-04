import type { SyncEngine } from './engines';
import type { Network } from './network';
import type { Simulation } from './simulation';

export type WireMessage = { type: 'summary'; summary: unknown } | { type: 'payload'; payload: unknown };

/**
 * One simulated device (or the cloud) running anti-entropy gossip.
 *
 * Every `intervalMs` it sends its summary (for the CRDT, its version vector) to
 * every peer it can currently reach. A peer that has something this node is
 * missing answers with it (for crdt-delta, exactly the missing edits). Since
 * every node also serves what it learned from others, two devices that can't
 * reach each other still sync through a device that reaches both: multihop.
 */
export class SimNode {
  /** Bytes of answers received, and how many of those bytes taught this node nothing new. */
  readonly received = { payloadBytes: 0, redundantBytes: 0 };

  constructor(
    readonly id: string,
    readonly engine: SyncEngine,
    private readonly net: Network<WireMessage>,
  ) {
    net.attach(id, (message, from, bytes) => this.onMessage(message, from, bytes));
  }

  /** Start gossiping. `phaseMs` staggers nodes so they don't all fire at the same instant. */
  start(sim: Simulation, intervalMs: number, phaseMs: number): void {
    sim.every(intervalMs, () => this.gossip(), sim.now + phaseMs);
  }

  gossip(): void {
    const summary = this.engine.summary();
    for (const peer of this.net.peersOf(this.id)) this.net.send(this.id, peer, { type: 'summary', summary });
  }

  private onMessage(message: WireMessage, from: string, bytes: number): void {
    if (message.type === 'summary') {
      const payload = this.engine.respond(message.summary);
      if (payload !== undefined) this.net.send(this.id, from, { type: 'payload', payload });
    } else {
      this.received.payloadBytes += bytes;
      if (!this.engine.receive(message.payload)) this.received.redundantBytes += bytes;
    }
  }
}
