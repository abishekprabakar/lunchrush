/**
 * The real-network outage check, end to end, with separate processes:
 *
 *   1. start the cloud relay and three devices (they find each other by multicast)
 *   2. take some orders and wait until all four agree
 *   3. kill the relay; keep taking orders and moving them through the kitchen
 *   4. check the devices still sync with each other with no relay
 *   5. restart the relay (it comes back empty) and wait until all four agree again
 *   6. verify: every order everywhere, no duplicates, identical state
 *
 *   pnpm lan              (add -- --no-discovery to use static peers instead of multicast)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { NodeState } from './lan-node';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const DEVICES = ['drive-thru', 'counter', 'kitchen'];
const useDiscovery = !process.argv.includes('--no-discovery');
const started = Date.now();
const children: ChildProcess[] = [];

function say(text: string): void {
  console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${text}`);
}

/** Start a node in its own process and wait for its READY line. */
function launch(args: string[]): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    let buffer = '';
    child.stdout!.on('data', (chunk) => {
      buffer += chunk;
      const ready = buffer.match(/READY (\{.*\})/);
      if (ready) resolve({ child, port: (JSON.parse(ready[1]) as { port: number }).port });
    });
    child.on('exit', (code) => reject(new Error(`${args.join(' ')} exited with ${code}`)));
  });
}

async function api<T>(port: number, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  say(`starting the cloud relay and ${DEVICES.length} devices (${useDiscovery ? 'multicast discovery' : 'static peers'})`);
  let relay = await launch(['relay']);
  const relayUrl = `ws://127.0.0.1:${relay.port}/sync`;
  const ports: Record<string, number> = {};
  for (const name of DEVICES) {
    const peers = useDiscovery ? [] : Object.values(ports).flatMap((p) => ['--peer', `ws://127.0.0.1:${p}/sync`]);
    const extra = useDiscovery ? [] : ['--no-discovery'];
    ports[name] = (await launch(['device', '--name', name, '--relay', relayUrl, ...extra, ...peers])).port;
  }
  const devicePorts = DEVICES.map((d) => ports[d]);
  const states = (list: number[]) => Promise.all(list.map((p) => api<NodeState>(p, '/state')));
  const agree = async (list: number[], orderCount: number) => {
    const all = await states(list);
    return all.every((s) => s.fingerprint === all[0].fingerprint && s.orders.length === orderCount);
  };

  await waitFor('devices to find each other', async () =>
    (await states(devicePorts)).every((s) => s.peers.filter((p) => p !== 'cloud').length === DEVICES.length - 1),
  );
  say('devices connected to each other and to the relay');

  const created: string[] = [];
  const takeOrder = async (device: string) => {
    const { orderId } = await api<{ orderId: string }>(ports[device], '/orders', { customer: `guest ${created.length + 1}`, items: ['nuggets', 'lemonade'] });
    created.push(orderId);
    return orderId;
  };
  for (let i = 0; i < 6; i++) await takeOrder(DEVICES[i % 2]);
  await waitFor('everyone to agree', () => agree([...devicePorts, relay.port], created.length));
  say(`${created.length} orders taken; all four nodes agree`);

  relay.child.kill('SIGTERM');
  await new Promise((resolve) => relay.child.once('exit', resolve));
  say('relay killed: the store is offline');

  for (let i = 0; i < 24; i++) {
    const orderId = await takeOrder(DEVICES[i % 2]);
    if (i % 3 === 0) await api(ports.kitchen, `/orders/${encodeURIComponent(created[i])}/status`, { status: 'cooking' }).catch(() => {});
    await sleep(100);
    void orderId;
  }
  await waitFor('devices to agree without the relay', () => agree(devicePorts, created.length), 10_000);
  say(`${created.length} orders now; the three devices still agree with each other, with no relay`);

  relay = await launch(['relay', '--port', String(relay.port)]);
  say('relay restarted, empty');
  await waitFor('the restarted relay to catch up', () => agree([...devicePorts, relay.port], created.length));
  say('the relay caught up; all four nodes agree');

  const final = await states([...devicePorts, relay.port]);
  const problems: string[] = [];
  for (const s of final) {
    const ids = s.orders.map((o) => o.id);
    if (new Set(ids).size !== ids.length) problems.push(`${s.name} shows duplicate orders`);
    const missing = created.filter((id) => !ids.includes(id));
    if (missing.length > 0) problems.push(`${s.name} is missing ${missing.length} orders`);
    if (JSON.stringify(s.orders) !== JSON.stringify(final[0].orders)) problems.push(`${s.name} differs from ${final[0].name}`);
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  say(`PASS: ${created.length} orders, none lost, none duplicated, identical on all four nodes`);
}

main()
  .then(() => (process.exitCode = 0))
  .catch((error: Error) => {
    say(`FAIL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill('SIGTERM');
  });
