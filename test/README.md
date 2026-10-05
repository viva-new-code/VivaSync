# Tests

Two layers, with very different trust levels:

- **The offline suite** (`00`–`18`) replaces the browser with in-memory doubles
  and drives `mod/vivasync-mod.js` in plain Node. Fast, deterministic, runs anywhere.
  It proves the *logic* is right — it cannot prove Vivaldi behaves as modelled.
- **`cdp.js`** talks to a real running Vivaldi. Slower and manual, but it is the
  only thing that validates the assumptions the doubles are built on.

Trust the offline suite for regressions; trust `cdp.js` for "does this Vivaldi
build still work this way".

Requirement numbers (R…) and failure entries (F…) below refer to
[`docs/SPEC.md`](../docs/SPEC.md); invariant numbers refer to "Reconcile
invariants" in [`AGENTS.md`](../AGENTS.md).

## Running them

No dependencies, no `npm install`. Node ≥ 18 (`cdp.js` needs ≥ 22 for the
built-in `WebSocket`).

```bash
./test/run.sh          # everything
./test/run.sh 03       # just the regression suite
node test/03-regressions.js    # a single file, full output
```

Exit code is the number of failing files, so it drops straight into CI or a
pre-install check. Expect ~3 minutes total — several files deliberately sleep
through the 5-second per-note write throttle. Anything that reads a note back
after triggering a write has to **poll for it**, not sleep a fixed amount: a
write armed inside the throttle window is re-armed rather than queued
(invariant 3), so it lands a throttle-length later than the call that asked for
it.

Each file runs in its **own node process** on purpose: the mod is an IIFE that
guards on `window.__vivasyncLoaded` and installs global state, so it can only be
loaded once per process. That is also why several scenarios have a file of
their own rather than a section in another: a second `createEnv()` in the same
process would boot against the first env's globals and prove nothing.

## What each file covers

### `00-harness-selftest.js` — is the fake browser still honest?

The most important file, and the least obvious. The doubles in `harness.js` are
a *model* of Vivaldi, and **a wrong model produces green tests over a broken
path**. This is not hypothetical: a `tabs.remove` stub that ignored array
arguments made every delete in the reconcile engine silently do nothing while
the whole suite reported success, and a `tabsPrivate.move` stub that accepted
any tweak name hid a join that threw on every call in the browser (SPEC F9).

So this file tests the harness, not the mod:

- `tabs.remove([a, b])` really removes both (the engine always bulk-removes) —
  and **rejects the whole call** with `No such tab - N` if any id is stale,
  rather than skipping it.
- A created tab joins the **active** workspace — the assumption the entire
  create path rests on.
- `notes.create` fires `onCreated` *before* its callback returns, so the mod
  cannot assume it knows its own new note's id when the event arrives.
- `prefs.get` can return a `{defaultValue: …}` wrapper instead of a value.
- The promise form of `chrome.*` works.
- The notes tree contains a `type: "trash"` node.
- `tabs.update` **applies `pinned`** (and announces it on `onUpdated`, rejects a
  stale id, and ignores `vivExtData`, which the real UI context refuses too),
  and `tabs.create` honours `pinned` and a create-time `vivExtData.workspaceId`
  — and drops a pinned newborn into the active tab's stack exactly like an
  unpinned one (a double that kept pinned newborns out of stacks would pass the
  suite over SPEC F11). `pinned` is the one attribute the engine changes on a
  tab in place, so a pin arriving from a peer could otherwise be "applied" in a
  green test and do nothing whatever in a browser. `env.pin(id[, pinned])` is
  the same flip made by the user; `env.setPinSupport(false)` models a build
  that ignores the flag in both calls. **Pinning leaves a tab's group alone**,
  which is what makes a pinned *stack* expressible at all (Vivaldi pins a stack
  as a unit and it stays a stack); `env.pinGroup(gid[, pinned])` is the user's
  own pin-the-whole-stack gesture, and `env.breakGroupOnPin()` models the build
  where pinning a member drops it out of the group instead, which is the case
  the engine has to read back and repair.
- **A stack's name and colour are independent properties**, each set by its own
  `setGroupProperties` call (`groupTitle` / `groupColor`, mirroring Vivaldi's
  own `setFixedStackTitle` / `setStackColor`) and stored per member in
  `vivExtData`. The double changes **only the property the call names**: one
  that overwrote both would hide the engine wiping a stack's colour every time
  it re-asserted the name. Joining a stack inherits both; leaving one, or
  having the group dissolve under you, loses both. `env.setStackColor(gid[,
  color])` is the user's own Tab Stack > Color gesture (and `null` clears it),
  announced as the `vivExtData` update the engine hears a rename through.
- **A created tab is `loading`** and reaches `complete` on its own
  (`loadLatencyMs`, 60ms; `env.setLoadLatency(ms)`, 0 for instant). Modelling
  newborns as complete would let an order phase that skipped every tab it had
  just created pass the suite (SPEC F15) — the engine treats a loading tab as
  volatile, which means never *close* it, not never move it. The completion
  fires `onUpdated` with `status` only, never a `url`, so it does not restart a
  tab's URL quiet period.
- `tabsPrivate.move` with a **numeric target** is an **index move** (bundle.js's
  own `moveToIndex`): post-removal frame like `chrome.tabs.move`, movers keep
  their relative order and their group, the workspace named in the call is
  kept, `chrome.tabs.onMoved` fires once per moved tab, and a `move` op is
  logged. A tab target needs the `target-is-tab` tweak; a numeric target that
  happens to equal a tab id is still an index. `env.moveTab(id, index)` /
  `env.moveTabs(ids, index)` are the user dragging. Whether a real build absorbs
  a top-level tab that lands at a stack's edge is NOT modelled (unverified;
  `VivaSync.diagOrder()`).
- `tabsPrivate.move` **un-pins a tab it repositions** (logged as an
  `unpin-by-move` op). Modelled pessimistically and listed under `unverified` in
  the fixture: the pinned strip is at the front of the tab bar and
  `pinToWorkspace` parks a tab at the end of a workspace's region. The engine
  pins only after every move and re-reads the live state first, so it is
  correct either way; `VivaSync.diagPin()` settles it against a real build.
- `tabs.onUpdated` is **delivered**, with the new url and the tab. It is what
  starts a tab's URL quiet period (`SETTINGS.urlSettleMs`), so with the event
  thrown away every test of the settle window would pass without the window
  existing at all — the same hazard as the `tabs.remove` stub. `env.navigate(id,
  url[, status])` drives it — a tab changing address the way a site rewriting
  its own URL does, optionally held mid-navigation as `"loading"`.
- `tabs.onActivated` is **delivered**, so a workspace switch — the path a user
  performs to start syncing anything at all — is reachable from the suite.
  `env.switchWorkspace(wsId)` fires it.

It also pins the **tab-stack model**. Only the last of these has been confirmed
against a real build; the rest are still listed under `unverified` in the
fixture, and `VivaSync.diagMakeStack()` / `VivaSync.diagAddToStack()` /
`VivaSync.diagDetach()` are what settle them:

- `tabsPrivate.move({create-new-group})` returns a backend-assigned group id and
  really moves every listed tab into it; `setGroupProperties` names the stack.
- **A new tab joins the ACTIVE TAB's stack**, not merely the active workspace.
  The whole phase-1/phase-2 split in `applyDesired` exists because of this.
- **A stack that drops below two members is dissolved** and the survivor becomes
  an ordinary tab.
- **Grouping does not land synchronously**: `move()` answers with the group id,
  the tabs' `vivExtData` catches up ~a frame later. The double delays it on
  purpose (`opts.groupLatencyMs`, default 120ms) — applying it synchronously
  would silently delete the only coverage of the regroup/ungroup loop.
- **Closing the active tab activates another one.** The browser is never left
  without an active tab, and the mod derives the active *workspace* from it.
- **`tabsPrivate.move` rejects a tweak name it does not know**, it does not
  ignore it. This is the single most valuable thing the double models (SPEC
  F9). `VALID_TWEAKS` in `harness.js` is the list from the real `TypeError`; a
  new tweak has to be added there *and* to the fixture.
- `tabsPrivate.move({"do-not-reparent","on","create-group"})` **targeting the
  group id** adds a tab to that stack, inheriting its name — Vivaldi's own
  drop-a-tab-onto-a-stack call. `tweaks: ["untile","ungroup"]` takes one back
  out. `env.setGroupingSupport()` turns the join (and `create-new-group`) off to
  model a build that ignores it — as a plain **no-op**, never an accidental
  ungroup, which is what makes the engine's `createStack` fallback meaningful.
- A move that is *not* told `do-not-reparent` takes a tab back out of its stack.
  `diagDetach` confirms a tab does leave its stack on Vivaldi 8.1, but not
  whether it is this move or the `createStack([id])` fallback doing it, so the
  double models the move.

It then diffs the stub surface against `fixtures/vivaldi-api.json`, a snapshot
captured from a real browser, so an API the mod uses disappearing in a Vivaldi
update fails loudly rather than passing vacuously.

Section 3 pins the **DOM double** the UI suites run against — `contains()` for
outside-click detection, document capture listeners running before the target's
own, `querySelector` matching a class at depth for `findBar()`, `remove()`
detaching from the tree — and that a raw `<input type=checkbox>` does **not**
flip on a click, because in Vivaldi's `window.html` it does not either.

### `01-end-to-end.js` — the happy path

Cold start → creates the `VivaSync` folder and seeds `sync.config` → configure a
workspace → snapshot it (checking tabs and stacks interleave in tab-bar order) →
publish `<workspace>-<device>.json` with the payload
`{workspace, items, origin, version, timestamp}` → a peer publishes a different
layout → converge to it.

### `02-transport.js` — the notes layer and the configuration

- **Trash is invisible.** Deleting the folder in the Notes panel moves it to
  trash rather than removing it; adopting the trashed copy would resurrect dead
  config (R0.3).
- **Per-device membership.** A workspace whose `peers` name this device is
  synced here; one that names only other devices is not, and its entry is left
  alone rather than rewritten.
- **`autoPull`** honoured from the config note and defaulting back on.
- **Event filtering.** Our own note changing triggers zero reconciles; an
  unrelated note elsewhere in the tree triggers zero reconciles; a peer's
  document pulls with no workspace switch.

### `03-regressions.js` — the reconcile invariants

Each case is a failure mode seen on two real devices syncing a shared
workspace, and none is caught by the happy path — read the comments in the file
before touching `reconcile()` or `applyDesired()`.

| | Symptom it prevents | Rule enforced |
|---|---|---|
| **A** | Both machines pegged at ~15-20% CPU indefinitely | Applying a remote we already match must write **nothing**. `reconcile()` ends with `writeChanged(false)`; a forced write makes two devices republish at each other for ever (invariant 1, SPEC F2). |
| **B** | A newly opened tab vanishing a second later | Reconcile is newest-wins whole-document, so anything absent from the remote is closed — and a brand-new tab is absent from every peer's document. The pull is deferred while local changes are unpublished (invariant 4). |
| **C** | A tab from the non-synced `Local` workspace appearing inside `Shared` | `applyDesired` refuses to run on a non-active workspace, and `reconcile()` bails **before** marking it opened or moving `current` (the held provenance) (invariant 5). |
| **D** | (the cause of C) | Creates happen before deletes, so the workspace is never momentarily empty. If it empties, Vivaldi activates a neighbouring workspace's tab, and since the active workspace is derived from the active tab, the mod's idea of "active" silently flips mid-reconcile (invariant 6, SPEC F6). |
| **E** | Two spellings of the same tab replacing each other on both machines without end, after typing into a site that rewrites its own URL (Google Translate) | Only the device that **originated** a state publishes it under its own name. `reconcile` records `ackPending` (before the apply, since the apply's own tab events schedule the write) and `writeChanged` publishes the adopted state as an acknowledgement carrying the origin's `origin`/`version`/`timestamp`, so an adopted state can never out-rank the original (invariant 2). |
| **F** | (the same swap, entered from the write side) | A write held back by the 5s note throttle publishes the state it **lands** with, not the state it was armed with. `writeChanged` re-arms via `scheduleWrite` instead of handing a snapshot to a call that will sleep on it and then stamp it with a fresh clock reading (invariant 3, SPEC F3). |

### `04-url-churn.js` — the tab that blinks open and closed

A *specific* tab cycling open/closed on both machines, with sustained CPU (seen
with `https://www.infoworld.com`). Tab identity is the URL string, so a URL that
does not survive the round-trip can never match — A publishes one spelling, B
opens it, the site redirects, B publishes the new spelling, A no longer
recognises its own tab.

Three defences, one per section of the file:

1. **`normUrl()`** — `www.`, a trailing slash, host case and default ports stop
   being differences. Query and fragment are deliberately **kept**: collapsing
   them would delete tabs the user considers distinct (two views of one SPA),
   and `1c`/`1d` pin that down.
2. **Loading tabs are untouchable** — while a tab navigates its URL is
   transient, so it is never deleted for being absent from the remote, and never
   published (which would hand peers a URL that vanishes a second later). §2d
   and §2e guard the other edge of that rule: a **hibernated** tab
   (`status: "unloaded"`) is *not* in flight. Vivaldi discards background tabs
   and restores a session lazily, so after a restart most of a workspace is
   `unloaded` with a perfectly good URL — treated as in-flight, no hibernated
   tab could ever be closed and **deletions would stop propagating between
   devices entirely** (SPEC F16). §2e watches the log rather than the note on
   purpose: the deferral budget eventually gives up and publishes anyway, so a
   wrong predicate still lands the write, just slowly.
3. **Circuit breaker** — a URL that genuinely cannot round-trip is abandoned
   after `OPEN_ATTEMPT_CAP` (3) attempts rather than blinking for ever. `3a`
   drives the infoworld scenario for 8 rounds and asserts at most 3 opens.

§4 is the same failure with the URL that never had a chance: an **empty new
tab**. Its address is a start page, spelled differently per build and per
device, and it becomes something else the moment the user finishes typing — so
it is never published and never deleted. Without that, the peer's document
closes the tab the user is typing into (§4b), the URL they then type is never
published at all (§4c), and the two machines trade an empty/loaded tab back and
forth. The breaker cannot help here: the trigger is the human pause before
typing, which is unbounded.

§5 is the case that "wait until the tab finishes loading" does **not** cover,
and the reason the settle window exists at all. A site that drives its URL from
an input box — Google Translate, search-as-you-type — *completes* a navigation
on every intermediate value, so typing `well` loads `?text=w`, then `?text=we`,
then `?text=well`. Each is a fully loaded, perfectly well-formed URL that
`isLoadingTab` has no reason to hold back, and published, the peer would open
each prefix in turn and publish it back: the user would watch their own tab
reload through their own typing history. What separates the value the user
stopped on from the ones they typed through is a **quiet period**, not the load
state — §5 asserts no intermediate is ever published, §5b that the settled
value is, and §5d that a URL which never settles is published anyway once
`SETTINGS.maxSettleHoldMs` is up (a page rewriting its URL on a timer must delay
syncing, not stop it).

§5 depends on the harness firing `chrome.tabs.onUpdated` — see `env.navigate()`
and the self-test note above. Its setup publishes a settled URL and then waits
the note throttle out *before* typing, because otherwise the whole section
passes vacuously: nothing is published during it either way, and the
assertions cannot tell the quiet period from the 5s floor between two writes of
the same note.

§6 pins the other half of rule 2: "never close a loading tab" protects a tab the
**user** opened, not one the engine opened from a document. A newer document
closes a sync-born tab it dropped even while it loads (`env.setLoadLatency(4000)`
holds it there), while a tab the user opened mid-navigation is still
untouchable. Without that, a second document arriving inside the first apply's
load window would leave every tab of the first one open and the two devices
would diverge silently — the acknowledgement would republish them under the
peer's own provenance, which the peer never applies.

The breaker is the guarantee: normalisation handles the common cases, but no
amount of it can fix a site that lands somewhere other than where it was opened.
`VivaSync.diagChurn()` names the offending URL; `VivaSync.clearChurn()` resets it.

### `05-ui.js` — the toolbar button, its menu and the dialogs

One of the suites that drive the DOM (with `09`, `10` and `17`). The button, its popup
menu and the Workspaces / Exceptions / Debug / About dialogs are built with the
**visible** window document's `createElement` — `main.html` paints nothing — so
this file runs against the DOM double that `createEnv({ ui: true })` installs,
and drives the UI the way a user does: click the button, click a menu item,
read the dialog.

It covers:

- **Versioning.** `VERSION` is declared once in `mod/vivasync-mod.js` and there is no
  build step. The suite reads it back out of the source with a regex, then
  asserts `VivaSync.version`, `introspect().version`, the button tooltip, the About
  dialog, the Debug header and the startup log line all agree. A version copied
  by hand into a second place fails here.
- **The button opens a MENU**, not a dialog — plus the dismissal rules: the
  opening click must *not* close the menu (the listeners arm on the next tick),
  while a later outside click and Escape must.
- **The Debug window's timer does not outlive it.** The log tail polls on an
  interval; closing the window has to clear it, or the mod acquires exactly the
  kind of permanent timer it is built to avoid. Asserted by handle count.
- **The Debug report rows are a disclosure**, collapsed by default behind the
  counts line; a Refresh repaints them without folding them back up, and
  `Copy report` copies every row either way.
- **The menu lists four items, not five.** Debug is gated on `showDebug` (off by
  default); the suite ticks it through the config note before driving the Debug
  window, and asserts it appears between Settings and About.
- **The Exceptions dialog edits the `exceptions` list.** Add appends an input
  row, ✕ removes one, Save writes the trimmed list into `sync.config` next to
  the untouched `workspaces`, and reopening shows what was saved.

Two behaviours here are engine rules, not UI quirks, and the file says so
inline: saving the picker sleeps out the remainder of `SETTINGS.minNoteWriteGapMs`
before it lands, and "Write now" publishes nothing until `reconcile()` has
marked the workspace opened this session (R2.4).

### `06-stacks.js` — tab stacks

- **§1-§3** — deleting a tab out of a stack, in both directions. A peer that
  closed one of two members publishes the survivor as a plain tab (§1) or, if
  its browser kept the group id, as a one-member stack (§2); both must converge
  to one tab and no duplicate. Closing a member here must publish the dissolved
  stack, not the old one (§3).
- **§4 — the swallow.** Vivaldi puts a new tab in the *active tab's* stack, and
  `pinToWorkspace` passes `do-not-reparent`, so a tab created for top level while
  the user sits inside a stack would be absorbed by it — and then published as
  a stack member, dragging the peer along. Every new top-level tab therefore
  goes through `ADAPTER.detachFromStack`.
- **§5 — the duplicate.** Tab identity is `(container, url)`, so moving a tab
  between containers as a close plus a re-open fails: a loading tab is never
  closed (`04-url-churn.js` §2), so the close does nothing while the re-open
  goes ahead, and the same URL exists at top level *and* in the stack (a
  leftover tab plus the intact stack). The planned deletes are an **adoption
  pool** — a wanted tab is moved into its new container and only what nothing
  claims is closed (SPEC F7).
- **§6 — the ping-pong.** Three tabs joined into a stack on one device must
  arrive as a stack on the other and stay one. Applying the peer's stack is only
  half the job: `reconcile()` publishes the moment `applyDesired` returns, and
  grouping is not yet visible in `vivExtData` at that point — a document saying
  "three plain tabs" would make the peer dismantle its own stack, for ever
  (SPEC F8). §6c asserts on `VivaSync.snapshot()` (what we would publish) rather
  than on the live tabs, because the live state is correct either way; it is
  the *document* that must be. §6e covers the same race for the stack's name.
- **§7 — the tab opened inside a stack.** Applying "this stack has gained a
  member" means `ADAPTER.addToStack`. §7b/§7c switch the join off with
  `env.setGroupingSupport({addToStack:false})` and require the new member to
  end up in the stack anyway — the engine verifies the join with `awaitStack`
  and rebuilds the whole stack with `createStack` when it did not land. Without
  that fallback §7c publishes `["stack:3", "tab:…", "tab:hooks"]`: the stack
  plus the new tab loose beside it, which tells the machine that made the stack
  to take its own apart (SPEC F9). §7e switches *every* grouping primitive off
  and requires the mod to publish **nothing at all** rather than describe the
  state it is stuck in. The active tab is pinned to a top-level one throughout
  (`env.activate`), or the test would prove nothing: with a stack member active
  the new tab joins the stack by accident and `addToStack` is never exercised.
- **§8 — one stale id must not abandon the delete list.** `chrome.tabs.remove`
  rejects the whole bulk call with `No such tab - N` when any id in it is no
  longer live, and a tab can go stale between being planned for deletion and
  being closed, because dissolving a stack is asynchronous. The engine retries
  individually. The double models the rejection (see `tabs.remove` in
  `harness.js`); §8 makes one doomed tab close itself just as the bulk call
  fires.
- **§9 — a second stack arriving while the user sits inside one.** Vivaldi drops
  every newborn into the *active tab's* stack, so both members of a new stack
  start out in the user's stack, together — and "these tabs are one stack now"
  is then already true of the wrong group. A tab created for a stack therefore
  leaves whatever stack it was dropped into (like a top-level one), and the
  wait after `createStack` names the group the call answered with; otherwise
  the user's stack is renamed to the new one's name and the new stack never
  settles.
- **§10-§14 — the stack's colour.** Vivaldi lets the user colour a tab stack,
  and it is stored beside the name in every member's `vivExtData`, so it syncs
  on the name's terms: applied in place to the stack that is already here
  (§10 — one `setGroupProperties` call, nothing created or closed), changed and
  cleared again (§11), published as a fresh origination when the user does it
  here (§12, `env.setStackColor`), and set on a stack that is new here in the
  same apply that names it (§13 — neither call erases the other). §14 is the
  rule that has no counterpart in `pinned`: a document with **no `color` key at
  all** says nothing about colour and must leave the colour alone, whereas
  `color: null` says the stack has none.

### `07-onboarding.js` — adding a third machine

A new machine receives `sync.config` before the peers' `<ws>-<device>.json`
notes — they are separate note entities, so that ordering is ordinary. In that
window the device has a synced workspace name, an empty workspace, and no idea
what the workspace is supposed to contain. Publishing an empty snapshot there is
an instruction to close the workspace, out-ranking either peer's document: both
existing machines would lose every tab. So a device that has neither held
content nor seen a peer document publishes nothing at all (`sawPeerDoc` in
`vivasync-mod.js`, R2.4). §5 checks the legitimate case still works — a
workspace the device *has* held content in and the user genuinely empties must
still propagate as empty.

§1–§3 cover the ordinary round trip in both directions, including the case where
the peer's browser leaves `group` set on the survivor of a dissolved stack: a
group of one is read and written as a plain tab, so both spellings converge.

### `08-workspace-names.js` — a SECOND synced workspace

What happens when a user adds a second workspace to a working pair, with names
where one is a prefix of the other (`Shared`, `Shared-2`):

- **§1 — opening a newly ticked workspace must publish it.** Ticking it cannot
  snapshot it (R2.4 refuses to snapshot a workspace Vivaldi has not
  materialized, and invariant 5 refuses to reconcile one that is not active).
  Switching into it lifts both — but only if `reconcile()` ends with a write
  even when there is nothing newer to pull, which for a brand-new workspace
  there never is. Nothing else publishes an unopened workspace.
- **§2/§3 — a document belongs to the workspace its payload names.** Titles are
  `<workspace>-<device>.json` and both halves may contain `-`, so
  `Shared-2-workshop.json` is equally a valid name for workspace `Shared` on a
  device called `2-workshop`. A prefix match would adopt it, and reconcile is
  newest-wins whole-document: every tab in `Shared` would be replaced by
  `Shared-2`'s tabs and then published back over the original, on both machines
  (SPEC F12). §3 keeps the filter honest in the other direction — `Shared`'s own
  peer document must still apply — and §3b that a document with no `workspace`
  key (or no provenance) is ignored outright rather than matched by title.
- **§4 — a `sync.config` edited on a peer while this device was down.** The note
  change event only arrives if we are running to hear it. The device would then
  hold a stale selection and silently never publish a workspace every other
  machine considers synced. Switching into a workspace we believe is unsynced
  re-reads the note. The test edits the note *without* the mod noticing (it is
  our own note id, so `NOTES.isOwn` suppresses the event — exactly the
  missed-event state) and asserts the precondition before relying on it.

§1 and §4 need a real workspace switch: `env.switchWorkspace(wsId)` fires
`chrome.tabs.onActivated`, and section 1 of the self-test pins the delivery.

### `09-peer-config.js` — per-device membership of a SHARED config note

It boots onto a **pre-seeded** notes tree — a `VivaSync` folder that already
holds a `sync.config` written by other devices, which is the state every
machine but the first is in.

Which devices sync a workspace is part of the one shared document
(`{"name":"Shared","peers":[...]}`), so this suite covers the two things that go
wrong when several devices edit it:

- **§1 — reading your own membership.** Only the entries naming this device are
  synced here; the rest of the document is readable in full, because the dialog
  and the Debug window have to show who each workspace is shared with.
- **§2 — the dialog shows the shared list.** Each row names the devices the
  workspace is shared with, and ticking/unticking moves *this device's* name in
  and out of that line — the tick box is a membership, not a local switch. A
  workspace that is not on this machine gets no row at all.
- **§3 — saving edits this device's membership and nothing else.** The dialog's
  scope is the workspaces that exist here; an entry for a workspace this machine
  does not have must survive a save from it untouched, or configuring the laptop
  would unsync what only the desktop has. That includes `Ghost` — a workspace
  this device *does* sync but which is missing from Vivaldi's workspace list —
  which a save must not resign it from just because no row could be drawn for
  it. An entry left with no devices is dropped.

Rows carry `data-ws="<name>"` so a test can click the row rather than guess at
the label's parent — the label is two lines (name, then "Synced on ...").

### `10-enable-publish.js` — R2.5, ticking and unticking a workspace

UI suite (`opts.ui`), three workspaces with the *inactive* ones being the
interesting ones.

Without R2.5, ticking a workspace would do nothing until the user switched into
it — correct (R2.4 + invariant 5), and indistinguishable from a dead transport.
The tick publishes, and the provenance is the only thing standing between that
and data loss, so each branch is pinned:

- **§1 — first device.** Ticking an *inactive* workspace publishes its real
  content as version 1 under this device's name and takes it off the "not yet
  published" list. No workspace switch anywhere in the section.
- **§2 — joining.** With a peer document already on the workspace, the tick
  publishes a document at **version 0, timestamp 0**, the peer's stays the
  newest, and nothing is applied while the workspace is inactive. Switching in
  then adopts the peers' content — discarding the local copy, which is the
  point — and acknowledges it under the peer's provenance. Publishing the join
  as a fresh origination instead fails five assertions here, `2e` among them:
  the newcomer's private copy wins and the shared content is gone.
- **§3 — unticking.** This device's document is removed, the peers' are not, and
  re-ticking joins at version 0 again rather than resuming. The section sleeps
  past the note-write throttle deliberately: a write still asleep in it would
  recreate the note a moment after the untick, and `unpublishOnDisable` waits
  it out.

### `11-echo.js` — our own state coming back from the peer

A peer's copy of a state *we* originated must never be applied back to us, and
it has to be recognised by its **origin**, not by what it looks like or what it
is stamped with. The peer's rendering of our state is not signature-identical
to ours as soon as a tab was opened next to its opener here and appended at the
end there; recognised by timestamp or content, our own earlier state would come
back as the peer's news and close a tab opened here in the meantime (SPEC F1).

§1–§2: a document whose origin is this device is skipped outright — re-ordered,
freshly stamped, carrying the peer's apply artefacts, whatever. §3–§4 are the
guard against over-reach: a peer *genuinely* putting itself onto that same
address is a new origination under the peer's own name and a higher version,
and applies; what we publish back is an **acknowledgement** carrying the peer's
provenance. §5: a document without provenance is not a sync document and is
ignored.

### `12-back-sync.js` — the echo rule end to end

The same rule driven through the paths a real pair of devices takes, plus the
two gaps next to it:

- **§1** — the echo arrives through the **note event** after a further change
  has already been published here. The newer tab survives and our document is
  untouched.
- **§2** — two devices originate **concurrently** (equal versions). Each
  compares the other's provenance against what it *holds*, so the tie-break
  (timestamp, then name) resolves the same way on both sides and exactly one
  yields — they converge rather than swap. The yielding side acknowledges under
  the winner's provenance.
- **§3** — a pull deferred for unpublished local changes (invariant 4) is
  **retried by the write itself** once it lands, rather than waiting for the
  next unrelated note event (which may never come).
- **§4** — the invariant 4 check covers the **workspace-switch** path too: a tab
  opened just before switching away is not closed on the way back in, is
  published under the next version, and survives the retried pull.

### `13-notes-hygiene.js` — one note per title

Two notes with one title are one document twice, and every reader would pick a
copy at random (R0, SPEC F17). Each way a copy comes into being is pinned:

- **§1** — `getTree()` reporting a note's content as `""` (it does not reliably
  populate `content`) must not read as "the note is missing": `reloadConfig`
  seeds nothing and reads the real content through `notes.get()`; a document
  write still finds and updates the existing note. Driven by
  `env.hideTreeContent(id)`.
- **§2** — a note whose id changed under the mod (a sync merge replacing the
  entity): the cached id's update fails, the title is re-resolved and the
  replacement updated. Nothing is created.
- **§3** — copies that already exist are collapsed to one on the next listing,
  keeping the copy with the highest `(version, timestamp, content)` — chosen
  from content so every device keeps the *same* copy — and that copy is the one
  applied. A duplicated `sync.config` collapses the same way.

### `14-exceptions.js` — addresses excluded from sync

The `exceptions` list of `sync.config` names address prefixes that the engine
treats like an empty new tab (see "Key identity rules" in `AGENTS.md`):

- **§0** — the list is read from the note; `config().exceptions` and the Debug
  window's `C. config` row show it.
- **§1** — an excepted tab is left out of the snapshot and of the published
  document; the tab itself is untouched.
- **§2** — matching ignores scheme, a leading `www.` and letter case, and is a
  prefix: `http://google.com/MAPS/…` and `…/mapsearch/x` are excepted by
  `www.google.com/maps`, `…/search?q=maps` is not.
- **§3** — a peer's document listing an excepted address does not open it;
  this device's excepted tabs survive a document that lacks them; an ordinary
  tab absent from the peer's document is still closed (newest-wins holds); the
  acknowledgement carries the peer's provenance and no excepted address.
- **§4** — stacks: a local stack of one tab and one excepted tab is published
  as the tab alone, and a peer's document listing that tab top-level does
  **not** pull it out of the stack (the excepted member is not counted); a
  peer's stack reduced to one member by exceptions arrives as a plain tab.
- **§5** — emptying the list from a config reload alone publishes the formerly
  excepted tabs, the whole stack included, as a fresh origination.

### `15-pinned.js` — pins arrive as pins, for a tab and for a stack

A tab that differs from the document only in its pin state is already present
by identity, so nothing but the pin phase ever touches it (R2.2.2a).

- **§1-§5** — a peer's pin and unpin are applied here **in place** (one `pin`
  op, no close-and-reopen); re-asserting the same state performs nothing; the
  copy this device publishes afterwards is the **acknowledgement** under the
  peer's origin and version (invariant 2).
- **§6** — the user pins a tab here (`env.pin`): `pinned` is in the signature,
  so it is published as a fresh origination; the peer's acknowledgement of it
  comes back under this device's origin and is not applied.
- **§7** — a pinned tab that arrives at a **new** URL is created pinned with a
  create-time workspace and never moved: no `unpin-by-move`, no `pin` op.
- **§8** — a `pinned` flag on a stack member is **hoisted**: the tab is
  top-level and pinned, no stack is built from it, and once the document lists
  it unpinned the stack is built from the same tabs (the member is unpinned
  in place — a tab put into a stack is scheduled unpinned).
- **§9-§10** — `env.setPinSupport(false)`: the pin is refused, and the device
  publishes **nothing** — the apply changed nothing here, so the pending
  acknowledgement is dropped rather than spent, and there is no fresh
  origination of "unpinned" for the peer to apply and bounce back. It still
  holds the peer's version and applies the next peer document. Without
  provenance this is an endless swap (SPEC F10); with it, `pinned` can be in
  the signature.
- **§11** — a pinned tab arrives at a new URL while this user's active tab sits
  in a stack, so the harness (like Vivaldi) drops the pinned newborn into that
  stack; the engine takes it out before grouping, re-pins it, and the
  acknowledgement lists it top-level with the stack intact (SPEC F11).
- **§12** — a workspace left with a pinned tab inside a stack
  (`env.addTab({pinned, group})`) is **published** as top-level pinned with
  the stack minus that tab, and the next apply takes the tab out of the group
  while keeping it pinned.
- **§13-§17** — **a stack is pinned as a whole.** Vivaldi pins a tab stack as a
  unit and it stays a stack, so a stack item carries its own `pinned` and its
  members repeat it. §13: a stack the peer pinned is pinned here in place — two
  `pin` ops, nothing created or closed, the same group — and the
  acknowledgement publishes a *pinned stack*, not loose pinned tabs. §14: a
  pinned stack whose tabs are new here is created **unpinned**, grouped, and
  pinned last, because a member created pinned would land in the pinned strip
  and never join the group. §15: unpinning propagates the same way. §16: the
  user pins a stack here (`env.pinGroup`) and it is published as a fresh
  origination — a pinned stack is part of the pinned strip, an ordinary one is
  part of the ordered sequence, so the signature differs. §17:
  `env.breakGroupOnPin()` models a build on which pinning a member drops it out
  of its group; the engine reads the group back and rebuilds and renames the
  stack in the same apply, rather than publishing a half-pinned group.

### `16-order.js` — tab-bar order syncs, and a reorder is never a swap

The order phase (`applyOrder`, R2.2.2b) moves **units** — an unpinned top-level
tab, or a whole stack — into the document's sequence with the fewest moves, and
the signature compares that sequence.

- **§1-§2** — a peer's order is rendered with exactly the moves it needs (one,
  for one displaced tab); the copy published afterwards is the acknowledgement
  under the peer's provenance; re-asserting the same order performs nothing.
- **§3** — the user drags a tab (`env.moveTab`): published as a fresh
  origination.
- **§4** — a new tab from the peer is created (at the end, as always) and then
  moved to where the document puts it: one create, one move.
- **§5-§6** — a new stack is built with its members in document order and
  placed; a stack moves as **one run**, both members in one `move` op.
- **§7** — not compared, never moved: reordering pinned tabs publishes
  nothing (pinning itself does — the control).
- **§8** — an empty new tab in the middle of the strip is never moved and is
  still there afterwards; the synced units around it are in order.
- **§9** — after the apply, a second reconcile moves nothing and nothing more
  is published: the rendering was acknowledged, the peer never applies its own
  origin, no swap.
- **§10** — minimality: rotating four units is one move, reversing them at most
  three.
- **§11** — a tab a peer opened from a link sits in the middle of its document;
  here it is created at the end and is still **loading**, hence `volatile`. An
  order phase that matched units by address and skipped volatile ones would
  leave it at the end for ever (SPEC F15). The tab is held loading for the whole
  apply (`env.setLoadLatency(4000)`) and must still be placed. Re-introduce the
  skip and §4 and §11 both fail.
- **§12-§14** — the order of members **inside** a stack: a peer's member order
  applied with one move and the members still in the stack, a local in-stack
  drag published as a fresh origination, and a member arriving in the middle
  of a stack rather than at its end.

### `17-settings.js` — the tunables come from the config note

Every timing the engine runs on is a key of `SETTINGS`; `SETTINGS_DEFAULTS` in
the source is only the fallback, and the `settings` object of `sync.config`
wins (R1.5). Since that note is itself synced, tuning it once tunes every
device — so the rules it is held to are worth pinning.

- **§1-§2** — with no `settings` in the note every key still has a value; a key
  the note sets is in force, a key it omits keeps its default, and what an
  install changed is reported (`config().tuned`, the Debug window's `A. engine`
  row).
- **§3-§4** — a non-number, a value below its key's floor and a misspelled key
  are all refused in favour of the default **and warned about**: a garbage
  debounce is indistinguishable from a mod that has hung, and a typo is
  otherwise completely silent. `0` is a legitimate debounce ("do not
  coalesce"), not junk.
- **§5** — `"urlSettleMs"` is also read at the top level of the note;
  `settings` wins when both name it.
- **§6** — removing the object restores every default.
- **§7-§8** — the two witnesses that the engine reads these **at the point of
  use**, which is the whole design: `logMax`/`logLineMax` resize the log ring
  buffer that the `console.*` tap — installed before there is a transport to
  read a note with — fills, and `minNoteWriteGapMs: 0` makes the very next write
  land where the default floor holds it back and re-arms it (§8c/§8d, the
  invariant-3 path). A constant captured in a local would pass everything
  before these and fail them.
- **§9** — the Workspaces dialog's Save carries the `settings` object through
  untouched, like every other key it does not own.
- **§10** — `VivaSync.urlSettle()` / `VivaSync.tunables()` are session-only: the
  next config read puts the note's values back.
- **§11-§18** — the **Settings dialog** (`VivaSync.tuning()`), which is how a
  user will actually set these. Fields are found by their `data-setting`
  attribute. It populates from the note (else the default), offers neither log
  size, and carries a tooltip per field that says which way to move it. Saving
  writes only what differs: a value put back to its default, or left empty, is
  **removed** from the note (§13, §14); a value that is not a number keeps the
  dialog open with a message naming the field and writes nothing (§15); the
  `showDebug` tick box round-trips and drives the menu item end to end (§16),
  and is asserted to *look* ticked (§11g-§11k) — a native
  `<input type=checkbox>` holds `checked` perfectly and renders as an empty
  square under Vivaldi's CSS, so the double models no checkbox behaviour at all
  and every tick box is drawn by `mkToggle`; a top-level `urlSettleMs` is
  folded into the object and dropped (§17); a hand-set key the dialog does not
  show survives a Save (§18). Every save here runs with `minNoteWriteGapMs: 0`
  in the note, or each one would sleep out the note throttle.

### `18-move-in.js` — tabs moved into a workspace with a peer change waiting

On one machine the user sits in another workspace while the other machine
changes a synced one; nothing arrives yet, by design. Then they "Move to
workspace" some tabs — or a stack — into it. Vivaldi switches in, the switch
pulls the peer's state, and a plain whole-document apply would close the moved
tabs, which no document lists. The open therefore merges (invariant 4,
`withLocalNews`; SPEC F5).

- **§1** — first open of the session: the moved tab survives, the peer's own
  addition is applied as well, and the merge is published as this device's
  next version (v7 over the peer's v6), not as an acknowledgement.
- **§2** — opened earlier in the session: a whole **stack** moved in while the
  workspace was not showing. The write that move arms is **held** (the
  inactive workspace cannot pull, and a peer state out-ranks what it holds);
  on the switch in, the stack survives with its group, name and colour and is
  not rebuilt, the peer's close and addition are applied, and a tab closed
  here while the workspace was not showing is not reopened.
- **§3** — the merge goes out as v9, the peer's state plus the stack, and
  nothing is applied back or published after it.
- **§4** — the order the real browser fires things in: the move's tab
  events arm a write that runs **before** the switch into the target is
  handled (modelled with a switch debounce longer than the write debounce).
  That write must be held too — the workspace is active in the browser but
  not yet opened by the engine — or it publishes the pre-merge state stamped
  newer than the peer's, and the peer's change is lost on both machines.
- **§5** — no switch at all: the active workspace has an unpublished local
  tab when a peer state numbered above ours arrives. The write must merge
  first and publish above the peer's version; published beside it (equal
  version, newer clock), the peer would adopt ours and lose its tab.

## Harness notes

The harness's `addTab` fires no `tabs.onCreated`, so every change in files 11,
12 and 14 is followed by an explicit `W.writeNow()` — the write the real event
would have armed. Without it a poll for "the write landed" times out on a stale
document and the assertions are about nothing.

Useful bits of `env`: `TABS`, `OPS` (ordered create/remove log, for asserting
ordering), `folder()`, `noteByTitle()`, `noteTitles()`, `urls(wsId)`, `addTab()`
(takes `group` / `stackName` / `stackColor`), `closeTab()`, `moveTab(id, index)` /
`moveTabs(ids, index)` (the user dragging; fires `onMoved`), `pin(id)`,
`pinGroup(gid[, pinned])` (the user pinning a whole stack),
`setStackColor(gid[, color])` (the user colouring one; `null` clears it),
`moveToWorkspace(ids, wsId)` (the user's "Move to workspace": only the
workspace changes, a stack stays a stack, and onUpdated announces it),
`switchWorkspace(wsId)`, `breakGroupOnPin()`, `setLoadLatency(ms)` (how long a
newborn stays `loading`; 4000 holds one across a whole apply, 0 makes it
complete at once), `stacks(wsId)` (each `{gid, name, color, urls, pinned}`),
`layout(wsId)` (a workspace as one readable line,
`"https://c/ | [AUR: https://a/, https://b/]"`, a pinned stack marked
`[*AUR: ...]` and a coloured one `[AUR#color3: ...]` — use it as the detail
argument of every stack assertion), `putPeerDoc()`, `updateNote()`,
`setConfig()` (a bare workspace name is expanded to
`{name, peers:[<device>]}` — the note has no bare-name form), `fire()` (raise a
notes event), `navigate(id, url[, status])` (a tab changing address, firing
`chrome.tabs.onUpdated` — optionally held mid-navigation as `"loading"`),
`hideTreeContent(id)`, `sleep()`, `consoleErrors`.

**If you extend a stub, extend `00-harness-selftest.js` too** — that file is the
only thing standing between you and a suite that passes over broken code.

## Testing against a real browser

```bash
vivaldi --user-data-dir="$HOME/.config/vivaldi" --remote-debugging-port=9222 \
        --debug-packed-apps --silent-debugger-extension-api &

node test/cdp.js --list                  # confirm a main.html target exists
node test/cdp.js 'VivaSync.introspect()'    # device, folder, config source, workspaces
node test/cdp.js 'VivaSync.diagNotes()'     # every sync document, age, item count
node test/cdp.js 'VivaSync.diagApis()'      # (logs in the browser console, not here)
```

`cdp.js` evaluates in the `main.html` core page — the context the mod runs in.
A normal `F12` on a web page is the wrong context and will say
`VivaSync is not defined`.

> The debug port is open to anything on localhost while the browser runs. Quit
> and relaunch Vivaldi normally when you are finished.

### Refreshing the fixture after a Vivaldi update

```bash
node test/cdp.js --capture
```

Re-reads the live API surface into `fixtures/vivaldi-api.json` and reports what
changed, calling out **removed** members specifically — those are the ones that
break the mod. Commit the updated fixture along with whatever `ADAPTER` change
the update required.

The fixture also carries a deliberate `unverified` section listing things the
code relies on that have *not* been confirmed against a real build: `parentId`
on note nodes (`NOTES.classify` treats it as a fast path and falls back to a
folder listing when absent), and several of the tab-stack behaviours above.
Keep that section honest; it is the record of where the doubles are guesses
rather than observations — and every entry names the diagnostic that would
settle it.

## Adding a test

```js
const { createEnv, ok, done } = require("./harness");

const env = createEnv({
  tabs: [{ id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true }],
  deviceName: "boxA",
});

(async () => {
  const W = await env.boot();          // loads the mod, waits out its 1.5s boot delay
  await env.setConfig({ workspaces: ["Work"] });
  await env.putPeerDoc("Work-peer.json", {
    workspace: "Work", origin: "peer", version: 5,
    timestamp: Date.now() / 1000, items: [],
  });
  await W.reconcile("Work");
  ok("label", env.urls(env.WS.WORK).length === 0, JSON.stringify(env.urls(env.WS.WORK)));
  done();                              // prints the tally, sets the exit code
})();
```

A peer document must carry `workspace`, `origin`, `version` and `items`, or the
mod ignores it (R2.1.1.3).
