import dgram from 'node:dgram';

const GROUP = '239.255.77.77';
const PORT = 47474;

export interface Announcement {
  app: 'lunchrush';
  id: string;
  name: string;
  port: number;
}

/**
 * Find other lunchrush devices on the local network with UDP multicast.
 *
 * Every second each device shouts "I'm counter.k3f9, syncing on port 8801" to
 * a multicast group that every device listens to. No server and no
 * configuration: plug a device into the store Wi-Fi and the others hear it.
 */
export function startDiscovery(
  self: Announcement,
  onPeer: (peer: Announcement, address: string) => void,
  intervalMs = 1_000,
): () => void {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (data, remote) => {
    try {
      const peer = JSON.parse(String(data)) as Announcement;
      if (peer.app === 'lunchrush' && peer.id !== self.id) onPeer(peer, remote.address);
    } catch {
      // not ours
    }
  });
  socket.on('error', () => socket.close());
  let timer: ReturnType<typeof setInterval> | undefined;
  socket.bind(PORT, () => {
    socket.addMembership(GROUP);
    socket.setMulticastLoopback(true); // so devices on the same machine find each other too
    socket.setMulticastTTL(1); // never leave the local network
    const announce = () => socket.send(JSON.stringify(self), PORT, GROUP);
    announce();
    timer = setInterval(announce, intervalMs);
  });
  return () => {
    clearInterval(timer);
    try {
      socket.close();
    } catch {
      // already closed
    }
  };
}
