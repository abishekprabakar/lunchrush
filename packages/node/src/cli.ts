/**
 * Run one lunchrush node per process.
 *
 *   tsx packages/node/src/cli.ts device --name counter --relay ws://127.0.0.1:8787/sync
 *   tsx packages/node/src/cli.ts relay --port 8787
 *
 * Devices find each other on the local network with UDP multicast (turn it off
 * with --no-discovery and list peers with --peer instead). Each node serves
 * WebSocket sync on /sync and a small HTTP API: GET /state, POST /orders,
 * POST /orders/<id>/status.
 */
import { parseArgs } from 'node:util';
import { LanNode } from './lan-node';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    port: { type: 'string', default: '0' },
    relay: { type: 'string' },
    peer: { type: 'string', multiple: true, default: [] },
    'no-discovery': { type: 'boolean', default: false },
  },
});

const role = positionals[0];
if (role !== 'device' && role !== 'relay') {
  console.error('usage: cli.ts device --name <name> [--port N] [--relay ws://host:port/sync] [--peer url]... [--no-discovery]');
  console.error('       cli.ts relay [--port N]');
  process.exit(2);
}

const node = await new LanNode({
  name: role === 'relay' ? 'cloud' : (values.name ?? 'device'),
  port: Number(values.port),
  relay: role === 'device' ? values.relay : undefined,
  peers: values.peer,
  discovery: role === 'device' && !values['no-discovery'],
}).start();

// One machine-readable line so scripts know where this node listens.
console.log(`READY ${JSON.stringify({ id: node.id, name: node.state().name, port: node.port })}`);

const shutdown = () => void node.stop().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
