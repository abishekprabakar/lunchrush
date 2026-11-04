import { utf8Length } from '@lunchrush/core';
import type { Rng } from './rng';
import type { Simulation } from './simulation';

export interface LinkConfig {
  /** Base one-way delay. */
  latencyMs: number;
  /** Extra random delay in [0, jitterMs). Jitter can reorder messages. */
  jitterMs: number;
  /** Chance a message is dropped. */
  loss: number;
  /** Chance a message is delivered twice. */
  duplicate: number;
  /** Bandwidth. Messages going the same way queue behind each other. */
  bytesPerSecond: number;
  /**
   * Links with the same pipe share one bandwidth queue, like several devices
   * behind a single store router. Each pipe direction is queued separately.
   */
  pipe?: string;
}

export type LinkKind = 'lan' | 'internet';

interface Link {
  a: string;
  b: string;
  kind: LinkKind;
  config: LinkConfig;
  up: boolean;
}

export interface NetworkStats {
  sent: number;
  delivered: number;
  lost: number;
  duplicated: number;
  bytes: Record<LinkKind, number>;
}

/**
 * An in-process network. Messages travel over explicit links between named
 * nodes. Each send is serialized to JSON (so we count real bytes and the
 * receiver gets a copy, never a shared object), queued behind earlier messages
 * for the link's bandwidth, then delayed, dropped or duplicated as configured.
 */
export class Network<M> {
  readonly stats: NetworkStats = { sent: 0, delivered: 0, lost: 0, duplicated: 0, bytes: { lan: 0, internet: 0 } };
  /** Called after every delivered message. The scenarios use it to detect convergence. */
  onDeliver?: () => void;

  private readonly links = new Map<string, Link>();
  private readonly handlers = new Map<string, (message: M, from: string, bytes: number) => void>();
  private readonly busyUntil = new Map<string, number>();

  constructor(
    private readonly sim: Simulation,
    private readonly rng: Rng,
  ) {}

  attach(node: string, handler: (message: M, from: string, bytes: number) => void): void {
    this.handlers.set(node, handler);
  }

  connect(a: string, b: string, kind: LinkKind, config: LinkConfig): void {
    this.links.set(linkKey(a, b), { a, b, kind, config: { ...config }, up: true });
  }

  configure(a: string, b: string, patch: Partial<LinkConfig>): void {
    const link = this.mustGet(a, b);
    link.config = { ...link.config, ...patch };
  }

  /** Take a link down. Messages already in flight on it are lost. */
  cut(a: string, b: string): void {
    this.mustGet(a, b).up = false;
  }

  heal(a: string, b: string): void {
    this.mustGet(a, b).up = true;
  }

  isUp(a: string, b: string): boolean {
    return this.links.get(linkKey(a, b))?.up ?? false;
  }

  /** The nodes `node` can currently reach directly. */
  peersOf(node: string): string[] {
    const peers: string[] = [];
    for (const link of this.links.values()) {
      if (!link.up) continue;
      if (link.a === node) peers.push(link.b);
      else if (link.b === node) peers.push(link.a);
    }
    return peers;
  }

  send(from: string, to: string, message: M): void {
    const link = this.links.get(linkKey(from, to));
    if (!link?.up) return; // no route: nothing goes on the wire

    const wire = JSON.stringify(message);
    const bytes = utf8Length(wire);
    this.stats.sent++;
    this.stats.bytes[link.kind] += bytes;

    // Transmission: wait for earlier messages going the same way, then take bytes / bandwidth.
    const lane = `${link.config.pipe ?? linkKey(link.a, link.b)}:${to === link.b ? '>' : '<'}`;
    const start = Math.max(this.sim.now, this.busyUntil.get(lane) ?? 0);
    const sentAt = start + (bytes / link.config.bytesPerSecond) * 1000;
    this.busyUntil.set(lane, sentAt);

    if (this.rng() < link.config.loss) {
      this.stats.lost++;
      return;
    }
    const copies = this.rng() < link.config.duplicate ? 2 : 1;
    if (copies === 2) this.stats.duplicated++;
    for (let i = 0; i < copies; i++) {
      const arrival = sentAt + link.config.latencyMs + this.rng() * link.config.jitterMs;
      this.sim.at(arrival, () => {
        if (!link.up) {
          this.stats.lost++;
          return;
        }
        this.stats.delivered++;
        this.handlers.get(to)?.(JSON.parse(wire) as M, from, bytes);
        this.onDeliver?.();
      });
    }
  }

  private mustGet(a: string, b: string): Link {
    const link = this.links.get(linkKey(a, b));
    if (!link) throw new Error(`no link between ${a} and ${b}`);
    return link;
  }
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
