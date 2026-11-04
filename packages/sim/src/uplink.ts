import type { GossipOptions } from './gossip';

/**
 * Single uplink: the devices in a store send their cloud traffic through one of
 * them, instead of each syncing with the cloud on its own.
 *
 * Without it, right after the internet comes back the cloud asks every device
 * for what it missed, and every device answers with the same edits. With it:
 *
 *  - A device talks to the cloud only if its id is the lowest among itself and
 *    the devices it can currently see on the LAN. The others reach the cloud
 *    through it, with the same multihop relaying the LAN already does. If the
 *    uplink device drops off the LAN, the next lowest takes over on its next
 *    gossip round.
 *  - The cloud only gossips with devices that contacted it recently, so it never
 *    asks several devices of the same store for the same edits.
 *  - Because the cloud now waits for a device to speak first, a device that
 *    comes back after a silence is greeted: the cloud answers its summary and
 *    immediately sends its own, so catching up doesn't wait an extra round.
 *
 * Correctness never depends on this. If two devices both think they are the
 * uplink (possible with only a direct-neighbour view of the LAN), it costs extra
 * bytes and nothing else, because merging the same edits twice is harmless.
 */
/** The election rule: a device carries the store's cloud traffic if its id is the lowest among itself and the LAN peers it can see. */
export function isStoreUplink(id: string, lanPeers: string[]): boolean {
  return lanPeers.every((peer) => id < peer);
}

export function singleUplink(cloud: string, intervalMs: number): GossipOptions {
  const recentMs = 3 * intervalMs;
  return {
    choosePeers: (self, reachable, now) => {
      if (self.id === cloud) {
        return reachable.filter((peer) => now - (self.lastHeard.get(peer) ?? -Infinity) <= recentMs);
      }
      const lan = reachable.filter((peer) => peer !== cloud);
      return isStoreUplink(self.id, lan) ? reachable : lan;
    },
    greetAfterMs: recentMs,
  };
}
