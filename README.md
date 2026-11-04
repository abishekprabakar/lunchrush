# lunchrush

A restaurant point-of-sale where a drive-thru tablet, a counter register and a kitchen display keep
working through an internet outage. They sync with each other directly and catch up with the cloud
when it comes back, with no lost orders, no duplicates and no lost edits.

**This is a learning project inspired by [Ditto](https://ditto.com)'s offline-first, peer-to-peer
sync (and Chick-fil-A's use of it in their restaurants). It is not a Ditto product and uses no Ditto
code.** The CRDT merge logic is written by hand, without Automerge or Yjs, to understand how it works.

Read [EXPLAINER.md](EXPLAINER.md) for the ideas: why last-write-wins loses data, what makes a merge
safe, how version vectors decide what to send, and why delta sync saves bandwidth.

## Status

- [x] Milestone 1: core sync engine (`packages/core`)
- [x] Milestone 2: network simulator and lunch-rush outage benchmark (`packages/sim`)
- [ ] Milestone 3: real LAN mode (UDP multicast discovery, WebSockets, optional cloud relay)
- [ ] Milestone 4: demo UI (its sync log will report status writes that lose to a further stage)
- [ ] Milestone 5: polish and CI

## Run it

Requires Node 20.19 or newer.

```sh
corepack enable     # provides the pinned pnpm version
pnpm install
pnpm check          # lint + typecheck + all tests
pnpm bench          # run the lunch-rush outage benchmark; writes results.md
```

## Results

<!-- bench:summary -->
Measured by `pnpm bench` over 5 seeded runs of the lunch-rush outage (medians; full details in [results.md](results.md)).

| Engine | Orders lost | Status edits lost | Converged after reconnect | Total bytes | Internet bytes |
| --- | --: | --: | --: | --: | --: |
| CRDT, delta sync | 0 | 0 | 1.28 s | 1.25 MB | 0.56 MB |
| CRDT, full-state sync | 0 | 0 | 1.37 s | 48.99 MB | 1.21 MB |
| Naive last-write-wins | 41 | 19 | 0.82 s | 8.73 MB | 0.28 MB |

Delta sync sent 39.3x fewer bytes than full-state sync in total, but only 2.1x fewer over the internet. 35% of the bytes in delta-sync answers taught the receiver nothing new.
<!-- /bench:summary -->

## Known limitations

These are deliberate simplifications. [EXPLAINER.md](EXPLAINER.md) explains each one.

- **No undo for status.** Status only moves forward (new, cooking, ready, canceled, picked up). A
  mistaken "ready" can't go back to "cooking" without a separate correction mechanism.
- **Stages must form a single line.** The forward-only merge needs every pair of stages to be ordered.
  Adding a stage alongside another (for example "refunded" next to "picked up") needs a new design.
- **Cleanup is add-wins.** Removing a finished order from the map only covers edits the device has
  seen, so a concurrent edit can bring a cleaned-up order back. It comes back still finished.
- **Memory grows.** Finished orders stay until cleaned up, and tombstones are never deleted.

## Layout

```
packages/core/src
  hlc.ts             hybrid logical clock
  causal-context.ts  dots, version vectors, causal contexts
  register.ts        registers: last-writer-wins, and forward-only for order status
  awmap.ts           add-wins map with tombstones
  order-doc.ts       the order document: merge, delta extraction, view
  replica.ts         one device: local edits, deltaFor(versionVector), merge(delta)
  baseline.ts        naive whole-document last-write-wins, for comparison
packages/core/test   example tests plus fast-check property tests

packages/sim/src
  simulation.ts      discrete-event clock and event queue
  network.ts         links with latency, jitter, loss, duplicates, bandwidth and partitions
  engines.ts         the three things being compared: CRDT delta, CRDT full-state, naive baseline
  gossip.ts          a node running anti-entropy gossip (version vectors out, missing edits back)
  workload.ts        the staff's orders and status edits, generated from a seed
  lunch-rush.ts      the outage scenario and its scoring
  report.ts, bench.ts  results.md and the summaries above
```
