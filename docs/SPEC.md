# VivaSync — Specification

VivaSync is a Vivaldi browser **mod** that synchronizes selected workspaces —
their tabs, pin state, tab stacks (with their names and colours) and tab-bar
order — across devices, using Vivaldi Sync as the transport.

This document describes the system **as built**: every requirement below is
implemented by `mod/vivasync-mod.js` and pinned by the offline test suite
(`test/`). Requirements are numbered (R0–R4) so that code comments and tests
can refer to them. Each requirement carries its rationale in **Notes**: why the
rule exists and what goes wrong without it.

Designs that were tried and abandoned are not described inline. They are
collected at the end, in [Approaches that failed](#approaches-that-failed),
each with what was tried, why it did not work and which requirement replaced it.
Read that section before proposing a change to the engine, because several
obvious-looking simplifications are on that list.

The Vivaldi internals referred to throughout were verified against Vivaldi 8.0
and 8.1. The mod's own version is the `VERSION` constant at the top of
`mod/vivasync-mod.js`.

## R0. Storage and transport

Every document the app reads or writes — configuration included — is a **note**
in the `VivaSync` folder of Vivaldi Notes. The app performs **no file I/O** and
has no configuration directory.

> **Note (transport):** cross-device propagation is **Vivaldi Sync**, which
> replicates the Notes tree. Consequences: Vivaldi Sync must be enabled **with
> notes included**; latency and conflict behaviour are Vivaldi Sync's; and the
> documents are visible (and deletable) in the Notes panel. Document titles end
> in `.json` (`<workspace>-<device>.json`) because their content is JSON.

- **R0.1.** There is **one note per title**, by construction and by repair. A
  write updates the note the title resolves to and creates one only when a
  fresh listing has none; a failed update re-resolves the title and retries
  before it ever creates. Writes to one title are serialized. When same-title
  copies do appear (Vivaldi Sync merging two devices' first writes), the next
  listing keeps the copy with the highest `(version, timestamp, content)` —
  chosen from **content**, so every device keeps the same copy — and removes
  the rest. Two `VivaSync` folders resolve the same way: the fullest, then the
  greatest id; the others are reported and left alone.
- **R0.2.** A note whose tree entry has an **empty** `content` is read again
  through `notes.get` before it is judged (`getTree()` does not reliably
  populate `content`). *Absent* and *unreadable* are distinguished, and only an
  absent `sync.config` is seeded.
- **R0.3.** Folder resolution **skips the trash subtree**: a trashed `VivaSync`
  folder is never adopted as the live one.

  > **Note:** two notes with one title are one document twice, and every reader
  > would pick a copy at random. The keeper is chosen from content because
  > choosing by local id or tree order would have each device delete a
  > different copy — and between them, all of them. (See F17.)

## R1. Configuration

- **R1.1.** A JSON configuration document lists which workspaces to
  synchronize, by their **names** as shown in Vivaldi's workspace list, and for
  each one the **devices** that synchronize it (`peers`, by device name). Only
  workspaces listed here, on devices that name themselves in `peers`, are
  synchronized.

  ```json
  {
    "workspaces": [
      { "name": "Shared",   "peers": ["workshop", "cinfra", "W11-SETTLER"] },
      { "name": "Shared-2", "peers": ["workshop", "cinfra"] }
    ],
    "exceptions": [ "www.google.com/maps" ],
    "settings": { "urlSettleMs": 4000 },
    "timestamp": 1788308888.649
  }
  ```

  A workspace synchronizes between the devices that list themselves and no
  others; the workspace itself must exist, under the same name, on each of them
  (workspace identity is its name — the mod never creates a workspace).
  `timestamp` is stamped by the mod on every note write. Optional keys:
  `exceptions` (R1.4), `settings` (R1.5) and `autoPull` (R2.2.4).

- **R1.2.** The configuration is the note titled `sync.config` in the `VivaSync`
  folder. Being a note, it **replicates**: there is exactly one document and
  every device reads the same one. It is created as `{"workspaces": []}` on
  first run, when no note of that title exists (R0.2).
- **R1.3.** Per-device intent lives **inside** that shared document, as each
  entry's `peers` list. A device syncs a workspace when, and only when, it finds
  its own name there; the Workspaces dialog's tick box adds or removes this
  device's name and touches nothing else. Because the list is shared, every
  device can also *see* who a workspace is shared with — which is what the
  dialog's "Synced on" line shows.

  An entry without a `peers` array is ignored. An entry left with an empty
  `peers` is dropped when the note is written. Saving from a device edits only
  the entries of the workspaces that device's dialog could show (those that
  exist on it); every other entry is carried through untouched, so saving on a
  laptop that has three of five configured workspaces does not delete the
  other two for everyone.

  The note's change event only arrives if this device is running to hear it,
  so a stale selection is normal. The note is therefore re-read when the
  Workspaces, Exceptions or Settings dialog opens, and when the user switches
  into a workspace this device believes is *not* synced.

- **R1.4.** The document may carry an **`exceptions`** list: address
  **prefixes** that are never synchronized. A tab whose address begins with an
  entry is excluded from synchronization on every device (R2.1, note "excepted
  addresses"). The comparison ignores the scheme, a leading `www.` and letter
  case on both sides, so `www.google.com/maps` covers
  `https://www.google.com/maps/@40.0809214,-75.0961545,2968m/data=…` and
  `http://google.com/MAPS/place/x` alike; it is a plain prefix, so
  `www.google.com/mapsearch` is covered too and `www.google.com/search?q=maps`
  is not. The list is **shared**, like the rest of the document — an address
  excluded on one machine is excluded on all of them — and is edited in the
  Exceptions dialog (R3.2). Blank and repeated entries are dropped; anything
  that is not a string is ignored.

  Each writer of `sync.config` (the Workspaces, Exceptions and Settings
  dialogs) re-reads the note and rewrites only the key it owns, so none can
  lose another's edits. A change to the list — saved here or received from a
  peer — re-arms the write of every opened workspace, because the documents
  describe a different set of tabs now.

- **R1.5.** The document may carry a **`settings`** object overriding the
  engine's timings. Because `sync.config` is synced, tuning it once tunes every
  device.

  | key | default | meaning |
  |---|---|---|
  | `writeDebounceMs` | 500 | coalesce a burst of tab events before writing (R2.1) |
  | `switchDebounceMs` | 250 | coalesce the event burst of a workspace switch |
  | `minNoteWriteGapMs` | 5000 | floor between two writes of the **same** note |
  | `remoteDebounceMs` | 1000 | coalesce inbound sync notifications (R2.2.4) |
  | `groupSettleRetryMs` | 3000 | hold-off after a grouping failed to settle (R2.2.2) |
  | `urlSettleMs` | 2500 | quiet period a URL must hold before it is publishable (R2.1) |
  | `maxSettleHoldMs` | 15000 | upper bound on that hold |
  | `logMax` | 400 | Debug log ring buffer, lines (note only) |
  | `logLineMax` | 2000 | Debug log ring buffer, characters per line (note only) |
  | `showDebug` | `false` | whether the menu offers the Debug window (R3.4) |

  - A value is taken only if it is a finite number at or above that key's
    floor (0 for the debounces, which may legitimately mean "do not coalesce";
    `logMax` ≥ 1, `logLineMax` ≥ 80), or for `showDebug` a boolean. Anything
    else — a string, a negative, a misspelled key — falls back to the default
    **and is warned about** in the log, because a garbage debounce is
    indistinguishable from a mod that has hung and a typo is otherwise silent.
  - A key the note omits keeps its default; removing the object restores all
    of them on the next read.
  - `urlSettleMs` is also accepted at the top level of the document; `settings`
    wins when both name it.
  - The engine reads every value at the point of use, so an edit to the note
    takes effect without a restart. `VivaSync.urlSettle(ms)` and
    `VivaSync.tunables({...})` set values for the current session only.

> **Note:** device-local state that must **not** replicate — the fallback device
> id and the URL-churn counters — lives in a device-local key/value store
> (`localStorage`, falling back to `chrome.storage.local`, then memory).
> Configuration never goes there.

## R2. Synchronization

### R2.1 — Write on change

Whenever the open tabs of a synced, **opened** (see R2.4) workspace change — a
tab opened, closed, moved, pinned or unpinned; a tab added to or removed from a
stack; a stack added, removed, renamed, recoloured, pinned or moved — the app
writes the note `<workspace_name>-<device_name>.json` in the `VivaSync` folder.

`device_name` is the Vivaldi Sync session name (the device name shown in
Vivaldi's Sync settings), reduced to `[\w-]`. If that is unavailable the app
falls back to Vivaldi's default session name, then to a random `dev-xxxxxxxx`
persisted in device-local storage.

Writes are driven by `chrome.tabs` events, debounced (`writeDebounceMs`), and
throttled to at most one per note per `minNoteWriteGapMs` (5s), since each one
rewrites Vivaldi's Notes store and pushes a sync entity. A write that meets the
closed throttle is **re-armed** and re-snapshotted when the throttle opens —
never queued with a snapshot taken before the wait (see R2.2.4, invariant 3).

- **R2.1.1.** The note records:
  - **R2.1.1.1.** `timestamp` — the time of the write (epoch seconds, as a
    float, stamped by the mod). It **orders nothing on its own**: R2.2 orders
    documents by `version` and uses the timestamp only as a tie-break between
    two concurrent originations (R2.1.1.4).
  - **R2.1.1.2.** `items` — the **single ordered tab-bar sequence**, where each
    entry is either a top-level tab `{ type:"tab", url, title, pinned }` or a
    stack `{ type:"stack", id, name (or null), color (or null), pinned,
    tabs:[{url,title,pinned}] }`. A stack occupies the position of its first
    member, so the interleaving of top-level tabs and stacks is preserved
    (e.g. tab, tab, stack, tab, stack) and reproduced exactly on a clean
    restore.

    **`pinned` on a top-level tab** is state the user set and is part of the
    tab's synchronized state: a pin or unpin alone is a change worth publishing
    (it is in the change signature), and it is applied on the peers in place
    (R2.2.2a).

    **A stack is pinned as a whole.** Vivaldi's own gesture pins a tab stack as
    a unit, and it stays a stack in the pinned strip, so the stack entry carries
    its own `pinned` and every member repeats it. A stack entry with no
    `pinned` is an ordinary stack.

    **A stack's `color`** is the colour the user gave it in Vivaldi's Tab
    Stack > Color menu — one of nine named colours (`color1`..`color9`), or
    none. It is synchronized state on the same terms as the name: a recolour
    alone is a change worth publishing (it is in the change signature) and it
    is applied on the peers in place, by colouring the stack that is already
    there. `color: null` says the stack has **no** colour. A stack entry with
    **no `color` key at all** says *nothing* about colour, and a reader leaves
    the colour it has alone: a writer that does not track colour, or a
    hand-edited document, must not silently strip a colour the user set.
    (`pinned` has no such third case: a stack is pinned or it is not, and
    saying nothing means an ordinary stack.) The token is carried through
    without being checked against the nine names, because a later Vivaldi
    build may add to the list and a colour the mod does not recognise is still
    the user's choice; it is only bounded in length (32 characters).

    **A group whose members disagree about `pinned` is not a stack, or not
    all of it.** Mixed groups exist because Vivaldi drops a newborn tab into
    the active tab's stack whatever either one's pin state is. Writer and
    reader both partition such a group by pin state and take the larger part
    as the stack, ties going to the unpinned side; the odd tabs out are
    top-level tabs carrying their own pin, and a part of fewer than two members
    is not a stack at all. So a pinned tab in an ordinary stack is published —
    and read — as a top-level pinned tab beside the stack, on every device,
    which is the repair as well as the rule.

    **The sequence is synchronized state.** The order of the *unpinned*
    top-level items — tabs and stacks, a stack at its first member — and the
    order of the members inside each unpinned stack are part of the
    workspace's state: a reorder alone is a change worth publishing (it is in
    the change signature), and the peers reproduce it in place (R2.2.2b). So
    opening a link inside a stack, or dragging one member past another,
    replicates like any other change. One order is carried in the document and
    deliberately **not** synchronized: the order of the **pinned strip**,
    including the members of a pinned stack and its place among the pinned
    tabs. The mod never moves a pinned tab, and pinning already places it at
    the front of the bar.
  - **R2.1.1.3.** A document contains exactly `workspace`, `items`, `origin`,
    `version` and `timestamp`. A note whose JSON lacks any of `workspace`,
    `origin`, `version` or `items` is **not a sync document**: it is dropped at
    listing time with one warning per title, never matched by its title, and
    nothing past the listing guards against the fields being absent.
  - **R2.1.1.4.** **Provenance.** `origin` is the name of the device whose
    *user* made the state the document describes; `version` is that device's
    reading of a per-workspace **Lamport clock** when it did. Every version
    seen in the folder raises this device's clock, and a change made here is
    written at clock + 1, so a change made after seeing a peer's state always
    out-ranks it however the two wall clocks are set. Two states are the same
    state when their `(origin, version)` agree, whatever their `items` order
    or timestamp. (R2.2 says how the fields are compared; R2.2.4 how a peer's
    copy of our own state is recognised.)

    > **Note (why the document, not each item, carries the origin):** reconcile
    > is newest-wins over the **whole document**, so the question the origin
    > answers — "is this newer than what I hold, and is it mine coming back?"
    > — is a document-level question. The damage provenance prevents is a
    > **deletion**, and a deletion is an absence: the tab closed on the
    > originator is missing from the peer's echo, and an absent item has no
    > field to carry an origin. Protecting "my" items per item would either
    > stop a peer from ever closing a tab this device opened, or require
    > tombstones and per-item versions — a different engine. A per-item
    > `origin` could still be carried as information; it would decide nothing.

  > **Note (URL identity):** tabs are matched on a **normalised** URL: host
  > lower-cased, a leading `www.` and a default port dropped, one trailing slash
  > removed. Query and fragment are preserved, since collapsing them would merge
  > tabs the user considers distinct (two views of one SPA). The document still
  > stores the raw URL — normalisation is for matching only.
  >
  > Without it, any site that redirects to a different spelling of its address
  > can never round-trip: device A publishes what it opened, device B opens it,
  > the site bounces, B publishes the new address, A stops recognising its own
  > tab and deletes + recreates it — a tab opening and closing repeatedly on
  > both machines, with sustained CPU load.
  >
  > Because no normalisation can fix a URL that genuinely lands elsewhere (geo
  > redirect, session id in the path, login bounce), a **circuit breaker** caps
  > repeated attempts to open the same URL (3, device-local, expiring after 30
  > minutes, cleared as soon as the URL sticks). Past the cap the app refuses to
  > reopen it and reports it via `VivaSync.diagChurn()`. Convergence for such a
  > URL is impossible; terminating is the requirement.

  > **Note (empty new tabs are not synced):** a tab showing the start page or
  > `about:blank` carries no address the other device could meaningfully open,
  > is spelled differently across builds (`about:blank`, `chrome://newtab`,
  > `chrome://vivaldi-webui/startpage`, `vivaldi://startpage`), and is about to
  > become something else as soon as the user finishes typing. It is therefore
  > **never published**, and — symmetrically — **never deleted** for being
  > absent from a remote document. Publishing one has each device broadcasting
  > its own spelling of "nothing" while the other opens, closes and re-opens it
  > — a new tab flipping between empty and loaded on both machines in step. No
  > amount of waiting fixes it, because the trigger is the unbounded pause
  > between opening a tab and typing into it. A workspace containing only a new
  > tab therefore serializes as empty.

  > **Note (excepted addresses are not synced):** a tab whose address begins
  > with an entry of the `exceptions` list (R1.4) is handled exactly like an
  > empty new tab, on every device: it is **not published** (absent from the
  > document and from the change signature, so it can neither trigger a write
  > nor hold a pull back), it is **never closed** for being absent from a
  > remote document, and a remote document that still lists such an address —
  > written before the exception existed, or by a peer that has not reloaded
  > the configuration yet — **does not open it**. It also does **not count as
  > a stack member**: a stack of one ordinary tab and one excepted tab is the
  > ordinary tab, top-level, in the document this device writes *and* in the
  > live view it reconciles against, so a peer's document listing that tab
  > top-level leaves the local stack intact; a remote stack that exceptions
  > reduce to one member arrives as a plain tab. Removing an exception puts
  > the tab back into the document as a fresh origination (R2.1.1.4) on the
  > write the reload re-arms.
  >
  > The one cost is at the moment an exception is *added* for a tab that is
  > already synchronized: the workspace document without the tab and the
  > configuration note are separate sync entities, so a peer may receive the
  > document first and close its copy of the tab once. Nothing else is touched.

  > **Note (tabs in flight):** a tab that is still navigating
  > (`status === "loading"`) has a transient URL (pre-redirect, or
  > `about:blank`). A workspace containing one is not published until it
  > settles — bounded by 30s of wall time, not a count of polls, so a
  > permanently-loading tab cannot block the workspace for ever and a page that
  > takes ten seconds to commit is not described as absent. A tab navigating
  > away from the start page is snapshotted as its `pendingUrl` rather than
  > filtered out as blank. Whether a loading tab may be *closed* is R2.2.1.
  >
  > A **hibernated** tab is not a tab in flight. `chrome.tabs.Tab.status` is
  > `unloaded | loading | complete`, and Vivaldi both discards background tabs
  > and restores a session lazily, so right after a restart most of a workspace
  > reports `unloaded` while holding a perfectly good URL. Only `loading` counts
  > as in flight. Counting `unloaded` too would pin every hibernated tab in
  > place — it could never be deleted for being absent from a remote document,
  > so **deletions would stop crossing between devices altogether** — and make
  > every publish spend its whole deferral budget first.

  > **Note (a settled address, not merely a loaded one):** a completed load is
  > not the same thing as an address the user meant to keep. A site that drives
  > its URL from an input box — Google Translate, search-as-you-type — completes
  > a navigation on *every intermediate value*, so "publish once it has finished
  > loading" would publish half-typed addresses: the peer opens each prefix in
  > turn, publishes it back, and the user's own tab reloads through its own
  > typing history. What separates a value the user stopped on from one they
  > typed through is a **quiet period**: a workspace is published only once
  > every URL in it has held still for `urlSettleMs` (R1.5), the write
  > re-arming for exactly the time left. Bounded by `maxSettleHoldMs`, so a page
  > that rewrites its URL on a timer delays the publish rather than cancelling
  > it.

  > **Note (a stack of one is not a stack):** Vivaldi stops rendering a stack
  > as soon as it drops below two tabs, and closing the second-to-last member
  > leaves the survivor as an ordinary tab. Whether it also clears `group` in
  > that tab's `vivExtData` is not something the app can rely on, so a group
  > with a single live member is serialized as a **top-level tab**, and a stack
  > entry arriving with fewer than two tabs is read as one. Without this, the
  > device where the user took a stack apart publishes a one-member stack and
  > every peer rebuilds a stack the user has just dismantled.
  >
  > **Note (identity):** the stack id (`group` in tab `vivExtData`) is carried
  > in the JSON, but it is **not** used as the cross-device identity. Vivaldi
  > assigns stack group ids itself (`crypto.randomUUID()`) when a stack is
  > created and the UI cannot choose them, so ids differ per device. Stacks are
  > therefore matched on reconcile by **name** (if named) else by **member-URL
  > overlap (Jaccard ≥ 0.5)**. This keeps unnamed stacks as real stacks, makes a
  > **rename** a non-destructive attribute change, and avoids cross-device id
  > ping-pong. Tabs are identified by `(container, normalised url)`; duplicate
  > identical URLs in one container collapse to one.
  >
  > **Note (write mechanism):** `chrome.tabs.update({vivExtData})` is a no-op in
  > the Vivaldi UI context, so stacks are created via
  > `vivaldi.tabsPrivate.move(... "create-new-group" ...)`, named and coloured
  > via `vivaldi.tabsPrivate.setGroupProperties`, mirroring Vivaldi's own
  > `createTabStack`, `setFixedStackTitle` and `setStackColor`. Workspace-tab
  > ordering is reproduced by the order phase (R2.2.2b) through
  > `vivaldi.tabsPrivate.move` with a strip index — Vivaldi's own `moveToIndex`
  > call — and the workspace named explicitly; `chrome.tabs.move(id,{index:-1})`
  > must not be used (the strip index spans all workspaces, and moving to the
  > window end reassigns the tab to a neighbouring workspace).

### R2.2 — Reconcile on open

When a synced workspace is opened (becomes active), the app reads every
document of that workspace in the `VivaSync` folder (R2.1.1.3; ownership by
payload, see Operational notes), raises its version clock with every `version`
seen, discards every document whose `origin` is this device (R2.2.4), and finds
the **newest** of the rest by provenance: `version` first, then `timestamp`,
then origin name. When two documents carry the same state (the origin's own and
a peer's acknowledgement of it), the origin's own is preferred. The app
reconciles (newest-wins, whole-document) when that remote **out-ranks the state
this device holds** — the provenance of its own document on the first reconcile
of a session, then of every state it has applied or written since — and does
nothing when the remote *is* the held state (`(origin, version)` equal) or
ranks below it. A reconcile that finds nothing to apply still ends with a
(signature-gated) write, because opening the workspace is what makes it
publishable at all (R2.4).

**Local news is merged, not overwritten.** On the first reconcile of a session,
and on opening a workspace whose live state differs from what this device last
published, the remote applied is the remote **plus** every tab here that this
device's own last document does not list — a tab opened, or moved in from
another workspace, while the remote was not being applied — appended in its
stack (the remote's copy when the rest of the stack was published before, its
own otherwise), and, when this device's document is this session's own
publish, **less** every tab that document listed and the workspace no longer
holds. (On the first open of a session a tab missing here may simply not have
been restored yet, and a close that is a guess must never propagate.) What the
remote says about everything else — its closes, pins, names, colours and order
— stands. A merged state is this device's news: R2.2.3 publishes it as a fresh
origination, numbered above the remote.

With unpublished local changes and a remote that is only *concurrent*
(`version` no higher than the held state's — neither side saw the other), no
merge is needed and nothing is applied: the pull is deferred and the local
state is published first under the next version (R2.2.4).

**No fresh origination is published over a peer state numbered above the held
one.** Such a state was made after its device saw a state at least as new as
ours; this device's next version is numbered from the folder it last read, so
it would come out equal to the peer's or below it — and either lose (the next
pull closes our change) or win on the clock tie-break (the peer's change is
lost on both machines). So before a write that is not an acknowledgement, the
app checks the folder: the **active** workspace is merged first, as above, and
the merge is what gets published; a workspace that is **not showing** holds its
write until it is opened (it cannot be reconciled while inactive, R2.2.5). A
peer state with an **equal** version is concurrent and does not count. This
rule rests on provenance alone — not on which workspace the browser shows, nor
on whether a switch has been handled — and no write of a workspace runs while
that workspace is being reconciled.

> **Note:** the typical case is "Move to workspace": the user sits in another
> workspace while a peer changes a synced one (nothing arrives yet, by design),
> then moves tabs or a whole stack into it. Vivaldi switches into the target,
> the switch pulls the peer's pending state, and the moved tabs are listed in no
> document — a plain whole-document apply would close them. The browser fires
> the move's tab events (and so arms a write) *before* the switch is handled,
> and sometimes no switch is observed at all; the provenance check above covers
> every ordering. (See F21.)

- **R2.2.1.** Delete from the live workspace all tabs and stacks not present in
  the newest document (tabs by `(container, url)`; stacks matched by
  name/contents).

  > **Note (a loading tab, and whose it is):** a tab mid-navigation that the
  > **user** opened is never deleted for being absent from a document — its
  > address is not a fact yet, and closing it takes a page out from under the
  > user. A tab **this device opened because a document named it** is the
  > opposite case: nobody is typing in it, so a newer document that no longer
  > names it closes it even while it loads. The engine records the tabs it
  > opens and forgets each one as soon as it commits its address (or closes).
  > Without the distinction, a second document arriving inside the first
  > apply's load window would leave every tab of the first one open, and the
  > acknowledgement would publish them back under the peer's own provenance —
  > which the peer never applies (R2.2.4), so the devices would sit on
  > different tab sets until something else changed.

  > **Note (a stale id must not abandon the delete list):** `chrome.tabs.remove`
  > rejects a bulk call outright if **any** id in it is no longer live ("No
  > such tab - N"), and a tab can go stale between planning and closing on its
  > own — dissolving a stack is asynchronous. The delete phase therefore tries
  > the bulk call first and, if it is rejected, closes one tab at a time,
  > tolerating the ids that really are gone. Otherwise one stale id leaves
  > every tab a peer asked us to close still open, which is indistinguishable
  > from "deletes do not propagate".

- **R2.2.2.** Create in the live workspace the tabs and stacks present in the
  newest document but absent locally, in the correct container, in document
  order; new stacks are created via `vivaldi.tabsPrivate.move` and named — and
  coloured — via `setGroupProperties`.

  > **Note (move, do not re-open):** a tab whose URL is already live in this
  > workspace but in the **wrong container** — the user moved it into or out of
  > a stack on the other device — is *moved*, not closed and re-opened.
  > Deletion is planned first but not executed until the create phase has had
  > the chance to adopt each unwanted tab, and only what nothing claimed is
  > closed.
  >
  > This is a correctness rule, not an optimisation. A tab that is still
  > navigating is never closed (R2.2.1), so if such a tab were left where it is
  > *and* a fresh copy opened in the target container, the same page would end
  > up present once per container: a stack member deleted on one device would
  > produce, on the other, a leftover top-level tab **plus** the original stack
  > still holding both.
  >
  > Taking a tab back out of a stack goes through `ADAPTER.detachFromStack`,
  > which moves the tab with the `ungroup` tweak (what Vivaldi's own
  > `removeFromTabStack` does), then failing that a `vivaldi.tabsPrivate.move`
  > not told `do-not-reparent`, then a group of its own, verifying
  > `vivExtData` after each. `VivaSync.diagDetach()` exercises the primitive
  > against a live build; it reported success on Vivaldi 8.1.

  > **Note (a new tab leaves the stack it was dropped into):** Vivaldi drops
  > every newborn into the **active tab's stack**, and `pinToWorkspace` passes
  > `do-not-reparent`, so nothing else would take it out again. Every tab
  > created for top level is therefore passed through `detachFromStack`
  > afterwards. So is a tab created for a stack, unless it happens to have
  > landed in the very group the plan is extending: both members of a *new*
  > stack otherwise start out in the user's stack, together, and "these tabs
  > are one stack now" is already true of the wrong group. For the same reason
  > the wait that follows `createStack` names the group it asked for (the id
  > the move answered with) and waits for **that** one — otherwise the wait
  > returns the user's group, the new stack's name is applied to the user's
  > stack, and the new stack never settles.

  > **Note (grouping is asynchronous):** `vivaldi.tabsPrivate.move` returns the
  > new group id before the tabs' `vivExtData` carries it, so every grouping,
  > ungrouping, rename and recolour is **waited out** before the reconcile
  > returns. The write in R2.2.3 happens immediately afterwards, and a snapshot
  > taken while the grouping is still in flight describes plain tabs — a
  > document that tells every peer to take the stack apart. Each peer then
  > republishes, and the devices alternate grouped/ungrouped indefinitely.
  >
  > **Note (adding a member to an existing stack):** applying "this stack has
  > gained a tab" goes through `ADAPTER.addToStack`, which moves the tab with
  > `["do-not-reparent","on","create-group"]` **targeting the stack's group id**
  > — Vivaldi's own drop-a-tab-onto-a-stack call. `tabsPrivate.move`
  > **validates** the tweak vocabulary and throws on a name it does not know,
  > so only tweaks Vivaldi's own `bundle.js` passes are used (the accepted list
  > is in `test/fixtures/vivaldi-api.json`, and the test harness enforces it).
  > The join is **verified** after the fact and, if it did not land (or the
  > call threw), the whole stack is rebuilt with `createStack` over every
  > member; a throw never abandons the rest of the plan. Without this, a tab
  > opened inside a stack on one machine arrives on the other as a plain
  > top-level tab, is published as one, and the originating machine then takes
  > it back out of its own stack. `VivaSync.diagAddToStack()` exercises it
  > directly.
  >
  > **Note (a grouping that never lands is not published):** if any grouping is
  > still not in `vivExtData` when the waits give up, `applyDesired` reports
  > `settled: false` and R2.2.3 is **skipped entirely** for that round, the write
  > re-armed `groupSettleRetryMs` later instead. Publishing the half-applied
  > state would be an instruction to every peer to undo the grouping — the truth
  > late is strictly better than a lie now.

  > **Note (name and colour are asserted, not re-asserted):** both are set only
  > when the live stack actually differs from the document. `setGroupProperties`
  > is a real browser mutation and each one costs another wait for `vivExtData`
  > to catch up, so re-stating a name or a colour that is already right on every
  > reconcile would be pure churn. They are two separate calls, each carrying
  > one property, which is how Vivaldi's own UI uses the API
  > (`setFixedStackTitle` passes `groupTitle`, `setStackColor` passes
  > `groupColor`); that neither erases the other is measured by
  > `VivaSync.diagMakeStack()` (`nameKeptOnColor`) rather than assumed
  > silently. A rebuilt group is a **new** group and carries neither, so
  > wherever a stack is rebuilt — a join that did not land, or a pin that took
  > the group apart — the name and the colour are both re-applied afterwards.
  > This is also why a document that says nothing about the colour still leaves
  > the plan carrying one: the colour to restore after a rebuild is the colour
  > the stack had.

- **R2.2.2a.** Apply the `pinned` flag of the newest document to every tab it
  speaks for — kept, adopted or created, top-level or a member of a stack the
  document pins — **in place**, without moving or closing a tab. A tab that
  differs from the document *only* in its pin state is already present
  (identity is `(container, url)`), so no create or delete ever reaches it;
  without this phase, pinning a tab on one device would change nothing on the
  others unless the tab happened to be new there.

  > **Note (ordering):** the pin phase runs after the create, delete and
  > grouping phases, because pinning moves a tab to the front of the strip and a
  > move may strip a pin. It therefore **re-reads the live tabs** rather than
  > predicting what each move did to the flag, changes only what differs, and
  > reads back once more to log a refusal or a tab that left the workspace.
  >
  > **Note (a pinned tab is never moved — unless it landed in a stack):** a tab
  > the document wants pinned and that does not exist here is created
  > **pinned**, takes its workspace from create-time `vivExtData` (the
  > update-time write is a no-op; the create-time one is honoured), and is not
  > passed through `pinToWorkspace`, which may strip the pin. Where it landed
  > is verified. A tab that missed the workspace is placed the ordinary way and
  > loses the pin, because a tab in the right workspace unpinned beats a pinned
  > tab in a workspace the snapshot cannot see. A tab that landed **inside the
  > active tab's stack** — Vivaldi drops a newborn there pinned or not — is
  > unpinned, detached and re-pinned by the pin phase, before the grouping
  > phase plans around that stack.
  >
  > **Note (a pinned tab is not a member of a stack that is not pinned):** the
  > pin phase is the one place that still looks at the raw group a tab reports
  > (R2.1.1.2 has writer and reader partition a mixed group instead), and it
  > takes a tab that is to be pinned and that the document does **not** place
  > inside a stack out of any group of two or more it sits in — unpin, detach,
  > re-pin. Without this a workspace already in the broken state would never
  > leave it: its document describes the intended state, so nothing else in the
  > apply differs from it, and the browser's pinned-tab-in-an-ordinary-stack
  > would outlive every reconcile. Left alone, the device holding such a group
  > would also publish the pinned tab as the stack's first member, and the peer
  > would faithfully move *its* pinned tab into the stack. A member of a stack
  > the document itself pins is exempt — that group is meant to be pinned, as a
  > whole.
  >
  > **Note (pinning a stack, and putting it back together):** a stack the
  > document pins is pinned one member at a time, because that is the only call
  > the API offers, while the user's own gesture pins the stack as a unit. A
  > member is therefore never created pinned for a pinned stack: it is created,
  > grouped, and pinned afterwards, or it would land in the pinned strip and
  > never join the group. Whether a build keeps the group through a member-by-
  > member pin is unverified (`VivaSync.diagPin()` reports it), so the group is
  > **read back** after the phase and rebuilt with `createStack` — renamed and
  > recoloured — when it came apart; a rebuild that does not settle leaves
  > `settled: false` and publishes nothing that round, because a document
  > describing a group that is half pinned is an instruction to every peer to
  > take the stack apart.
  >
  > **Note (a refused pin is logged, not acted on — and cannot swap):** under
  > R2.2.4 the first write after an apply is an acknowledgement under the
  > peer's origin whatever the browser made of the apply — and is dropped
  > altogether when the apply changed nothing — and a device never applies its
  > own origin. A refusal therefore costs the pin and nothing else, and
  > `pinned` can safely be part of the signature. `VivaSync.diagPin()` reports
  > what a build honours. Residual, and known: a device that cannot pin
  > publishes its unpinned view the next time its user changes anything, and
  > the pin is then lost on the peers rather than restored — the
  > whole-document price of not having per-field clocks. (See F10.)

- **R2.2.2b.** Put the workspace's **units** — an unpinned top-level tab, or an
  unpinned stack — into the document's sequence, **last of all** (after the pin
  phase, whose moves to the front of the strip must be over before indices
  are read) and with the **fewest moves**: the units already in increasing
  document order stay where they are (longest increasing subsequence), and
  each of the others is moved once, to sit right after its predecessor in the
  sequence (the unit heading the sequence goes in front of the first kept
  one). Each move is one `vivaldi.tabsPrivate.move` to a strip index — the
  call Vivaldi's own `moveToIndex` makes — naming the workspace and passing
  `do-not-reparent`; if a build takes the workspace argument as "park at the
  end of that workspace", the same move without it is tried. The strip is
  **re-read before every move** rather than simulated.

  > **Note (the placement rules):** a stack moves as **one run**, every member
  > in one call, never a member on its own (a member moved alone leaves its
  > stack); a target is always a **boundary between units**, never inside
  > another stack's run, so a tab is never placed where Vivaldi's add-to-stack
  > gesture would read it (`do-not-reparent` is not relied on to prevent that);
  > the strip is **re-read** before each move, because the browser may
  > reposition more than was asked; and the reorder is **minimal**, so a
  > workspace that is already in order costs nothing. Deciding after a move
  > whether the browser or the user regrouped a tab is unnecessary: the write
  > after an apply is an acknowledgement under the peer's provenance whatever
  > the browser did (R2.2.4), so a rendering that differs from the document is
  > published as the peer's state, never as this device's news, and the peer
  > never applies it. (See F13 for the design these rules came from.)
  >
  > **Note (members inside a stack):** after the units are in order, the
  > members of each stack are put into the document's member sequence the same
  > way, by moving one member at a time **inside its own run**. That target
  > lies between two members of the same group, so the absorption hazard above
  > cannot arise; what is not certain is that `do-not-reparent` keeps the tab
  > in the group on every build, so **every such move is verified** — a member
  > that left its run is put back with `addToStack` and that stack's reordering
  > is abandoned for the round. A member the document does not name keeps its
  > relative position at the end of the run.
  >
  > **Note (identity, not addresses — and a newborn is loading):** the phase is
  > driven by an **order plan** the create phase builds, one entry per desired
  > item in document order, naming the live tabs that satisfy it. It must not
  > re-match by address: a tab this apply has just opened is `loading`, and a
  > loading tab is volatile — never closed, not published until it settles —
  > so a phase that skipped volatile units would silently skip every tab it had
  > just created. Vivaldi opens a link's "open in new tab" next to the tab it
  > was clicked in, so the peer's document names such a tab in the middle of
  > the sequence; created at the end here, it has to be moved. Moving a loading
  > tab is harmless — volatility is about closing and publishing, not
  > position.
  >
  > **Note (what is left alone):** the pinned strip, and any tab no document
  > speaks for — a loading tab the document does not name, an empty new tab, an
  > excepted address — which simply keeps its place. A unit that does not land
  > where it was sent is logged once and left; the acknowledgement then
  > describes the order this device actually has. No timer retries it: a
  > browser that will not reproduce an order costs one differing rendering,
  > which the provenance rules make harmless. `VivaSync.diagOrder()` reports
  > what a build does with an index move, and whether a top-level tab placed at
  > a stack's edge is absorbed into it — a hazard this design never provokes
  > but cannot rule out offline.

- **R2.2.3.** Write an updated `<workspace_name>-<device_name>.json` per R2.1.1
  — **only if the resulting local state differs from what was last written**
  (the change signature, R2.2.4), never as a forced write.

  > **Note (why this must not be a forced write):** an unconditional write here
  > is a perpetual-motion machine. A writes → B applies and writes a *newer*
  > document even though nothing changed → A applies and writes → … The two
  > devices ping-pong for ever, each lap costing a full notes read, a note write
  > and a sync push (sustained ~15-20% CPU on both machines). Gating on the
  > content signature makes the exchange terminate as soon as the devices agree.
  > (See F2.)

- **R2.2.4.** Reconcile additionally runs when Vivaldi Sync delivers a change to
  a note in the `VivaSync` folder (`vivaldi.notes.onChanged` / `onCreated`,
  debounced by `remoteDebounceMs`, ignoring the device's own writes and any note
  outside the folder). A remote change therefore lands without requiring a
  workspace switch.

  This pull is **deferred when the device has unpublished local changes** (live
  signature ≠ last written signature) — on the note-event path *and* on the
  workspace-switch path. Reconcile is newest-wins whole-document, so anything
  absent from the remote is closed; a tab the user just opened is by definition
  absent from every peer's document, and pulling before the local write goes
  out would delete it under the user's cursor. The pending write is scheduled
  instead, and the deferred pull is **retried the moment that write lands**
  rather than waiting for the next unrelated note event. (On the switch path a
  remote that out-ranks the held state by version is merged instead of
  deferred, as R2.2 describes.)

  **The change signature** compares the **sequence** of unpinned top-level
  items and of each unpinned stack's members (R2.2.2b reproduces both, so a
  reorder is a change like any other), each stack's **name** and **colour**,
  and each top-level tab's and stack's **pin state**; it is order-insensitive
  over the pinned strip alone (pinned stacks included, compared by name, colour
  and member set), which nothing reproduces. It excludes titles, timestamps and
  provenance. An order that were compared but not reproduced would look like
  unpublished local news for ever and defer every pull; what makes the
  sequence safe to compare is R2.2.2b together with the acknowledgement rule
  below — a rendering the browser will not reproduce exactly is acknowledged
  under the peer's provenance and costs nothing further.

  Three provenance rules (R2.1.1.4) decide what is applied:

  - **A document whose `origin` is this device is never applied**, whatever
    its content or timestamp. It is this device's own state coming back
    through a peer, and applying it can only undo what the user has done here
    since. Recognising it by anything other than the origin fails: the peer's
    rendering of our state is not guaranteed to be identical to ours (see F1).
  - **The first write after an apply is an acknowledgement.** The adopted
    provenance is recorded *before* the apply (the apply's own tab events
    schedule the write), and the next write of that workspace goes out with
    the adopted `origin`, `version` and `timestamp` unchanged, whatever the
    browser made of the apply (a unit that would not move, a tab the browser
    placed elsewhere). A peer's rendering of our state is not the peer's news.
    A change the user makes here inside the apply window is folded into the
    acknowledgement and published under the next fresh version — delayed,
    never swapped away. If the apply changed nothing, the pending
    acknowledgement is dropped rather than spent on the user's next change.
  - **A remote is applied only if it out-ranks the state this device holds**
    (R2.2). Comparing against what is *held* — not against "the last remote
    applied" — is what makes two concurrent originations resolve identically on
    both sides: each compares the other's against its own, exactly one yields,
    and the states do not swap.

  And one rule decides what may be written (**invariant 3**): a write publishes
  the state it **lands** with, not the state it was armed with. The per-note
  throttle waits inside the note write, after a snapshot would have been taken
  and before the payload is stamped; a write that meets the closed throttle is
  therefore re-armed and re-snapshotted, never queued. A queued write would
  publish a state up to five seconds out of date under a brand-new timestamp,
  and the two devices would trade a state neither of them is in any more.

  Set `"autoPull": false` in the config note (or call `VivaSync.autoPull(false)`)
  to disable R2.2.4 entirely and pull only on workspace activation.

- **R2.2.5.** `applyDesired` **must refuse to run for a workspace that is not
  the active one**, and **must create before it deletes**. A reconcile of a
  workspace that is not active bails before changing any state (it does not
  mark the workspace opened, nor move the held provenance).

  > **Note:** tab creation relies on a new tab auto-joining the *active*
  > workspace, and the active workspace is derived from the active tab. If the
  > delete phase empties the workspace even for an instant, Vivaldi activates a
  > tab from a neighbouring workspace; the active workspace silently becomes
  > that other one while the workspace selector still shows the original, and
  > the remaining creates land in the wrong workspace. Creating first keeps the
  > workspace populated throughout, and the precondition catches the rest.

  > **Note (active-workspace detection):** "Opened" = the workspace becomes
  > active. The active workspace is detected from the `workspaceId` in the
  > `vivExtData` of the currently active tab. Tabs outside every workspace are
  > a place too: leaving a workspace for them and coming back is a switch back
  > into it. Ordering is always **relative** to the workspace's own tabs (the
  > tab strip's absolute index is shared with other workspaces): created tabs
  > append after the workspace's last tab, and the order phase computes every
  > target from the live strip, next to a tab of the same workspace.
  >
  > **Note (clock skew):** ordering is by `version`, a logical clock, so the
  > wall clocks of the devices need not agree at all for ordinary operation. The
  > timestamp decides only between two originations at the **same** version —
  > two users changing the workspace without having seen each other's change —
  > and there it is the tie-break both sides compute the same way. A device
  > with a badly wrong clock loses (or wins) those ties, and nothing else.

### R2.3 — Workspace name resolution

Workspace names ↔ ids are read from the Vivaldi preference
`vivaldi.workspaces.list`, via `vivaldi.prefs.get` directly in the UI context
(cached for 15s; the dialogs force a refresh). Workspace ids are float
timestamps (`1717425015828.0`) and are normalised with `String(Number(id))`
before comparison. The prefs list can lag a just-created workspace, so the
Workspaces dialog also folds in workspace ids that have live tabs.

> **Note:** `vivaldi.prefs.get` returns the raw value on some builds and a
> wrapper object (`{value}` / `{currentValue}` / `{defaultValue}`) on others; the
> adapter unwraps it and never coerces an object to a string (which would yield
> an `[object Object]` device name, and notes titled after it).

### R2.4 — Materialization safeguard

A synced workspace is **eligible to be written only after it has been opened
(activated/reconciled) at least once in the current browser session.**

- Rationale: Vivaldi **lazy-loads inactive workspaces**, so the tabs of a
  workspace that has not been opened this session are **not materialized** and
  would serialize as empty. Without this rule, startup would (a) write empty
  documents over real content and (b) propagate an empty-but-newer document
  that, under R2.2, would **delete all tabs** of that workspace on other
  devices. For the same reason startup does not publish anything on its own:
  it only reconciles, and then writes, the workspace that is active.
- Additional guard: the app must not overwrite a previously non-empty document
  with an **empty** snapshot while the workspace is **inactive** (guards against
  tabs being unloaded/hibernated). A genuine emptying performed while the
  workspace is active is still recorded.
- Additional guard (onboarding): a device that has **neither held content in a
  workspace nor seen another device's document for it** must not publish an
  empty snapshot of it. Opening the workspace pulls the newest remote first
  (R2.2), but that pull does **nothing** when the peers' documents have not
  replicated yet — and a new device receives the single small `sync.config` note
  before the larger `<ws>-<device>.json` ones, because notes replicate as
  separate entities. In that window the device cannot distinguish an empty
  workspace from one whose document has not arrived, and its empty snapshot
  would out-rank every peer's, deleting the workspace everywhere. Refusing
  costs nothing: an empty first document conveys no information, and
  publishing resumes the moment either a peer document arrives or the
  workspace has content.
- Consequence: a workspace ticked on a device that already has peers on it
  (R2.5, joining) is published immediately but only adopts the shared content
  when it is first opened; the Debug window's `E. materialized` row names the
  workspaces still waiting to be opened.

### R2.5 — Publish on tick, withdraw on untick

Ticking a workspace in the Workspaces dialog (R3.1) writes
`<workspace_name>-<device_name>.json` immediately, from the workspace's live
tabs, without requiring the user to switch into it first. R2.4's gate is
bypassed deliberately; the **provenance** the note is written with is what
keeps it safe, since R2.2 is newest-wins whole-document:

- **First device on the workspace** — no other device appears in the entry's
  `peers` and no document for it exists in the folder — the note is written as
  a fresh origination of this device (`origin` this device, `version` clock + 1,
  the current time). There is nothing to overwrite, and the workspace becomes
  eligible for R2.1 writes from then on (it is demonstrably materialized: its
  live tabs were just serialized).
- **Joining a workspace another device already synchronizes** — the note is
  written with `version: 0` and `timestamp: 0` (1 January 1970). It exists and
  names this device, but loses every comparison, so the other devices keep
  their content and this one adopts it on its first pull. **Whatever the
  workspace held on the joining device is discarded**; that is the intended
  direction, since the alternative is a newcomer's private copy silently
  replacing the shared one everywhere. The workspace is **not** marked opened
  — it stays pending until the user opens it and actually receives the shared
  content — but its signature is recorded, or the pull would be deferred for
  ever as "unpublished local changes" (R2.2.4).
- **Neither** — the workspace has no live tabs here and no peer document exists —
  **nothing is written**. An empty snapshot cannot be distinguished from an
  unmaterialized workspace (R2.4) and would instruct every later device to close
  it. The workspace stays in the "not yet published" list.

Unticking a workspace **deletes this device's**
`<workspace_name>-<device_name>.json` note, and the per-workspace session state
with it, so that re-ticking is a fresh join rather than a resumption. Other
devices' documents are untouched. A write still pending in the note-write
throttle is waited out first, so the note cannot be recreated after removal.

Both actions apply only to workspaces whose ticked state actually **changed**:
re-saving the dialog must not re-stamp a document the other devices are using.

## R3. UI

A **⇄** button in each window's status bar opens a popup **menu**: **Workspaces**,
**Exceptions**, **Settings**, **Debug** (listed only when `showDebug` is on,
R1.5) and **About**. The menu is anchored to the button, flipping above it when
the button sits in the lower half of the window, and dismisses on outside click
or Escape (armed on the next tick, so the opening click cannot close it). It is
rebuilt on every open.

Everything is rendered into the visible `window.html` document reached via
`chrome.extension.getViews()` — `main.html`, where the mod runs, is a headless
0×0 document and paints nothing. The button is re-asserted on a timer, since
React re-renders drop it and new windows start without it. The dialogs share
one overlay element, so only one is up at a time, and every dismissal path
(backdrop, Escape, `close()`) runs the same teardown.

Two constraints of the host document apply to every dialog:

- **No native checkboxes.** Vivaldi's `window.html` styles
  `<input type=checkbox>` with `appearance:none` and drives it from its own
  React handlers, so an injected one renders as an empty square whatever its
  `checked` says, and does not toggle. Every tick box is drawn by the mod from
  state it keeps, with one click listener on its row.
- **Text inputs stop keyboard events from bubbling**, because `window.html`
  listens for keyboard shortcuts — single-key ones included — on the document.

### R3.1 Workspaces

Lists this machine's workspaces with the ones it synchronizes ticked, and under
each name the devices it is shared with ("Synced on: ..."). The tick box is this
device's membership of that list: saving adds or removes this device's name in
R1.2's `sync.config` note (R1.3) and leaves every other device — and every
workspace this machine does not have — exactly as it was. Saving also publishes
or withdraws this device's document for each workspace whose state changed
(R2.5), so a tick takes effect without switching workspaces. Console entry
point: `VivaSync.settings()`.

### R3.2 Exceptions

Edits the `exceptions` list of R1.4: one text input per entry, editable in
place; **Add** appends an empty row, **✕** removes a row, **Save** replaces the
list in `sync.config` (re-reading the note first, touching no other key) and
re-arms the write of every opened workspace. The dialog re-reads the note when
it opens, since a peer's edit may have been delivered while this device was not
running. Console entry point: `VivaSync.exceptions()`; the list is also in
`VivaSync.config().exceptions`.

### R3.3 Settings

One field per tunable of R1.5 (except `logMax` / `logLineMax`, which change
nothing a user can see in their tabs), each with a tooltip saying what it does
and which way to move it for which symptom, plus the **Debug** switch
(`showDebug`). Saving writes the `settings` object of `sync.config`:

- a value equal to the code default is **removed** from the note rather than
  written, so the note stays a list of what this install changed and a later
  change to a default reaches every device that never overrode it;
- an empty field means the default;
- a value that is not a number keeps the dialog open with a message naming the
  field, and nothing is written;
- keys the dialog does not show are carried through; a top-level `urlSettleMs`
  is folded into the object and removed from the top level, or it would come
  back into force the moment the object stopped naming it.

Console entry point: `VivaSync.tuning()`.

### R3.4 Debug

Renders the diagnostics for users who will not open `vivaldi://inspect`:

- **status rows** — engine (name, version, device, uptime, KV backend, tuned
  settings), notes transport, live config (synced workspaces, who shares each,
  the exceptions), active workspace (with the provenance of the state held,
  R2.2), materialized workspaces (R2.4), URL churn, reachable windows, and one
  row per document in the folder, each with its `origin` and `version`. Each
  section is independently guarded so the window still renders when part of the
  mod is broken — which is when it is opened. The rows are collapsed behind a
  counts line (`N report row(s): p pass, f fail, …`) that toggles them, so the
  buttons and the log stay above the fold. Available as data via
  `VivaSync.status()`.
- **actions** — Refresh, Write now, Reconcile active, Reload config, Clear
  churn, Copy report (every row, shown or not), Copy log.
- **log tail** — the last lines of a ring buffer (`logMax` lines) fed by every
  line the mod logs, including its `debug`-level non-decisions ("defer write
  of", "defer pull for", "already up to date").

The log tail refreshes on a timer that exists **only while the window is open**;
status rows are recomputed on open and on Refresh, because they call the notes
API. This is the sole exception to R4.

The menu offers Debug only when `showDebug` is on, but `VivaSync.debug()` always
works, and a mod whose notes transport failed to come up offers the item
regardless — a dead transport is exactly when this window is wanted, and the
note that carries `showDebug` is unreadable in that state. For the same reason
the button is mounted even on that degraded startup path.

### R3.5 About

Mod name, `VERSION`, and the device / notes folder / live config note.

`VERSION` is a single constant at the top of `vivasync-mod.js` — there is no build
step — and is surfaced identically by the About dialog, the Debug window, the
button tooltip, the startup log line, `VivaSync.version` and
`VivaSync.introspect()`.

## R4. No periodic work

The mod does no polling. Writes are driven by `chrome.tabs` events; workspace
switches are detected from `chrome.tabs.onActivated` / `onRemoved` and
`chrome.windows.onFocusChanged` (a switch always changes the active tab, and the
active tab defines the active workspace); pulls are driven by notes change
events. With the browser idle the mod costs nothing.

The single remaining timer re-asserts the status-bar button every 3s; it is one
`getElementById` per window and returns immediately when the button is present.
The only other timer is the Debug window's log tail (R3.4), which exists only
while that window is open.

## Architecture (informative)

- **Mod** (`vivasync-mod.js`) injected into Vivaldi's `main.html` core document —
  the only context with `chrome.*` and Vivaldi workspace/tab state. (`window.html`
  is a per-window render shell with no JS context of its own, used only as a
  mount point for the UI.)
- It is the **only** component. Documents are read and written with
  `vivaldi.notes`, the workspace list with `vivaldi.prefs`, the device name with
  `vivaldi.sync`, stacks and ordering with `vivaldi.tabsPrivate`. Every
  version-sensitive Vivaldi internal goes through one object, `ADAPTER`.
- Vivaldi workspaces and tab stacks are **not exposed to the Chromium extension
  API**, which is why this is a mod rather than an extension.

## Operational notes

- The `main.html` injection is reverted by Vivaldi updates; re-run the
  installer after updating Vivaldi.
- Workspaces not listed in `sync.config` with this device among their `peers`
  are never written or modified.
- Nothing crosses devices unless Vivaldi Sync is enabled **with notes included**.
- Documents are pre-filtered by title prefix `<workspace_name>-`, but a title is
  ambiguous — both halves of `<workspace>-<device>.json` may contain `-`, so
  `Shared-2-workshop.json` is a well-formed name for workspace `Shared-2` on
  device `workshop` and for workspace `Shared` on a device called `2-workshop`.
  Ownership is therefore decided by the payload's own `workspace` field; a
  document without it — or without `origin`, `version` or `items`
  (R2.1.1.3) — is not a sync document and is never matched by title. Name
  pairs like `Work` / `Work-Old` are safe. (See F12.)
- No timing decides synchronization. The delays that remain are debounces
  (write, workspace switch, remote change), the per-note write throttle, and
  the waits for a tab to finish loading (30s bound), a URL to hold still and a
  grouping to land in `vivExtData`; none of them orders one device's state
  against another's.

## Approaches that failed

Each entry records a design or implementation decision that was tried, why it
did not work, and what replaced it. They are kept because several of them look
like simplifications of the current design, and would reintroduce the failure.
Code comments refer to them by number.

### Architecture

- **F0a. Files written by a native messaging host.** The first design wrote the
  sync documents as JSON files through a Python native messaging host, relayed
  by a companion extension (the UI context cannot call
  `chrome.runtime.connectNative`: Vivaldi's internal extension lacks the
  `nativeMessaging` permission), with the user replicating the folder through
  Syncthing, Dropbox or Nextcloud. Three components to install and keep in
  step, a third-party sync tool, and a device name taken from the OS hostname.
  *Replaced by* documents as notes, carried by Vivaldi Sync (R0); the device
  name is the Vivaldi Sync session name (R2.1), since no API exposes the
  hostname to the UI context and the session name is more meaningful anyway.
- **F0b. Reading Vivaldi's own synced-tabs data.** A second design read
  `chrome.sessions.getDevices()` instead of publishing anything. It was
  read-only by construction: it could never publish a state Vivaldi did not
  already publish (no workspaces, no stacks). *Replaced by* R0.
- **F0c. Injecting the mod into `window.html`.** `window.html` is a per-window
  render shell; the mod has to run in `main.html`, the one document that loads
  `bundle.js` and owns `chrome.*` and workspace state. The installers remove an
  injection from `window.html` if they find one.
- **F0d. The workspace list from window extension data.** Vivaldi 8.0 does not
  expose it there. *Replaced by* the `vivaldi.workspaces.list` pref (R2.3).
- **F0e. A per-device configuration override** (`sync.config-<device>`, and an
  earlier shape where `workspaces` was a plain array of names). It could record
  one device's opinion but not communicate it: no machine could see, or agree
  on, who a workspace was shared with. *Replaced by* the shared `peers` lists
  (R1.3). Neither shape is read.
- **F0f. Polling.** A 2-second interval re-queried every tab, rebuilt every
  snapshot and re-armed a write, costing CPU with the browser idle. *Replaced
  by* event-driven writes, switches and pulls (R4).

### Ordering and echoes

- **F1. Ordering and recognising documents by timestamp.** Documents were once
  ordered by their wall-clock `timestamp`, and a device recognised its own
  state coming back through a peer by the timestamp it had stamped (a device
  adopting a peer's state republished it under the origin's stamp). That only
  works while the peer's rendering is signature-identical to ours — and it is
  not, as soon as a tab opened next to its opener here is appended at the end
  there. The peer's live state then no longer matched what it had adopted, it
  re-stamped our state with its own clock, and a tab opened here in the
  meantime was closed by our own earlier state arriving back without it ("a
  change comes straight back as if made on the other machine, and a new tab
  disappears on the machine that opened it"). *Replaced by* provenance —
  `origin` + Lamport `version` (R2.1.1.4) and the three rules of R2.2.4.
  Documents without provenance are not read (R2.1.1.3).
- **F2. A forced write after every apply.** `reconcile` ended with a forced
  write, so each apply published a newer document even when nothing had
  changed; with both devices pulling on note events they ping-ponged for ever
  at ~15-20% CPU each. *Replaced by* the signature-gated write (R2.2.3).
- **F3. Queuing a write behind the note throttle.** The throttle sleeps inside
  the note write, after the snapshot was taken, so a queued write published a
  state up to five seconds old under a fresh timestamp and the devices traded a
  state neither was in. *Replaced by* re-arming and re-snapshotting (R2.2.4,
  invariant 3).
- **F4. Pulling over unpublished local changes.** Applying a remote
  whole-document while a tab the user just opened was in no document closed
  that tab under the cursor. The note-event path was guarded first; the
  workspace-switch path was not, and a tab opened just before switching away
  and back was closed on the way in. A deferred pull also waited for the next
  unrelated note event, leaving a device one document behind indefinitely.
  *Replaced by* deferral on both paths and a retry when the write lands
  (R2.2.4).
- **F5. Applying a newer remote whole-document on open.** Tabs moved into a
  synced workspace ("Move to workspace", which switches into it) while a
  peer's newer state was pending were closed by that state, since no document
  listed them. Two attempts at holding the local write failed before the
  current rule: the first keyed the hold on the browser's **active
  workspace**, but the move's write fires before the switch is handled, so the
  pre-merge state went out numbered like the peer's and the peer's change was
  lost; the second keyed it on the **switch having been handled**, and in the
  field the switch was never observed at all (tabs outside every workspace did
  not count as a place, so coming back from them was not a switch), so the
  move again went out at the peer's version and the peer's new tab was lost on
  both machines. *Replaced by* the merge on open and the provenance-only rule
  that no fresh origination is published over a peer state numbered above the
  held one (R2.2); tabs outside every workspace now reset the active-workspace
  tracking (R2.2.5).

### Reconcile mechanics

- **F6. Deleting before creating.** Emptying the workspace, even for an
  instant, made Vivaldi activate a neighbouring workspace's tab; the active
  workspace (derived from the active tab) flipped mid-reconcile and the
  remaining creates landed in the wrong workspace — a tab from an unsynced
  workspace appeared in the synced one. *Replaced by* create-before-delete and
  the active-workspace precondition (R2.2.5).
- **F7. Moving a tab between containers by closing and re-opening it.** A
  loading tab is never closed, so the close silently did nothing while the
  re-open went ahead, leaving the same URL at top level **and** in the stack
  (a leftover tab plus the intact stack). *Replaced by* the adoption pool
  (R2.2.2).
- **F8. Publishing as soon as the grouping calls returned.** Grouping lands in
  `vivExtData` asynchronously; the snapshot described plain tabs, and a
  three-tab stack regrouped and ungrouped between two devices for ever.
  *Replaced by* waiting every grouping out and publishing nothing when one does
  not settle (R2.2.2).
- **F9. An invented tweak name.** `addToStack` passed `group-follows-target`,
  which does not exist; `tabsPrivate.move` validates its vocabulary and threw
  on every call, so adding a tab to an existing stack never worked — a tab
  opened inside a stack arrived on the peer as a plain tab and then left the
  stack on the machine that made it. The test double accepted any tweak, so
  the suite stayed green. *Replaced by* the tweak sets `bundle.js` itself
  passes, a verified join with a `createStack` rebuild (R2.2.2), and a harness
  that rejects unknown tweaks. The same lesson applies to every double: a
  `tabs.remove` stub that ignored array arguments once let every delete
  silently do nothing under a green suite, which is why
  `test/00-harness-selftest.js` exists.
- **F10. `pinned` in the signature before provenance, then out of it.** A pin
  the browser declined became an endless swap: the refused device's snapshot
  differed from the document it had adopted, so it published the unpinned view
  as its own news, the peer applied it, was refused the other way, and
  published back. The flag was taken out of the signature and replaced by a
  forced write armed by the user's own pin event — and meanwhile `pinned` was
  honoured only by `createTab`, so pinning an existing tab on one device did
  nothing on the other. *Replaced by* the pin phase (R2.2.2a) with `pinned`
  back in the signature, made safe by the acknowledgement rule (R2.2.4).
- **F11. Assuming the pinned strip keeps a newborn out of stacks.** Vivaldi
  drops a pinned newborn into the active tab's stack like any other; a pinned
  tab arriving while the user sat in a stack became that stack's first member,
  was published as a member, and the peer moved its own pinned tab into the
  stack too. The test double had modelled the assumption, so the suite was
  green over it. *Replaced by* mixed-group partitioning (R2.1.1.2), the
  post-create check and the pin phase's repair (R2.2.2a). Relatedly, the
  protocol once had no notion of a pinned **stack**, so a stack the user pinned
  arrived on the peers as loose pinned tabs; a stack now carries its own
  `pinned`.
- **F12. Matching documents to workspaces by title prefix.** `Shared-2-workshop.json`
  was adopted as a document of `Shared`; newest-wins replaced every tab in
  `Shared` with `Shared-2`'s and published it back over the original, on both
  machines. *Replaced by* ownership from the payload's `workspace` field
  (Operational notes).

### Tab order

- **F13. Order sync by anchored placement** (in an earlier prototype engine,
  not this code base). It synchronized order first with per-tab fractional
  positions, then with a single sequence under one clock, and removed both:
  placing tabs at anchored strip positions kept ending in stacks merging or
  absorbing a neighbour, it needed a 90-second attribution window and a clash
  memory to decide whether the browser or the user had regrouped a tab, and
  its reorder passed a `preserve-group` tweak the API rejects (so how much of
  its absorption report was the primitive is unknown). *Kept from it*: a stack
  moves as one run, targets are boundaries between units, the strip is re-read
  before each move, the reorder is minimal (R2.2.2b). *Not needed*: the
  attribution machinery — the acknowledgement rule makes a differing rendering
  harmless. The same prototype confirmed the create-time `pinned` +
  `vivExtData.workspaceId` path used for pinned newborns (R2.2.2a).
- **F14. Not synchronizing order, with an order-insensitive signature.** The
  sequence was carried but reproduced only on a clean restore; the signature
  ignored order so that the resulting differences would not look like local
  news for ever. Reorders did not propagate, and a tab opened from a link sat
  next to its opener on one machine and at the end on the other. Stack member
  order stayed sorted in the signature for a while longer, with the same
  effect inside stacks. *Replaced by* the order phase and an order-sensitive
  signature (R2.2.2b, R2.2.4).
- **F15. An order phase that matched units by address.** It skipped `volatile`
  (loading) units, which includes every tab the apply had just opened, so a tab
  a peer opened from a link was created at the end of the strip and left
  there. The test double created tabs `complete`, so the suite was green over
  it. *Replaced by* the order plan built by the create phase (R2.2.2b), and a
  double whose newborns are `loading`.

### Addresses and loading

- **F16. Treating a hibernated tab as in flight.** Testing
  `status !== "complete"` made every `unloaded` tab undeletable, so deletions
  stopped crossing between devices, and made every publish wait out its whole
  load hold. The load hold was also counted in polls rather than wall time, so
  a slow page was published before it committed. *Replaced by*
  `status === "loading"` and a 30s wall-time bound (R2.1).
- **F17. One note per title, by assumption.** An empty `content` from
  `getTree()` was taken as "the note is missing", and the configuration
  reader seeded a second `sync.config`; a note replaced by a sync merge made
  the cached id's update fail, and the failure path recreated the note — so
  copies multiplied and readers picked one at random. *Replaced by* R0.1–R0.2.
- **F18. Other smaller lessons**, each now a rule stated in its requirement:
  URLs compared raw (R2.1, URL identity); empty new tabs published (R2.1);
  publishing on load completion alone, which leaked half-typed addresses
  (R2.1, settled address); a bulk close abandoned on one stale id (R2.2.1);
  a loading tab protected even when this device opened it from a document
  (R2.2.1); a wait after `createStack` that did not name the group it asked for
  and so renamed the user's stack (R2.2.2); a reconcile that returned without
  writing when there was nothing to pull, which left a newly ticked workspace
  unpublished (R2.2); ticking a workspace doing nothing until it was opened
  (R2.5); a device name built by `String()`-ing a pref wrapper object
  (R2.3); a native checkbox in the dialogs, invisible under Vivaldi's CSS
  (R3).
