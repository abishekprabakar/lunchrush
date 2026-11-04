# How lunchrush works

This is a running explainer, written for someone new to distributed systems.
Each section points at the code and tests that back it up. It grows with each milestone.

> lunchrush is a learning project inspired by Ditto's offline-first sync. It is not a Ditto product
> and does not use any Ditto code.

---

## 1. The problem

A restaurant has three devices: a **drive-thru tablet**, a **counter register** and a **kitchen display**.
Each one keeps its own full copy of the orders (a *replica*). Edits always happen on the local copy
first, so a device keeps working with no network at all. Copies are synced whenever devices can
reach each other.

That is the easy half. The hard half: two copies that were edited separately, perhaps for ten minutes
during an outage, have to be combined into one. That combining step is the **merge**, and almost
everything in `packages/core` is about making the merge safe.

---

## 2. Why last-write-wins loses data

The simplest merge is *last-write-wins* (LWW): every copy remembers when it was last edited, and on
sync the newer copy replaces the older one. `packages/core/src/baseline.ts` implements exactly that.

Here is what happens to it during an outage (`packages/core/test/baseline.test.ts`):

1. Order #1 (one sandwich) is placed at the drive-thru and synced to the counter.
2. The internet drops.
3. 12:01: the drive-thru adds a **cookie** to order #1.
4. 12:02: the counter adds a **lemonade** to order #1.
5. The devices reconnect and swap documents. The counter's copy is newer, so it wins.

Both devices now show "sandwich, lemonade". **The cookie is gone**, and nobody was told. The same test
file shows LWW dropping an entire order that was taken offline.

Three things are wrong here:

- **The merge throws away information.** Both edits arrived at the merge, and the merge picked one.
  No later step can bring the other back.
- **Agreement is not the same as correctness.** Both devices agree with each other. Converging is
  easy if you are allowed to delete things. The goal is to converge *without losing anyone's work*.
- **"Last" depends on clocks, and clocks lie.** If the counter's clock runs two minutes fast, its
  edits win even when they really happened first.

The fix is not to abandon LWW entirely. It is to stop applying it to the *whole document*, and to
pick a merge rule per field that matches what the field means. lunchrush uses:

- **LWW** only for single values where the newest answer really is the right one: the customer
  details, and an item's quantity.
- **A forward-only register** for the order's status, because an order's stage has a direction:
  "ready" should never be undone by a stale "cooking" (section 4).
- **Structures that keep everything** for collections: the orders and the line items.

---

## 3. What makes a merge safe

A real network does three unpleasant things to messages:

| The network...                                 | So the merge must be... | Meaning                                   |
| ---------------------------------------------- | ----------------------- | ----------------------------------------- |
| delivers them **out of order**                 | **commutative**         | `merge(a, b) = merge(b, a)`               |
| delivers them **through different paths**      | **associative**         | `merge(merge(a, b), c) = merge(a, merge(b, c))` |
| delivers them **more than once** (retries)     | **idempotent**          | `merge(a, a) = a`                         |

If a merge has all three properties, then any two replicas that have received the same set of
updates are identical, no matter the order, the number of copies, or which device relayed what.
This guarantee is called *strong eventual consistency*. Data types built this way are called
**CRDTs** (Conflict-free Replicated Data Types).

Some operations naturally have all three properties:

- **Set union.** `{a, b} ∪ {b, c} = {a, b, c}` in any order, any number of times.
- **Max.** `max(3, 7) = max(7, 3)`, and `max(7, 7) = 7`.

And some don't:

- **"Append to a list"** is not idempotent. A duplicate message adds the item twice.
- **"Subtract 1"** is not commutative with "set to 5".

So the trick is to build every piece of state out of unions and maxes. In lunchrush:

- The **status** of an order is a *forward-only register*: merging keeps the write with the furthest
  stage. That is a max over stages.
- The **customer details** and each **item's quantity** are *last-writer-wins registers*: merging keeps
  the write with the larger timestamp. That is a max over timestamps.
- The **orders** and the **line items** are *add-wins maps*: merging takes the union of the "added"
  markers and the union of the "removed" markers. Those are unions.
- The record of **which edits a replica has seen** (its causal context) is a union of ranges.

`packages/core/test/properties.test.ts` checks these laws directly on hundreds of random states, and
also runs hundreds of random histories on 3 replicas where messages are reordered, duplicated and
dropped, then checks that every replica ends up with an identical state, with no order or item lost,
and that no device ever shows an order's status moving backwards, not even for a moment.

---

## 4. The building blocks

### Hybrid logical clocks (`hlc.ts`)

LWW needs to know which write came "last". Wall clocks alone are unreliable. A *hybrid logical clock*
(HLC) timestamp is three numbers: `(wall time, counter, device id)`.

- On a local edit, the clock uses the wall time if it has moved forward, and otherwise bumps the counter.
  So timestamps never go backwards, even if the device's clock does.
- On receiving data, the clock jumps forward to the sender's time if the sender is ahead.
  So **an edit made after seeing another edit always sorts after it**, even if this device's clock is
  a minute slow (tested in `orders.test.ts`).
- The device id breaks exact ties, so every replica picks the same winner.

### Dots: a name for every edit (`causal-context.ts`)

Every edit gets a unique name called a **dot**: the device id plus that device's edit number, like
`kitchen:7` for the kitchen's 7th edit. Every piece of state remembers the dot of the edit that made it.
Dots are what make removal and delta sync possible.

### The add-wins map (`awmap.ts`)

Orders are stored in an *add-wins map* keyed by order id, and each order's line items are another
add-wins map. For each key the map keeps:

- `adds`: the dots of edits that created or changed the key.
- `tombs`: *tombstones*. Each tombstone says "edit `counter:9` removed the adds `counter:3` and `kitchen:2`."
- `value`: the key's value, which is itself a CRDT.

A key is visible if at least one of its adds is not covered by a tombstone. A remove can only cover the
adds it has **already seen**. So if the counter removes the fries from an order while the kitchen,
offline, changes the fries to a large, the kitchen's edit has a dot the remove never saw. After
syncing, that dot is still live and the fries are still on the order. The add wins.

For line items that is the right default: it is better to make an extra side of fries than to silently
drop something a coworker just touched. If the counter really wants them gone, it removes them again
after seeing the kitchen's edit, and that remove covers everything.

For whole orders, removal is used for one thing only: **cleaning finished orders off the screen**
(`removeFinishedOrder`, which refuses anything not picked up or canceled). Canceling is *not* a
removal; see "Cancel is a stage, not a removal" below.

Removed keys are never deleted from memory; their tombstones stay forever. That is a known limitation
(see the README). Real systems clean them up once every device is known to have seen the removal.

### The status: a forward-only register (`register.ts`)

An order moves through stages in one direction:

```
new  ->  cooking  ->  ready  ->  canceled  ->  picked_up
```

"canceled" comes before "picked_up" on purpose: the system should reflect what physically happened.
If the customer drove off with the food while someone else hit cancel, the pick-up wins, and any
refund is handled by a separate process.

With LWW, the newest *timestamp* wins. That goes wrong in a lunch rush. The kitchen marks an order
"ready". The counter, offline and still seeing "new", taps "cooking" a second later. When they sync,
LWW keeps "cooking" because it was written last, and a finished order jumps back onto the grill.

A **forward-only register** compares *stages* instead of times: merging two status writes keeps the
one that is further along. "ready" beats "cooking" no matter when or where each was written. If two
devices reach the *same* stage, it keeps the earlier write, so the timestamp shown with the status
means "ready since 12:03", when it first became ready.

**Why it still converges.** Both kinds of register work the same way: every write gets a position in a
fixed ordering, and merging keeps the write that comes later in that ordering. LWW orders writes by
timestamp. Forward-only orders them by stage, then by timestamp to break ties. Either way, merging is
taking a *max*, and max is commutative, associative and idempotent. Put plainly: picture every status
write anyone ever made for an order. Each device holds the "biggest" write it has heard about so far.
The biggest of a set doesn't depend on the order you looked at its members, how you grouped them, or
how many times you saw each one. So once every device has heard about every write, they all hold the
same one. Changing the ordering only changes *which* write they agree on.

Two things make this work, and both are worth noticing:

- **Every pair of writes must be comparable.** The stages form a single line, and two different
  writes never share a timestamp, so there is always exactly one biggest write. If we added a stage
  that is neither before nor after another, say "refunded" alongside "picked_up", "keep the
  furthest" would have no answer for those two. We would need a tiebreak rule or a different design.
- **A bonus guarantee: the screen never goes backwards.** With LWW, a device can show "ready", then
  receive a stale "cooking" that has a later timestamp and switch back to "cooking". With
  forward-only, a device's register only ever moves up, so its display only ever moves forward. The
  property tests check this after every single edit and message.

`setStatus` also refuses a backwards move on the local device (it throws), because the merge would
ignore that write anyway, so it is almost certainly a bug in the caller.

A write from another device can still lose. If the counter, offline, taps "cooking" after the kitchen
has already marked the order "ready", the counter's write is valid where it was made, and then quietly
loses at the merge. Nothing is wrong with the data, but the person who tapped it gets no feedback.
Milestone 4's sync log will show a message whenever a write loses to a further stage.

### Cancel is a stage, not a removal

At first, canceling removed the order from the add-wins map. But add-wins means a concurrent edit
beats the removal, so if the counter canceled an order while the kitchen, offline, marked it
"ready", the order came back to life after the sync.

Now "canceled" is a **stage**, and every active stage (new, cooking, ready) is behind it. So once any
device cancels an order, no concurrent edit can return it to the grill. The only thing further along is
"picked_up": a concurrent pick-up beats a cancel, because the customer has the food. A canceled order
stays in the map (it still shows up, marked canceled) until someone cleans it up.

### Finished orders are read-only, locally

Once a device sees an order as canceled or picked up, it refuses any new edit to it: no items, no
status changes, no re-creating it. Only cleanup is allowed. This is a rule in the device's edit
methods (`assertEditable` in `replica.ts`), **not** in the merge. Edits made on another device
*before* that device heard about the finish are still merged normally (`orders.test.ts`, "still merges
edits made elsewhere").

Why not put the rule in the merge too? The merge has to accept everything to stay a join: if a device
rejected an incoming edit because of *its* current state, two devices with different histories would
make different choices and stop converging. Local rules may depend on local state; the merge may not.

Cleanup is still an add-wins removal, so a concurrent edit to a finished order can bring it back. But
it comes back *still finished*, because its status register comes back with it. The worst case is a
finished order reappearing in the "done" list until it is cleaned up again (`orders.test.ts`,
"cleanup is add-wins").

### What these choices cost

- **No undo.** If someone taps "ready" by mistake, nothing can move it back to "cooking". A real
  system would need an explicit correction, such as a separate "recall" edit that the kitchen display
  also takes into account.
- **The stage order is a business rule.** Pick-up beats cancel because it is what physically
  happened. The merge just enforces whichever order we choose.
- **A device that shows "canceled" can't record a pick-up.** The local read-only rule blocks it. A
  pick-up only wins if it was recorded on a device that hadn't yet heard about the cancel.
- **Edits that race a cancel are kept, but don't matter.** Items added concurrently with a cancel
  are still merged into the order. The order just shows as canceled.
- **Stale writes lose silently** (until Milestone 4's sync log reports them).
- **Only one line of stages.** A stage that is neither before nor after another needs a new design.
- **Cleanup is add-wins**, so a cleaned-up order can reappear (still finished).
- **Finished orders take space until cleanup**, and tombstones are never deleted.

### The order document (`order-doc.ts`)

Putting it together, the whole store is:

```
orders: add-wins map, order id ->
  info:   LWW register           { customer, channel }
  status: forward-only register  new -> cooking -> ready -> canceled -> picked_up
  items:  add-wins map, item id -> LWW register { name, qty }
context: which edits this state already includes
```

Small CRDTs nested inside bigger ones. Because each piece merges safely, the whole merges safely.

---

## 5. How version vectors decide what to send

Each replica keeps a **version vector**: for every device, the highest edit number it has seen with
no gaps. For example, the kitchen might have:

```
{ "drive-thru": 41, counter: 17, kitchen: 9 }
```

meaning "I have drive-thru edits 1 to 41, counter edits 1 to 17, and my own edits 1 to 9."

Sync between two devices is then a short conversation (`Replica.deltaFor` and `Replica.merge`):

1. The kitchen sends the counter its version vector. That is just one number per device, so it's tiny.
2. The counter looks at every piece of its state. Each piece carries a dot like `drive-thru:44`.
   If the kitchen's vector doesn't include that dot (44 > 41), the piece goes into the reply.
3. The kitchen merges the reply with the same merge function as always.

The reply is called a **delta**. It has exactly the same shape as a full state, just smaller, so the
same merge handles both.

A few details matter:

- **Version vectors count edits by their original author, not by who forwarded them.** If the
  drive-thru can only reach the counter, and the counter can only reach the kitchen, the counter
  forwards the drive-thru's edits along with its own. The kitchen's vector records them as drive-thru
  edits, so nothing is sent twice and nothing is skipped. That is how multihop sync works
  (`sync.test.ts`, "relays edits across hops").
- **Removals need their own dots.** A tombstone is keyed by the dot of the remove edit. Without that,
  a peer that already had the order would never be sent the removal, because every dot in the
  order's `adds` is already in its version vector.
- **Gaps.** If edit `counter:5` arrives before `counter:4`, the replica records it in its *causal
  context*, which is a list of ranges like `counter: [1-3], [5-5]`. Its version vector still says
  `counter: 3`, because version vectors only count edits with no gaps. On the next sync the peer
  resends 4 and 5. Getting 5 twice is harmless, because the merge is idempotent.
- **A delta is like a patch: it assumes a base.** A delta cut for a peer at `{counter: 41}` leaves out
  things that peer already has. For example, a status write that lost a merge to a write the peer
  already has. A device that is *behind* that base and receives the delta anyway (say, it
  was delivered to the wrong place) keeps the data, since merging data is always safe. But it does not
  mark those edits as seen in its version vector. The next normal sync fills in the rest
  (`sync.test.ts`, "a delta merged without its base").

---

## 6. Why delta sync uses less bandwidth

With **full-state sync**, every exchange sends the entire store. During a lunch rush with hundreds of
orders and devices syncing every second, each device sends all of those orders, over and over, even
when only one status changed.

With **delta sync**, each exchange costs one version vector (one number per device) plus the edits
the peer is actually missing. If nothing changed, almost nothing is sent. If one status changed,
roughly one status write is sent. Cost grows with *what changed*, not with *how big the store is*.

What delta sync costs in return:

- **Metadata.** Every piece of state carries a dot, and removed things leave tombstones. The stored
  state is bigger than the plain data.
- **Computation.** The sender has to compare every piece against the peer's vector. (Real systems
  index this. lunchrush keeps it simple and scans.)

### What the benchmark measured

The numbers below are pasted in by `pnpm bench` from its latest run (section 7 explains the setup):

<!-- bench:summary -->
Measured by `pnpm bench` over 5 seeded runs of the lunch-rush outage (medians; full details in [results.md](results.md)).

| Engine | Orders lost | Status edits lost | Converged after reconnect | Total bytes | Internet bytes |
| --- | --: | --: | --: | --: | --: |
| CRDT, delta sync | 0 | 0 | 1.28 s | 1.25 MB | 0.56 MB |
| CRDT, full-state sync | 0 | 0 | 1.37 s | 48.99 MB | 1.21 MB |
| Naive last-write-wins | 41 | 19 | 0.82 s | 8.73 MB | 0.28 MB |

Delta sync sent 39.3x fewer bytes than full-state sync in total, but only 2.1x fewer over the internet. 35% of the bytes in delta-sync answers taught the receiver nothing new.
<!-- /bench:summary -->

Three things stand out, and they hold for every seed in `results.md`:

1. **Almost all of full-state sync's bytes are on the in-store network.** During the outage the
   three devices keep syncing every second. Whenever anything changed, full-state sync sends the
   whole store, which grows to 220 orders. Delta sync sends just the new edits.
2. **Over the internet, the gap is much smaller.** After ten minutes offline, the cloud really is
   missing most of the data, and any protocol has to send it. Delta sync can only skip what the
   cloud already had, and after an outage this long that is not much.
3. **Delta sync still wastes some bytes.** Right after reconnecting, the cloud sends its version
   vector to all three devices at the same moment, and each one answers with the same missing
   edits. Most of the later answers repeat what the first one delivered. A fix would be to ask one
   peer at a time when far behind, or to remember which edits are already on their way.

---

## 7. Simulating a lunch rush (`packages/sim`)

Testing sync on real devices is slow and hard to repeat. So Milestone 2 runs everything in one
process, in **simulated time**.

**A discrete-event simulator** (`simulation.ts`) keeps a virtual clock and a queue of things that
will happen at future times: "deliver this message at 12:04:31.250", "the kitchen marks order 17
ready at 12:05:02". It repeatedly takes the earliest item and runs it. Nothing waits for real time, so
twelve simulated minutes take a fraction of a second. All randomness comes from a seeded generator,
so a given seed always gives exactly the same run, byte for byte.

**The network** (`network.ts`) connects named nodes with links. Each link has:

- **latency** and **jitter**: a base delay plus a random extra. Jitter means messages can arrive out
  of order.
- **loss** and **duplication**: some messages vanish, and some arrive twice.
- **bandwidth**: big messages take time to send, and messages queue behind each other. The three
  devices' internet links share one queue, like a store behind a single router.
- **up or down**: cutting a link is how outages and partitions are modelled. Messages already in
  flight on a cut link are lost.

Every message is turned into JSON on send and parsed on arrival. That is how bytes are counted, and
it guarantees the receiver gets its own copy, never a shared object.

**Anti-entropy gossip** (`gossip.ts`): every second, each node sends its version vector to every node
it can currently reach. A peer that has edits the node is missing answers with exactly those. Every
node also serves what it learned from others, so in the scenario, where the drive-thru tablet and the
kitchen display can't reach each other, their edits relay through the counter. That's multihop.

**The scenario** (`lunch-rush.ts`): three devices and a cloud node. After a one-minute online warm-up,
the internet goes down for ten minutes. Staff keep taking orders and moving them through the
kitchen. Then the internet comes back. We measure how long the cloud takes to catch up, whether
anything was lost or duplicated, and how many bytes went over each kind of link.

**Same workload for every engine** (`workload.ts`). What the staff do is generated up front from the
seed: which device takes which order when, and who moves it to which stage. Each engine (CRDT with
delta sync, CRDT with full-state sync, and the naive baseline) faces exactly the same rush. A
device only makes a status edit if its own screen allows it: it must know the order and see it
at an earlier stage. If the order has vanished from that device, as happens with the baseline, the
edit is skipped and counted.

**Reading the results.** The naive baseline converges *fastest* after reconnect. That isn't a win:
its document is smaller because it lost orders. Convergence only means "everyone agrees". The
other columns show whether they agree on the right thing.

---

## Glossary

- **Replica**: one device's full copy of the data.
- **Merge / join**: combining two replicas' states into one.
- **CRDT**: a data type whose merge is commutative, associative and idempotent, so replicas converge.
- **Delta**: a small piece of state containing only what a peer is missing.
- **Dot**: the unique name of one edit, `device:number`.
- **Version vector**: per device, the highest edit number seen with no gaps.
- **Causal context**: the exact set of edits a replica has seen, including any beyond a gap.
- **Tombstone**: a marker that says "this edit removed those adds". It is kept so the removal can sync.
- **LWW register**: holds one value; merging keeps the write with the latest timestamp.
- **Forward-only register**: holds one value from an ordered list of stages; merging keeps the write
  furthest along the list.
- **HLC**: hybrid logical clock. A timestamp that stays close to real time but never goes backwards
  and always moves past timestamps it has received.
- **Anti-entropy**: the background process of peers comparing version vectors and sending each other
  what is missing.
- **Discrete-event simulation**: running a system on a virtual clock by processing scheduled events
  in time order, instead of waiting for real time.
- **Multihop**: two devices that can't reach each other syncing through a third that reaches both.
