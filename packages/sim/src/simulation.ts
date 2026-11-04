/**
 * A discrete-event simulator: a virtual clock plus a queue of things to do at
 * future times. Nothing waits for real time, so ten simulated minutes of a lunch
 * rush run in about a second, and the same seed always gives the same run.
 */
interface ScheduledEvent {
  at: number;
  seq: number; // breaks ties so events at the same time run in the order they were scheduled
  run: () => void;
}

export class Simulation {
  /** Current simulated time in ms. */
  now = 0;
  private readonly heap: ScheduledEvent[] = [];
  private seq = 0;

  at(time: number, run: () => void): void {
    this.push({ at: Math.max(time, this.now), seq: this.seq++, run });
  }

  after(delayMs: number, run: () => void): void {
    this.at(this.now + delayMs, run);
  }

  /** Run `run` every `intervalMs`, starting at `firstAt`. */
  every(intervalMs: number, run: () => void, firstAt = this.now + intervalMs): void {
    const tick = () => {
      run();
      this.after(intervalMs, tick);
    };
    this.at(firstAt, tick);
  }

  /** Run events in time order up to and including `time`. */
  runUntil(time: number): void {
    while (this.heap.length > 0 && this.heap[0].at <= time) {
      const event = this.pop();
      this.now = event.at;
      event.run();
    }
    this.now = Math.max(this.now, time);
  }

  // A binary min-heap ordered by (at, seq).

  private push(event: ScheduledEvent): void {
    const heap = this.heap;
    heap.push(event);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  }

  private pop(): ScheduledEvent {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
        if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
        if (smallest === i) break;
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      }
    }
    return top;
  }
}

function before(a: ScheduledEvent, b: ScheduledEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}
