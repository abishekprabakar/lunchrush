/**
 * Hybrid Logical Clock (Kulkarni et al., 2014).
 *
 * A timestamp is (wall, counter, node):
 *   wall    - the largest physical time in ms this device has seen, from its own clock or a peer's
 *   counter - orders events that share the same wall time
 *   node    - the device id, a final tiebreaker so two timestamps are never equal
 *
 * Why not just use Date.now()? Device clocks drift. If the kitchen's clock is a
 * minute slow, then "ready" set by the kitchen after it saw "cooking" from the
 * counter would look older and lose. An HLC never goes backwards and always moves
 * past any timestamp it has received, so an edit made after seeing another edit
 * always sorts after it, while staying close to real time.
 */
export interface Hlc {
  wall: number;
  counter: number;
  node: string;
}

/** Total order on timestamps: wall time, then counter, then device id. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

export class HlcClock {
  private wall = 0;
  private counter = 0;

  constructor(
    readonly node: string,
    private readonly physicalNow: () => number = Date.now,
  ) {}

  /** A fresh timestamp for a local edit. Strictly greater than every earlier one. */
  now(): Hlc {
    const physical = this.physicalNow();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return this.current();
  }

  /** Jump forward to a peer's time if it is ahead, so our next edit sorts after it. */
  receive(remote: Hlc): void {
    if (remote.wall > this.wall || (remote.wall === this.wall && remote.counter > this.counter)) {
      this.wall = remote.wall;
      this.counter = remote.counter;
    }
  }

  current(): Hlc {
    return { wall: this.wall, counter: this.counter, node: this.node };
  }
}
