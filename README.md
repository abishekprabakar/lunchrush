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
- [ ] Milestone 4: demo UI
- [ ] Milestone 5: polish and CI

## Run it

Requires Node 20.19 or newer.

```sh
corepack enable     # provides the pinned pnpm version
pnpm install
pnpm check          # lint + typecheck + all tests
```

## Layout

```
packages/core/src
  hlc.ts             hybrid logical clock
  causal-context.ts  dots, version vectors, causal contexts
  lww.ts             last-writer-wins register
  awmap.ts           add-wins map with tombstones
  order-doc.ts       the order document: merge, delta extraction, view
  replica.ts         one device: local edits, deltaFor(versionVector), merge(delta)
  baseline.ts        naive whole-document last-write-wins, for comparison
packages/core/test   example tests plus fast-check property tests
```
