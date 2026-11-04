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

The fix is not to abandon LWW entirely. It is to stop applying it to the *whole document*. lunchrush
uses LWW only for a single value where one answer really is right (an order's status), and uses
structures that keep everything for collections (the orders, the line items).

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

- The **status** of an order is a *last-writer-wins register*: merging keeps the write with the larger
  timestamp. That is a max.
- The **orders** and the **line items** are *add-wins maps*: merging takes the union of the "added"
  markers and the union of the "removed" markers. Those are unions.
- The record of **which edits a replica has seen** (its causal context) is a union of ranges.

`packages/core/test/properties.test.ts` checks these laws directly on hundreds of random states, and
also runs hundreds of random histories on 3 replicas where messages are reordered, duplicated and
dropped, then checks that every replica ends up with an identical state, with no order or item lost.

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
adds it has **already seen**. So if the counter cancels an order while the kitchen, offline, marks it
"cooking", the kitchen's edit has a dot the cancel never saw. After syncing, that dot is still live and
the order is still there. The add wins.

For a restaurant that is the right default: it is better to make one extra sandwich than to silently
lose an order someone is still working on. If the counter really wants it gone, it cancels again after
seeing the kitchen's edit, and that cancel covers everything.

Removed keys are never deleted from memory; their tombstones stay forever. That is a known limitation
(see the README). Real systems clean them up once every device is known to have seen the removal.

### The order document (`order-doc.ts`)

Putting it together, the whole store is:

```
orders: add-wins map, order id ->
  info:   LWW register   { customer, channel }
  status: LWW register   new | cooking | ready | picked_up
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
  things that peer already has. For example, a status write that was overwritten by a later one, which
  the peer already has. A device that is *behind* that base and receives the delta anyway (say, it
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

Milestone 2 measures the actual bytes sent by both approaches in a simulated lunch rush.
Those measured numbers will go here and in `results.md`.

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
- **HLC**: hybrid logical clock. A timestamp that stays close to real time but never goes backwards
  and always moves past timestamps it has received.
- **Anti-entropy**: the background process of peers comparing version vectors and sending each other
  what is missing.
