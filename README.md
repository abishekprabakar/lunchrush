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
- [ ] Milestone 2: network simulator and lunch-rush outage benchmark
- [ ] Milestone 3: real LAN mode (UDP multicast discovery, WebSockets, optional cloud relay)
- [ ] Milestone 4: demo UI (its sync log will report status writes that lose to a further stage)
- [ ] Milestone 5: polish and CI

## Run it

Requires Node 20.19 or newer.

```sh
corepack enable     # provides the pinned pnpm version
pnpm install
pnpm check          # lint + typecheck + all tests
```

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
```
