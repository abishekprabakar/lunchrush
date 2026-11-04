import { Replica, STATUSES, type Delta, type OrderView, type Status, type VersionVector } from '@lunchrush/core';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { startDiscovery } from './discovery';

type Wire =
  | { type: 'hello'; id: string; name: string }
  | { type: 'summary'; vv: VersionVector }
  | { type: 'delta'; delta: Delta };

export interface LanNodeOptions {
  /** "drive-thru", "counter", "kitchen", or "cloud" for the relay. */
  name: string;
  /** Port for WebSocket sync and the HTTP API. 0 picks a free one. */
  port?: number;
  host?: string;
  /** The cloud relay's sync URL, e.g. ws://127.0.0.1:8787/sync. Optional: devices sync without it. */
  relay?: string;
  /** Peers to keep connected to, in addition to any discovered ones. */
  peers?: string[];
  /** Find peers with UDP multicast. */
  discovery?: boolean;
  gossipMs?: number;
}

export interface NodeState {
  id: string;
  name: string;
  port: number;
  peers: string[];
  versionVector: VersionVector;
  fingerprint: string;
  orders: OrderView[];
}

/**
 * One lunchrush process: a replica, a WebSocket server, connections to peers,
 * and the same anti-entropy as the simulator. Every `gossipMs` it sends each
 * connected peer its version vector; a peer that has edits it lacks answers
 * with exactly those.
 *
 * A device and the cloud relay are the same thing here. The relay is just a
 * node that devices dial over the internet. Devices also talk to each other
 * directly, so the relay going away doesn't stop the store.
 */
export class LanNode {
  readonly id: string;
  readonly replica: Replica;
  port = 0;

  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly links = new Map<WebSocket, { peerId?: string; peerName?: string }>();
  private readonly connectedPeerIds = new Set<string>();
  private readonly stopFns: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly options: LanNodeOptions) {
    // A fresh id per process start, so a restarted device never reuses edit numbers.
    this.id = `${options.name}.${Math.random().toString(36).slice(2, 6)}`;
    this.replica = new Replica(this.id);
    this.server = http.createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: '/sync' });
    this.wss.on('connection', (ws) => this.attach(ws));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port ?? 0, this.options.host ?? '0.0.0.0', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    const timer = setInterval(() => this.gossip(), this.options.gossipMs ?? 500);
    this.stopFns.push(() => clearInterval(timer));
    for (const url of this.options.peers ?? []) this.keepConnected(url);
    if (this.options.relay) this.keepConnected(this.options.relay);
    if (this.options.discovery) {
      const self = { app: 'lunchrush' as const, id: this.id, name: this.options.name, port: this.port };
      this.stopFns.push(
        startDiscovery(self, (peer, address) => {
          // Only the lower id dials, so two devices don't open two connections to each other.
          if (this.id < peer.id && !this.connectedPeerIds.has(peer.id)) this.dial(`ws://${address}:${peer.port}/sync`, peer.id);
        }),
      );
    }
    return this;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const stop of this.stopFns) stop();
    for (const ws of this.links.keys()) ws.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  state(): NodeState {
    const context = this.replica.state().context;
    return {
      id: this.id,
      name: this.options.name,
      port: this.port,
      peers: [...this.links.values()].map((l) => l.peerName ?? '?').sort(),
      versionVector: this.replica.versionVector(),
      fingerprint: JSON.stringify(Object.keys(context).sort().map((id) => [id, context[id]])),
      orders: this.replica.orders(),
    };
  }

  // ---- Connections

  /** For configured peers and the relay: reconnect forever, since they may come and go. */
  private keepConnected(url: string): void {
    const connect = () => {
      if (this.stopped) return;
      const ws = new WebSocket(url);
      ws.on('open', () => this.attach(ws));
      ws.on('error', () => {}); // a 'close' always follows
      ws.on('close', () => setTimeout(connect, 1_000));
    };
    connect();
  }

  /** For discovered peers: one attempt. If it drops, the next announcement brings it back. */
  private dial(url: string, peerId: string): void {
    this.connectedPeerIds.add(peerId);
    const ws = new WebSocket(url);
    ws.on('open', () => this.attach(ws));
    ws.on('error', () => {});
    ws.on('close', () => this.connectedPeerIds.delete(peerId));
  }

  private attach(ws: WebSocket): void {
    this.links.set(ws, {});
    ws.on('message', (data) => this.onMessage(ws, JSON.parse(String(data)) as Wire));
    ws.on('close', () => {
      const peerId = this.links.get(ws)?.peerId;
      if (peerId) this.connectedPeerIds.delete(peerId);
      this.links.delete(ws);
    });
    this.send(ws, { type: 'hello', id: this.id, name: this.options.name });
    this.send(ws, { type: 'summary', vv: this.replica.versionVector() }); // sync right away
  }

  private onMessage(ws: WebSocket, message: Wire): void {
    const link = this.links.get(ws);
    if (!link) return;
    if (message.type === 'hello') {
      link.peerId = message.id;
      link.peerName = message.name;
      this.connectedPeerIds.add(message.id);
    } else if (message.type === 'summary') {
      if (this.replica.hasEditsMissingFrom(message.vv)) {
        this.send(ws, { type: 'delta', delta: this.replica.deltaFor(message.vv) });
      }
    } else {
      this.replica.merge(message.delta);
    }
  }

  private gossip(): void {
    const vv = this.replica.versionVector();
    for (const ws of this.links.keys()) this.send(ws, { type: 'summary', vv });
  }

  private send(ws: WebSocket, message: Wire): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  // ---- HTTP API, used by the outage script and handy with curl

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/state') return reply(200, this.state());
      if (req.method === 'POST' && url.pathname === '/orders') {
        const body = (await readJson(req)) as { customer?: string; items?: string[] };
        const orderId = this.replica.newId('order');
        this.replica.createOrder(orderId, { customer: body.customer ?? 'guest', channel: this.options.name });
        for (const name of body.items ?? ['chicken sandwich']) {
          this.replica.addItem(orderId, this.replica.newId('item'), { name, qty: 1 });
        }
        return reply(201, { orderId });
      }
      const status = url.pathname.match(/^\/orders\/([^/]+)\/status$/);
      if (req.method === 'POST' && status) {
        const { status: next } = (await readJson(req)) as { status: Status };
        if (!STATUSES.includes(next)) return reply(400, { error: `unknown status ${next}` });
        this.replica.setStatus(decodeURIComponent(status[1]), next);
        return reply(200, { ok: true });
      }
      reply(404, { error: 'not found' });
    } catch (error) {
      reply(409, { error: (error as Error).message });
    }
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
