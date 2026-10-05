# AGENTS.md

This file provides guidance to coding agents (Claude Code, and any other tool that reads AGENTS.md) — and to human contributors — when working with code in this repository.

## What this project is

A Vivaldi browser **mod** (not an extension) that synchronizes selected workspaces (tabs, pin state, tab stacks and tab-bar order) across devices. Every sync document — including the configuration — is a **note** in the `VivaSync` folder of Vivaldi Notes, so **Vivaldi Sync is the transport**. There is no file I/O, no native host and no companion extension: `mod/vivasync-mod.js` is the entire product.

No build step, no package manager. All source files are used directly. The offline test suite needs only Node.

`docs/SPEC.md` is the specification the mod is built to (requirements R0–R4, each with its rationale). Its last section, **Approaches that failed** (entries F0a–F18), records designs that were tried and abandoned and why. Read it before changing the engine: several obvious-looking simplifications are on that list.

## Install / uninstall

```bash
./install-linux.sh    # copy the mod into the Vivaldi resources dir, inject into main.html
./uninstall-linux.sh  # reverse it
```

One pair per platform, same logic throughout — `install-macos.sh` /
`uninstall-macos.sh` and `install-windows.ps1` / `uninstall-windows.ps1`. What
differs on macOS is where the files are and what editing them costs:
`main.html` lives inside the app bundle
(`Vivaldi.app/Contents/Frameworks/Vivaldi Framework.framework/Versions/<build>/Resources/vivaldi/`),
so an update installs a **new** version directory rather than overwriting the
old one (the uninstaller therefore cleans every version present), and the edit
invalidates Apple's code signature — both mac scripts re-sign the bundle ad-hoc
(`codesign --force --deep --sign -`, skippable with `--no-resign`) or Vivaldi
may refuse to launch. They also avoid `sed -i` and empty-array expansion, since
macOS ships BSD sed and bash 3.2.

Every installer also removes a `vivasync-mod.js` injection from `window.html`
if it finds one: the mod must never be loaded there (see "Why `main.html`").

**Both `.ps1` files are pure ASCII, deliberately.** Windows PowerShell 5.1 reads
a file with no BOM in the ANSI code page, where a UTF-8 em dash decodes to the
curly quote `”` — which PowerShell honours as a string delimiter. One em dash in
a comment therefore terminates a string further down and the script fails to
parse (`The '<' operator is reserved for future use`, then a missing `}`). Use
`-` and `"`, never the typographic ones, and keep the shell scripts' em dashes
out of these two files.

Re-run the installer after every Vivaldi update (it overwrites `main.html`).

**Nothing syncs unless Vivaldi Sync is on with notes included** — that is the transport.

## Testing the running system

The mod exposes `VivaSync` on the Vivaldi core page. Reach it via `vivaldi://inspect/#apps` → inspect the `main.html` entry (not a regular tab DevTools):

```js
VivaSync.introspect()          // device, notes folder, config source, workspaces, tab vivExtData
VivaSync.snapshot("Work")      // show what would be written for workspace "Work"
VivaSync.reconcile("Work")     // manually trigger an R2.2 reconcile
VivaSync.writeNow()            // force-write all opened synced workspaces
VivaSync.config()              // { syncedWorkspaces, workspaces (name+peers), exceptions, pending, device, opened, tuned, ... }
VivaSync.reloadConfig()        // re-read the sync.config note after editing it by hand
VivaSync.version               // mod version string (same value the About dialog shows)
VivaSync.menu()                // open the toolbar popup menu
VivaSync.settings()            // open the Workspaces dialog (the workspace picker)
VivaSync.tuning()              // open the Settings dialog (the tunables + the Debug switch)
VivaSync.exceptions()          // open the Exceptions dialog (address prefixes never synced)
VivaSync.debug()               // open the Debug window
VivaSync.about()               // open the About dialog
VivaSync.status()              // the Debug window's rows as data: [{key, status, detail}]
VivaSync.diagPin()             // what this build honours about `pinned` (create / update / move / workspace)
VivaSync.diagOrder()           // what this build does with an index move (the order phase's primitive)
VivaSync.log(n)                // last n lines of the mod's log ring buffer
VivaSync.autoPull(false)       // stop pulling on peer note changes (switch-only), this session
VivaSync.urlSettle(4000)       // how long a URL must hold still before it is published (ms), this session
VivaSync.tunables({...})       // read/set any of the tunables for this session (see "settings")
VivaSync.diagChurn()           // URLs failing to stay put — first stop for a blinking tab
VivaSync.clearChurn()          // reset those counters
```

Most of that is also reachable without DevTools — see the Debug window below.

Lower-level diagnostics (for re-confirming Vivaldi internals after a browser
update) are tagged with the marker **`VIVA-DIAG`** in `vivasync-mod.js` — grep for it
to find them all. Add the same marker to any new diagnostic command or verbose
trace log. Current ones:

- `VivaSync.diagNotes()` — transport inventory; the first thing to run when sync misbehaves.
- `VivaSync.diagApis()`, `VivaSync.diagUI()`, `VivaSync.diagWebpack()`,
  `VivaSync.diagClobber()`, `VivaSync.diagGroupSet()`.
- `VivaSync.diagMakeStack()` — confirms the stack-create primitive and the
  **colour** primitive with it: `colorSet`, `colorOnEveryMember`,
  `colorCleared`, and `nameKeptOnColor` (whether setting one of a stack's two
  properties leaves the other alone, which the engine assumes).
- `VivaSync.diagAddToStack()` — confirms the stack-*join* primitive. When it
  fails, a tab a peer opened inside a stack arrives as a plain tab and the
  stack comes apart on both machines.
- `VivaSync.diagDetach()` — confirms the stack-*leave* primitive. Run it after
  a Vivaldi update, because without it top-level tabs get swallowed by stacks.
- `VivaSync.diagOrder()` — what the build does with an INDEX move, the order
  phase's one primitive: whether a tab and a whole stack run land at the index
  asked for, keep their workspace, whether reordering a member **inside its
  own run** keeps it in the stack (`memberReorderKeptGroup`), and whether a
  top-level tab placed at a stack's edge is absorbed into it
  (`afterAbsorbed`, `beforeAbsorbed`, `runKeptGroup`). Run it after a Vivaldi
  update and whenever tabs land in the wrong place.
- `VivaSync.diagPin()` — what the build honours about `pinned`: create-time pin
  and workspace, update-time pin/unpin, whether a pinned tab keeps its
  workspace, whether a move strips the pin, and — run it from a stack member —
  whether a pinned newborn is dropped into the active tab's stack
  (`activeInStack`, `joinedStack`); then the **pinned-stack** questions, asked
  on a throwaway two-tab stack, because the engine has to pin a stack one
  member at a time while the user's gesture pins it as a unit:
  `memberPinKeptGroup`, `stackPinKeptGroup`, `stackUnpinKeptGroup`. It anchors
  on a tab that belongs to a workspace, never on the last focused window, which
  is the DevTools window while the console has focus.

Verbose per-item reconcile logs exist but are commented out
(`// VIVA-DIAG (verbose):`) — uncomment to trace a reconcile.

`diagApis`, `diagNotes` and `diagUI` are top-level functions, not just members of
the `VivaSync` object, so they are also present on the degraded `VivaSync` that `init()`
installs when the notes transport fails to come up — which is exactly when they
are needed. For the same reason `init()` mounts the toolbar button on that path
too: a dead transport is precisely when the Debug window is wanted, and it
renders the failure as its `B. transport` row.

## Version

`const VERSION` at the top of `mod/vivasync-mod.js` is the single source of truth —
there is no build step to stamp one in. Bump it there and nowhere else. It
surfaces in the About dialog, the Debug window, the button tooltip, the startup
log line, `VivaSync.version` and `VivaSync.introspect()`. `test/05-ui.js` reads it back
out of the source with a regex and asserts every one of those agrees, so a
hand-copied version elsewhere fails the suite.

Documentation and code comments describe the current behaviour only; they do
not narrate how it changed between versions (git history does that). When a
change abandons an approach for a reason worth remembering, add it to
**Approaches that failed** in `docs/SPEC.md` and state the rule that replaced
it in the requirement it belongs to.

## Tests

```bash
./test/run.sh          # whole offline suite, ~3 min, no dependencies
./test/run.sh 03       # just the reconcile regressions
node test/cdp.js 'VivaSync.diagNotes()'   # evaluate in a RUNNING browser's main.html
```

`test/README.md` explains each suite. What to know before changing the engine:

- **`test/03-regressions.js` encodes the reconcile invariants below.** If a
  change makes one of those fail, the change is wrong, not the test.
- **`test/11-echo.js` and `test/12-back-sync.js` pin invariant 2** — the
  origin rule, the acknowledgement rule, concurrent originations resolving the
  same way on both sides, the deferred-pull retry and the on-open check. The
  harness's `env.addTab` fires no `tabs.onCreated`, so a test that adds a tab
  and expects it published must call `W.writeNow()` itself.
- **`test/13-notes-hygiene.js` pins the one-note-per-title rules** of the
  transport (see "Notes transport"). `env.hideTreeContent(id)` makes the
  harness's `getTree()` return `""` for a note while `get()` keeps the content.
- **`test/14-exceptions.js` pins the exceptions rules** (see "Key identity
  rules"): an excepted tab is in no document and no signature, is never closed,
  is never opened from a peer's document, does not count as a stack member, and
  comes back into the document when the exception is dropped.
- **`test/15-pinned.js` pins the pin state** — applied in place, in both
  directions, after every move; a pinned tab at a new URL created pinned and
  never moved; a user's pin published as a fresh origination; a build that
  refuses to pin costing nothing but the pin (`env.setPinSupport(false)`);
  **a mixed group is not a stack** — a pinned newborn Vivaldi drops into the
  active tab's stack is taken back out (§11), a member a document claims is
  pinned is hoisted (§8), and a workspace left with a pinned tab inside a stack
  is published correctly and repaired on the next apply (§12); and **a stack is
  pinned as a whole** (§13-§17) — applied in place in both directions and still
  a stack, built before it is pinned when its tabs are new here, published as a
  fresh origination when the user does it (`env.pinGroup(gid)`), and rebuilt
  when pinning the members one at a time takes the group apart
  (`env.breakGroupOnPin()`). `env.pin(id)` is the user pinning a tab.
- **`test/16-order.js` pins the tab-bar order** — a peer's order applied with
  the fewest moves (a rotation is one move; re-asserting the same order is
  none), a user's drag published as a fresh origination, a new tab placed
  where the document puts it, a stack built in document order and moved as
  **one run**, the pinned strip **not** compared and never moved, a tab no
  document speaks for keeping its place, and the rendering acknowledged under
  the peer's provenance with nothing published after. §11 is a newborn that is
  still `loading`, hence volatile, which must still be placed — the reason the
  order phase runs off an order plan rather than matching units by address
  (`env.setLoadLatency`). §12-§14 are the member order inside a stack.
  `env.moveTab(id, index)` / `env.moveTabs(ids, index)` are the user dragging;
  positional `tabsPrivate.move` calls log a `move` op.
- **`test/18-move-in.js` pins the merge on open** (invariant 4) — loose tabs
  and a whole stack moved into a synced workspace that has a peer's newer state
  waiting survive the switch into it, the peer's own changes are applied too, a
  tab closed here is not reopened, the write of the inactive workspace is held
  until then, and the merge goes out as this device's next version with nothing
  applied back. §4 is the event order the real browser produces — the move's
  write firing before the switch is handled; §5 is an unpublished local change
  meeting a newer peer state with no switch at all. `env.moveToWorkspace(ids,
  wsId)` is the user's "Move to workspace".
- **`test/06-stacks.js` does the same for tab stacks**, including a stack's
  **colour** (§10-§14: applied in place, changed, cleared, published as a fresh
  origination when the user picks it, set on a new stack in the same apply that
  names it, and left alone by a document that does not mention colour).
  It is the only suite that exercises the harness's stack model. Detaching a tab from a stack is confirmed
  against a real build; the rest of that model (dissolution at one member, a new
  tab joining the active tab's stack) is still *assumption*, listed under
  `unverified` in `test/fixtures/vivaldi-api.json`. Re-confirm with
  `VivaSync.diagMakeStack()` / `VivaSync.diagAddToStack()` / `VivaSync.diagDetach()`
  after a Vivaldi update.
- **`test/08-workspace-names.js` covers a second synced workspace** — document
  ownership by payload, publishing on the switch into a newly ticked workspace,
  and re-reading a `sync.config` edited on a peer while this device was down.
- **`test/10-enable-publish.js` covers R2.5** — publishing on the tick, the
  version-0 / 1970 stamp that makes joining safe, and withdrawal on the untick.
- **`test/09-peer-config.js` covers per-device membership** — reading this
  device's own name out of the shared config, and editing only its own
  membership into it.
- **`test/00-harness-selftest.js` guards the doubles themselves.** The stubs are
  a model of Vivaldi and a wrong model gives green tests over a broken path (a
  `tabs.remove` stub that ignored array arguments, or a `tabsPrivate.move` stub
  that accepted any tweak name, each hid a real bug — SPEC.md F9). Extend that
  file whenever you extend a stub, and re-capture
  `test/fixtures/vivaldi-api.json` (`node test/cdp.js --capture`) after a
  Vivaldi update. That warning covers the **DOM double** as well
  (`createEnv({ui:true})`), which `test/05-ui.js` drives — it is a model of the
  DOM, so section 3 of the self-test pins the behaviours the UI code leans on
  (`contains`, capture-phase ordering, `querySelector` at depth).

## Architecture

One component: `mod/vivasync-mod.js`, injected into `main.html`.

### Why `main.html`, not `window.html`

`main.html` is the single Vivaldi core document that loads `bundle.js` and owns `chrome.*` + all workspace/tab state. `window.html` is a per-window render shell with no JS context of its own. The mod **must** go in `main.html`; CSS mods go in `window.html`.

The one exception is the **user-facing UI**: `main.html` is 0×0 and paints nothing, so the ⇄ button and its panels are built into the visible `window.html` documents reached via `chrome.extension.getViews()`. They are re-asserted on a 3s timer because React re-renders drop them and new windows start without them.

### The ⇄ button, its menu and the five dialogs

The button opens a **popup menu**, not a dialog directly. The menu is anchored to
the button and flips above it when the button sits in the lower half of the
window (i.e. the status bar), below it on a top toolbar. It dismisses on outside
click and Escape; those listeners are armed on the *next tick* so the click that
opened the menu cannot immediately close it again.

| Item | Opens | Entry point |
|---|---|---|
| Workspaces | workspace picker + the devices each is shared with, saved to `sync.config` (`openSettings`) | `VivaSync.settings()` |
| Exceptions | address prefixes never synchronized, saved to the `exceptions` list of `sync.config` | `VivaSync.exceptions()` |
| Settings | the tunables, saved to the `settings` object of `sync.config` (`openTuning`) | `VivaSync.tuning()` |
| Debug | status rows, action buttons, log tail — **listed only when `SETTINGS.showDebug`** | `VivaSync.debug()` |
| About | mod name, `VERSION`, device, config source | `VivaSync.about()` |

**Debug is not in the menu by default.** It is a diagnostic, `showDebug` is off,
and the Settings dialog's tick box is what puts it there; the menu is rebuilt on
every open, so ticking the box shows it at once. Two things are deliberately not
gated: `VivaSync.debug()` from the console always works (a user who cannot open
the menu is exactly who needs it), and a mod whose transport never came up
offers the item regardless (`transportDown`) — that failure is what the window
exists to show, and the note that carries `showDebug` is unreadable in precisely
that state.

All five share one overlay id (`vivasync-settings-overlay`) and the `mkDialog`
helper, so only one can be up at a time and every dismissal path (backdrop,
Escape, `close()`) runs the same teardown — which is what stops the Debug
window's log timer. The Exceptions and Settings dialogs are the ones with text
inputs; they stop `keydown`/`keyup`/`keypress` from bubbling, because Vivaldi's
`window.html` listens for keyboard shortcuts (single-key ones included) on the
document.

**No native `<input type=checkbox>` anywhere in these dialogs.** Vivaldi's
`window.html` styles them with `appearance:none` and drives them from its own
React handlers, so an injected one renders as an empty square whatever its
`checked` says, and does not toggle. Every tick box goes through `mkToggle`,
which paints a ✓ box from state the caller keeps and mirrors it onto
`box.checked` / `aria-checked`. Each tick box also gets **one** click listener,
on its row: a click on the box or the label reaches it by bubbling, and binding
the children as well would fire twice and leave the switch where it was —
which the offline suite could not catch, because the DOM double does not
bubble. The DOM double models **no** checkbox behaviour on purpose
(`00-harness-selftest.js` asserts a raw one does *not* flip), so a regression
cannot pass offline, and `test/17-settings.js` §11g-§11k assert the drawn state.

The **Settings dialog** (`openTuning`) is one field per tunable, driven by
`TUNABLE_FIELDS` — which also carries each field's tooltip, written for someone
watching their own browser ("INCREASE it if…, DECREASE it if…"), not for someone
reading this file. `logMax`/`logLineMax` are deliberately not offered: they size
the Debug window's log and change nothing a user can see in their tabs. Saving
goes through `writeSettings`, whose rules are the point of the dialog: a value
equal to the code default is **removed** from the note rather than written (so
the note stays a list of what this install changed, and a later change to a
default reaches everyone who never overrode it), an empty field means the
default, a value that is not a number keeps the dialog open with a message
naming the field, keys the dialog does not show are carried through, and a
top-level `urlSettleMs` is dropped — it would otherwise come back into force the
moment the object stopped naming that key.

The **Debug window** is the console diagnostics rendered where a user can see
them; `vivaldi://inspect` is not something to ask for in a bug report. Its rows
come from `collectStatus()` (also `VivaSync.status()`), every section independently
guarded because it has to render precisely when part of the mod is broken. Rows
are recomputed on open and on Refresh (they hit the notes API); only the log tail
follows a timer, and that timer exists **only while the window is open** — the
one deliberate exception to "no polling", asserted by `test/05-ui.js`.

The rows themselves are a **disclosure, collapsed by default**: what is always
visible is the counts line (`N report row(s): p pass, f fail, …`), which is also
the toggle (`REPORT_ID` / `REPORT_TOGGLE_ID`, click or Enter/Space). The buttons
and the log tail therefore stay above the fold — the two things a bug report
needs first — and a Refresh repaints the rows without folding them back up.
`Copy report` copies every row whether or not they are shown. `test/05-ui.js`
pins all of that.

Its log tail is fed by a ring buffer (`logBuf`, `SETTINGS.logMax` lines, 400 by default). That buffer is filled
by a **tap on `console.*`** installed at the top of the IIFE: it records only
calls whose first argument starts with the `LOG` marker and always forwards to
the original, so the mod's call sites need no special logging API and nothing
else in the Vivaldi UI is affected. **`debug` is tapped along with `log`/`info`/`warn`/
`error`** — the engine reports its *non*-decisions at that level ("defer write
of", "defer pull for", "skip reconcile of", "already up to date"), which is
exactly what a bug report needs when the mod appears to do nothing.

### Version-sensitive Vivaldi internals — all in `ADAPTER`

The `ADAPTER` object in `vivasync-mod.js` is the single seam for Vivaldi internals:

- **`tab.vivExtData`** (JSON string) → `{ workspaceId, group (stack id), fixedGroupTitle (stack name), groupColor (stack colour) }`. **Reading works; writing via `chrome.tabs.update({vivExtData})` is a NO-OP in the UI context** (verified — Vivaldi ignores it here). A **create-time** `vivExtData` passed to `chrome.tabs.create` *is* honoured.
- **Creating/modifying stacks** therefore goes through `vivaldi.tabsPrivate.move({tabIds, target, tweaks})`, naming via `vivaldi.tabsPrivate.setGroupProperties({groupExtId, groupTitle})` and **colouring via the same call with `{groupExtId, groupColor}`** — one property per call, as Vivaldi's own `setFixedStackTitle` / `setStackColor` do, so neither erases the other (`VivaSync.diagMakeStack()` → `nameKeptOnColor`). The colour is one of `color1`..`color9` or `""` for none; `ADAPTER.setStackColor` / `stackColorOf` / `awaitStackColor` are its seam, and the token is never validated against that list (a later build may add to it). **`move` validates the tweak vocabulary and throws on an unknown name** — it does not ignore it. The three calls, each matching what bundle.js itself does:
  | Operation | `target` | `tweaks` | bundle.js |
  |---|---|---|---|
  | create a stack | first tab id | `["do-not-reparent","create-new-group","target-is-tab"]` | `createTabStack` |
  | add to an existing stack | **the group ext id** | `["do-not-reparent","on","create-group"]` (no `target-is-tab`) | `endInternalDragging` |
  | take a tab out | `-1` + `workspaceId` | `["untile","ungroup"]` | `removeFromTabStack` |

  See `ADAPTER.createStack`/`addToStack`/`detachFromStack`/`setStackName`. The
  accepted vocabulary is in `test/fixtures/vivaldi-api.json`; `test/harness.js`
  enforces it, so a tweak name the browser would reject fails the offline suite
  too (SPEC.md F9).
- **Stack group ids are `crypto.randomUUID()` strings assigned by the backend** on stack creation — the caller cannot choose the id. So stacks are **matched across devices by name (else member-URL overlap ≥0.5), not by id** (see `matchStacks`). The id in the JSON is informational only.
- **Grouping is asynchronous.** `vivaldi.tabsPrivate.move` returns the new group id *before* the tabs' `vivExtData` reflects it. Everything that groups, ungroups, renames or recolours must be waited out via `ADAPTER.awaitStack` / `awaitStackColor` / `pollTabs` — `reconcile()` publishes the instant `applyDesired` returns, and a snapshot of a half-applied grouping tells every peer to undo what was just done (two devices regrouping and ungrouping a stack for ever).
- **Adding a tab to an EXISTING stack** targets the **group id**, not a tab id.
  Phase 2 of `applyDesired` **verifies the join and falls back to
  `createStack` over every member** if it did not land, and contains any throw
  so one bad call cannot abandon the whole plan. Without that, a tab a peer
  opened inside a stack arrives here as a plain tab, we publish it as one, and
  the peer faithfully takes the tab back out of its own stack.
  `VivaSync.diagAddToStack()` exercises it directly.
- **Taking a tab OUT of a stack** uses the `ungroup` tweak (what bundle.js's `removeFromTabStack` does). `ADAPTER.detachFromStack` tries that first, then `tabsPrivate.move` *without* `do-not-reparent`, then `createStack([id])` (a group of one), **verifying `vivExtData` after each** — a silent no-op here strands a tab inside a stack the user never made. Confirmed working on Vivaldi 8.1 (`VivaSync.diagDetach()` → `detached: true`); re-check it after a Vivaldi update, because the fallback chain hides which mechanism is actually carrying it.
- **A new tab joins the ACTIVE TAB's stack**, not just the active workspace — **pinned or not** — and `pinToWorkspace` passes `do-not-reparent`, so every tab created for top level is passed through `detachFromStack` afterwards, or whatever stack the user is sitting in swallows it. **A tab created for a stack goes through it too**, unless it landed in the very group its plan is extending: both members of a *new* stack otherwise start out in the user's stack together, which makes "these tabs are one stack" already true of the wrong group. `awaitStack` therefore takes the group id the move answered with and waits for **that** one, or phase 2 would rename the user's stack to the new one's name while the new stack never settled. A **pinned newborn** takes a different route to the same place: `createTab` creates it with `pinned: true` and a create-time `vivExtData: {workspaceId}` and does not run `pinToWorkspace` on it, because a repositioned tab may lose its pin (the pinned strip is at the front of the bar, `pinToWorkspace` parks at the end of the workspace's region — unverified, `diagPin` → `lostByMove`). `applyDesired` then verifies where it landed: on a build that ignores create-time `vivExtData` it places the tab the ordinary way and drops the pin (a tab in the right workspace unpinned beats a pinned tab in a workspace the snapshot cannot see), and **if it landed inside the active tab's stack it is unpinned, detached and re-pinned by the pin phase**. Left in the stack, the device would publish it as a member and the peer would move its own pinned tab into the stack too (SPEC.md F11). The harness models the join; `test/15-pinned.js` §11 is the case.
- **A group with one live member is not a stack.** Vivaldi dissolves a stack below two tabs; whether it clears `group` on the survivor is unconfirmed. `buildSnapshot`, `liveWorkspaceView` and `itemsOf` all treat a one-member group as a plain tab, so the mod behaves identically either way.
- **Workspace list** is NOT in window extData (Vivaldi 8.0). It's the pref `vivaldi.workspaces.list`, read in-context via `vivaldi.prefs.get` (`ADAPTER.workspaceList`, 15s cache, `forceRefresh` for UI).
- **Workspace ids** are float timestamps (`1717425015828.0`); normalize with `String(Number(id))` before comparing (`ADAPTER.wsKey`). **Active workspace** = `workspaceId` from the active tab's `vivExtData` (version-independent).
- **Never `chrome.tabs.move(id, {index:-1})` on a workspace tab.** The tab-strip index spans ALL workspaces; moving to the window end reassigns the tab to a neighbouring workspace and it vanishes from this one. Created tabs already append in creation order. Likewise never move a stack member individually outside its own run — it leaves the stack.
- **Reordering goes through `ADAPTER.moveToIndex`**: `vivaldi.tabsPrivate.move` with a **numeric `target`** (a strip index in the post-removal frame, chrome.tabs.move semantics — exactly what bundle.js's own `moveToIndex` passes), the `workspaceId` named explicitly (so the move cannot re-home the tab), and `do-not-reparent` (what bundle.js passes for its move-to-beginning/end). The landing index is read back; if the build takes the workspace argument as "park at the end of that workspace", the same call without it is tried. The order phase (`applyOrder`, R2.2.2b) only ever moves **whole units** — a top-level tab, or every member of a stack in one call — to **boundaries between units**, and re-reads the strip before each move. The one exception is reordering a stack's members, where the target lies between two members of the **same** group and each move is verified: a member that left its run is put back with `addToStack` and that stack's reordering is abandoned for the round. It is driven by an **order plan the create phase builds** (one entry per desired item, in document order, naming the live tab ids that satisfy it), never by re-matching addresses here — a tab the apply has just opened is `loading` and therefore `volatile`, and a phase that skipped volatile units would leave a tab a peer opened from a link at the end of the strip. Volatility is about never *closing* a tab, not about never moving one. Whether a real build absorbs a top-level tab placed at a stack's edge is measured by `VivaSync.diagOrder()`, not assumed (SPEC.md F13).

A reachable webpack registry (`window.webpackChunkgapp_browser_react`) also exists; `VIV` in `vivasync-mod.js` can pull Vivaldi internal functions out of it for the diagnostics, but the reconcile path doesn't need it (it uses `vivaldi.tabsPrivate` directly).

If a future Vivaldi update changes field names or APIs, run `VivaSync.introspect()` and the `VivaSync.diag*` helpers (`diagNotes`, `diagApis`, `diagMakeStack`, `diagAddToStack`, `diagDetach`, `diagOrder`, `diagPin`, `diagWebpack`) in the core DevTools console to see raw values / re-confirm the primitives, and adjust `ADAPTER` only.

### Private-API call convention

Vivaldi's private APIs are callback-style with `chrome.runtime.lastError`, but most also return a thenable. Always go through the `apiCall(fn, thisArg, ...args)` helper, which passes a callback, adopts a returned thenable if there is one, and retries without the callback if the build rejects the extra argument.

`vivaldi.prefs.get` in particular returns the raw value on some builds and a wrapper object (`{value}`/`{currentValue}`/`{defaultValue}`) on others — use `prefGet`, which unwraps it. **Never `String()` a pref result without checking it is a string**: doing so produces an `[object Object]` device name, and notes titled after it.

### Reconcile invariants

These six rules are why the engine is safe to run continuously. Each exists
because breaking it was observed, in a two-device setup, to destroy tabs or peg
both machines at ~15-20% CPU (SPEC.md, "Approaches that failed", has the
details):

1. **The write after an apply (R2.2.3) must be signature-gated, never forced.**
   A forced write makes two devices ping-pong for ever: each apply publishes a
   newer document even when nothing changed, which the peer then applies and
   republishes. `reconcile()` ends with `writeChanged(false)` for this reason —
   do not "fix" it to `true`.
2. **A state is ordered and recognised by its PROVENANCE, never by a clock.**
   Every document carries `origin` (the device whose user made the state) and
   `version` (that device's Lamport clock reading when it did). The wall-clock
   `timestamp` is still written, but it is only a tie-break between two
   concurrent originations. Three rules hang off it, all in `reconcile` /
   `writeChanged` and pinned by `test/11-echo.js` and `test/12-back-sync.js`:

   - **A document whose `origin` is this device is never applied**, whatever
     its content or stamp. It is our own state coming back through a peer, and
     it can only tell us to undo what the user has done here since. Recognising
     it by timestamp or by content does not work: the peer's rendering of our
     state is not signature-identical to ours once a tab opened next to its
     opener here was appended at the end there (SPEC.md F1).
   - **The first write after an apply is an ACKNOWLEDGEMENT.** `reconcile`
     records the adopted provenance in `ackPending` **before** `applyDesired`
     (the apply's own tab events schedule the write), and `writeChanged` spends
     it on the next write of that workspace whatever the browser made of the
     apply: origin, version and timestamp go out unchanged. A peer's rendering
     of our state is not the peer's news. A change the peer's user makes inside
     the apply window is folded into the acknowledgement and published under
     the next fresh version — delayed, never lost to a swap. If the apply
     changed nothing (signature unchanged) the pending acknowledgement is
     dropped, or it would be spent on the user's next change.
   - **A remote is applied only if it out-ranks the state this device HOLDS**
     (`current`: seeded from our own document on the first reconcile of a
     session, moved by every apply and every write). Version first, then
     timestamp, then origin name (`cmpProv`). Comparing against what we hold
     rather than against "the last remote applied" is what makes two concurrent
     originations resolve identically on both sides — each compares the other's
     against its own, exactly one yields — instead of swapping states.

   `versionClock` is fed by every version seen in the folder (`noteVersion`),
   and a fresh origination takes `nextVersion`, so a change made after seeing a
   peer's state always out-ranks it however the two wall clocks are set. Joining
   a workspace (R2.5) writes version 0 at timestamp 0. A note whose JSON lacks
   any of `workspace`, `origin`, `version` or `items` is not a sync document
   (`isSyncDoc`): `listDocs` drops it with one warning per title, and nothing
   past `listDocs` guards against the fields being absent.

3. **A write must publish the state it lands with, not the state it was armed
   with.** Note writes are throttled to `SETTINGS.minNoteWriteGapMs`, and that
   wait sleeps *inside* `NOTES.write` — i.e. after `writeChanged` has taken its
   snapshot and before the payload is stamped. A write queued while the
   throttle is closed would therefore publish a state up to five seconds out of
   date under a brand-new timestamp, telling every peer that tabs this device
   no longer has are the newest truth. `writeChanged` asks
   `NOTES.writeDelay()` first and **re-arms** (`scheduleWrite`) rather than
   queueing; `forceQueued` carries a deferred `writeNow()`'s force across the
   re-arm. `test/03-regressions.js` §F pins it. This is the same endless swap as
   invariant 2, entered from the write side rather than the read side.
4. **Never apply a remote while local changes are unpublished.** Reconcile is
   newest-wins whole-document, so anything missing from the remote is closed. A
   tab the user just opened is in no peer's document yet, so pulling first
   deletes it under their cursor. `reconcileActive()` compares the live
   signature against `lastSig` and defers — and so does `reconcile()` on the
   workspace-switch path (`onOpen`), or a tab opened just before switching away
   and back would be closed. A deferred pull sets `pullWanted`, and
   `writeChanged` retries it the moment the write lands, instead of leaving the
   device one document behind until the next unrelated note event. The
   signature (`signature`) compares the **sequence of unpinned top-level
   items** and each unpinned stack's member sequence — the order phase
   reproduces both, so a reorder is a change like any other — and stays
   order-insensitive over the pinned strip alone, which nothing reproduces (the
   mod never moves a pinned tab, and a pinned stack is part of that strip: it
   is compared by name, colour and member set, not by order). An order that
   were compared but not reproduced would look like unpublished local news for
   ever; comparing it is safe because the order phase reproduces it, and —
   more importantly — because a rendering the browser will not reproduce
   exactly goes out as the **acknowledgement** under the peer's provenance
   (invariant 2), which the peer never applies: one differing rendering, never
   a swap. `test/16-order.js`.

   **Deferring is right only when the remote is CONCURRENT with what we hold**
   (its `version` no higher than `current`'s — neither side saw the other).
   A remote numbered **higher** was made after its device saw a state at least
   as new as ours, and publishing over it both discards that work and is not
   even reliable: our next version is numbered from the folder we last read
   and can come out below it, and the retried pull then closes exactly what
   the deferral was protecting. Such a remote is therefore **merged** on open
   (`withLocalNews`): the remote, plus every tab here that our own last
   document did not list (opened, or **moved in from another workspace**),
   less — when that document is this session's own publish — the tabs closed
   here since; the merge goes out as a **fresh origination**, not an
   acknowledgement. The same merge runs on the first open of a session
   (no `lastSig`).

   And **no fresh origination is ever published over a peer state numbered
   above the held one** (`peerAhead`, checked by `writeChanged` before every
   write that is not an acknowledgement). Our next version is numbered from
   the folder we last read, so it comes out equal to the peer's or below it:
   it either loses (and the next pull closes our change) or wins on the clock
   and discards the peer's work on both machines. The ACTIVE workspace is
   merged right then (`reconcile` with the open semantics above, and it is
   the merge that goes out); a workspace that is not showing holds the write
   until it is opened (invariant 5). A peer state with an **equal** version is
   concurrent and does not count. This rests on provenance alone — keying the
   hold on the browser's active workspace, or on a workspace switch having
   been handled, both fail (the move's write fires before the switch is
   handled, and sometimes no switch is observed at all; SPEC.md F5).
   `checkActiveWorkspace` treats tabs outside every workspace as a place, so
   coming back from them is a switch. A write also never runs while a
   reconcile of its workspace is in flight (`reconciling`); the reconcile ends
   with its own. The typical case: "Move to workspace" into a synced workspace
   with a peer's change pending — Vivaldi switches into it, the pull brings the
   peer's document, and the moved tabs, listed in no document, would be
   closed. `test/18-move-in.js`.
5. **`applyDesired` only ever runs for the ACTIVE workspace.** `createTab`
   depends on new tabs auto-joining the active workspace; reconciling an
   inactive one creates its tabs in whatever *is* active while deleting from the
   target. There is an explicit precondition check.
6. **Adopt before create, create before delete — and never publish a half-applied grouping.** If the delete phase empties the workspace even
   momentarily, Vivaldi activates a neighbouring workspace's tab — and since
   `activeWorkspaceId()` is derived from the active tab, the mod's idea of "the
   active workspace" silently flips mid-reconcile while the UI still shows the
   original. The delete list is planned up front, creates run against the
   *surviving* set (`keptTop` / `keptByGid`), and removal happens afterwards.
   The planned deletes are an **adoption pool**, not a kill list: a tab whose URL
   the desired document wants in a different container is moved there instead,
   and only what nothing claimed is closed. The bulk `chrome.tabs.remove` is
   **rejected outright if any id in it has gone stale** ("No such tab - N"), and
   a tab can go stale on its own between planning and closing because stack
   dissolution is asynchronous — so the delete phase retries one at a time,
   tolerating the ids that really are gone; otherwise one such id would abandon
   the whole list, which looks exactly like "deletes stopped propagating".
   Phase 2 then waits for each grouping to reach `vivExtData` before returning,
   because the write that follows would otherwise describe a state the browser
   is still mid-way through. When a grouping never lands at all, `applyDesired`
   returns `{settled:false}` and `reconcile` **publishes nothing this round**,
   re-arming the write `SETTINGS.groupSettleRetryMs` later: the truth late beats
   a lie now, because the lie is an instruction to every peer to undo the
   grouping.

### No polling

There is no periodic sync work. Writes come from `chrome.tabs` events; workspace
switches from `onActivated`/`onRemoved`/`onFocusChanged`; pulls from notes change
events (filtered to the VivaSync folder via `NOTES.classify`, so editing an
unrelated note costs nothing). The only surviving timer re-asserts the toolbar
button every 3s and is one `getElementById` per window. Do not add timers to the
engine: a new behaviour should hang off an event, or off provenance.

### R2.4 — materialization safeguard (critical invariant)

Vivaldi lazy-loads inactive workspaces: their tabs don't exist in `chrome.tabs` until the workspace is opened. Three sets enforce the safeguard:

- `openedWorkspaces` — a workspace is only ever written **after** `reconcile()` adds it here.
- `everHadContent` — prevents overwriting a known-non-empty workspace with an empty snapshot while it's inactive (guards against tab hibernation).
- `sawPeerDoc` — workspaces for which another device's document has actually been
  seen. **A device that has neither held content nor seen a peer document never
  publishes an empty snapshot.** This is the onboarding case: a new machine gets
  `sync.config` (one small note) before the peers' `<ws>-<device>.json` notes,
  because notes replicate as separate entities. In that window the device cannot
  tell an empty workspace from one whose document has not arrived — and an empty
  document would out-rank either peer's, closing the workspace on every existing
  machine. Refusing costs nothing: an empty first document conveys no
  information. `test/07-onboarding.js` pins it.

`init()` does **not** call `writeChanged` on startup. It only calls `checkActiveWorkspace()`, which reconciles and writes the currently active workspace. All others wait until the user opens them.

### R2.5 — ticking and unticking a workspace (`publishOnEnable` / `unpublishOnDisable`)

**Ticking a workspace in the Workspaces dialog publishes it immediately**,
without waiting for the user to switch into it. R2.4 will not snapshot a
workspace Vivaldi has not materialized and invariant 5 will not reconcile one
that is not active, so without this a newly ticked workspace would do nothing
at all — indistinguishable from a dead transport. `publishOnEnable` writes the
document from the live tabs directly, bypassing the R2.4 gate but not what it
stands for; the provenance is what makes that safe, because reconcile is
newest-wins whole-document:

- **First device** on the workspace (nobody else in its `peers`, no document in
  the folder) — publish normally. There is nothing to overwrite. It then joins
  `openedWorkspaces` + `everHadContent`, which is honest: we just serialized live
  tabs out of it, so it *is* materialized.
- **Joining** a workspace the others already share — publish as version **0**
  stamped **0** (1970). The document exists and names this device, but loses
  every comparison it will ever be in, so the peers keep their content and this
  machine adopts it on the first pull. That deliberately discards whatever the
  workspace held locally: the alternative is one machine's private copy
  silently replacing the shared one everywhere. The workspace is deliberately
  **not** added to `openedWorkspaces` — it stays pending until the user opens
  it and actually receives the shared content. `lastSig` *is* set, or
  `reconcileActive` sees "unpublished local changes" and defers the pull for
  ever (invariant 4), i.e. never receives what it just signed up for.
- **First device with nothing to publish** (no live tabs and no peer document) —
  publish nothing. An empty snapshot here cannot be told from an unmaterialized
  workspace, and it would instruct every device that joins later to close it.

**Unticking removes this device's document** (`unpublishOnDisable`) along with
the per-workspace session state, so re-ticking is a clean join rather than a
resumption. It first waits out any write still asleep in the note throttle: the
note would otherwise be recreated a moment after it was deleted, and this device
would keep offering its tabs to a workspace it has left.

Both run from the Workspaces dialog's Save, and only for what actually *changed* —
re-saving with a workspace still ticked must not re-stamp a document the peers
are using. `pendingSynced()` names the workspaces waiting to be opened, in
the log, in the Debug window's `E. materialized` row and in
`VivaSync.config().pending`.

## Notes transport

`NOTES` in `vivasync-mod.js` is the transport. It exposes `init`, `list(prefix)`, `readNote(title)`, `readEntry(title)`, `write(title, data, stampTs)`, `remove(title)`, `classify(id)`, `writeDelay(title)` and `isOwn(id)`.

- Documents are notes titled `<workspace>-<device>.json`, directly under the `VivaSync` folder. Payload: `{workspace, items, origin, version, timestamp}` — `origin`/`version` are the provenance of invariant 2 and are set by `writeChanged` / `publishOnEnable`, not by `NOTES.write`.
- `list()` returns `[{name, id, data}]`, with `error` instead of `data` for a note whose content is not JSON.
- **`timestamp` is stamped by `NOTES.write`** (`Date.now()/1000`, epoch seconds float) unless the caller passes `stampTs`. It orders nothing on its own: version first, timestamp only as the tie-break (invariant 2).
- **Folder resolution must skip the trash subtree.** A trashed `VivaSync` folder must never be adopted as the live one.
- `getTree()` does not reliably populate `content`; fall back to `notes.get(id)`.
- Writes to one note are throttled to `SETTINGS.minNoteWriteGapMs` (5s by default) — each write rewrites Vivaldi's whole Notes store and pushes a sync entity. Because that throttle *sleeps inside* `NOTES.write`, `writeChanged` keeps a `writing` set so the tab events that keep re-arming it can't stack redundant writes behind an in-flight one — and, for the same reason, it asks `NOTES.writeDelay(title)` **before** handing a snapshot over and re-arms via `scheduleWrite` instead of queueing (invariant 3).
- `NOTES.isOwn(id)` tracks notes this device wrote, so the `onChanged`/`onCreated` listeners ignore our own writes and never reconcile in a loop. Ownership is re-checked after the remote debounce, because creating a note fires `onCreated` before `create()` returns its id.
- `NOTES.classify(id)` resolves a changed note to its title if it is in the `VivaSync` folder: a single-node `get` and a `parentId` compare when `parentId` is present (not verified on every build), else a match against the folder listing.
- **One note per title, by construction and by repair.** Every reader would otherwise pick a copy at random (SPEC.md R0, F17). Three defences, all in `NOTES` and pinned by `test/13-notes-hygiene.js`: (1) `contentOf` treats an **empty** `content` from `getTree()` like a missing one and falls back to `notes.get`, and `readConfig` uses `NOTES.readEntry`, which distinguishes *absent* (seed) from *unreadable* (do not) — so a present note is never read as missing and a second `sync.config` is never seeded over it. (2) `write` is serialized per title and only creates when a **fresh** listing has no note of that title; a failed update re-resolves the title and retries before it ever creates, because "update failed" is what a note replaced by a sync merge looks like. (3) `children()` collapses same-title notes to one, keeping the copy with the highest `(version, timestamp, content)` — chosen from **content** so every device keeps the same copy; choosing by local id or tree order would have each device delete a different one. Two `VivaSync` folders (both devices seeded before their first sync) are resolved the same way: the fullest, then the greatest id, with a warning naming the others.

## Key identity rules (reconciliation correctness)

- **Tab** identity = `(container, normUrl(url))` — duplicate URLs in the same container collapse to one. Matching is on the **normalised** URL (`www.`, trailing slash, host case and default ports ignored; query and fragment preserved). The raw URL is what gets stored and opened. Without this, any site that redirects to a different spelling makes the two devices delete and recreate the tab at each other for ever — a tab blinking open/closed on both machines.
- **Only `status === "loading"` is "in flight".** `chrome.tabs.Tab.status` is `unloaded | loading | complete`; `unloaded` is a *hibernated* tab (Vivaldi discards background tabs and restores sessions lazily, so most of a workspace is `unloaded` right after a restart) and its URL is stable. Testing `status !== "complete"` would make every hibernated tab undeletable, which stops deletions propagating between devices at all, and make every publish wait out the whole load hold first (SPEC.md F16). That hold is `MAX_LOAD_HOLD_MS` (30s) of wall time, not a count of polls: a page that takes ten seconds to commit is ordinary, and publishing before it commits describes the tab as absent. A tab navigating away from the start page is snapshotted as its `pendingUrl` (`tabUrl`) rather than filtered out as blank. `test/04-url-churn.js` §2d/§2e pin it.
- **`pinned` is reconciled in place — the only tab attribute that is — and it IS in the signature.** Tab identity is `(container, normUrl)`, so a tab that differs from the desired document *only* in its pin state is already present: the create phase counts it satisfied and the delete phase has no claim on it. `applyDesired` therefore records every tab the document speaks for (`pinPlan`: top-level tabs with the state the document wants, stack members with their stack's state) and runs a **pin phase** after the create, delete and group phases: it **re-reads the live tabs** and calls `chrome.tabs.update({pinned})` only where the state differs, then reads back and logs a refusal or a tab that left the workspace. Re-reading (rather than predicting what each move did to the flag) is what lets the phase be correct whether or not a move strips a pin. On the write side `signature` carries the flag, so a user's pin is a change like any other and goes out as a fresh origination. It is safe in the signature only because of provenance: without it, a pin the browser *declines* becomes an endless swap (the refused device publishes its unpinned view as its own news, the peer applies it, is refused the other way, and publishes back — SPEC.md F10). Under invariant 2 the write after an apply is an acknowledgement under the peer's origin whatever the browser made of the apply, and a device never applies its own origin; if the refused apply changed nothing at all, the acknowledgement is simply dropped. A refusal therefore costs the pin and nothing else. `test/15-pinned.js` §9 runs exactly that on a build that refuses to pin.
- **A stack is pinned as a whole; a group whose members disagree is not one.** Vivaldi pins a tab stack as a unit and it stays a stack in the pinned strip, so a stack item carries its own `pinned` and every member repeats it. A **mixed** group is the broken case, and it exists because Vivaldi drops a newborn into the active tab's stack whatever either one's pin state is: `groupPinStates` partitions such a group by pin state and takes the larger part (ties to the unpinned side) as the stack, so both views and `itemsOf` agree, and the odd tabs out are top-level tabs carrying their own pin. A part of fewer than two members is not a stack at all. The pin phase, the one place that still looks at the raw group, takes a tab that is to be pinned and that the document does **not** place in a stack **out** of the group it sits in (unpin, `detachFromStack`, re-pin); members of a stack the document pins are exempt. That is what repairs a workspace left with a pinned tab inside an ordinary stack: its document describes the intended state, so nothing else in the apply would differ from it, and the half-pinned group would outlive every reconcile. Pinning a stack is one `chrome.tabs.update` per member — the only call there is — so the group is **read back afterwards and rebuilt** (and renamed, and re-coloured) if it came apart, and a rebuild that does not settle publishes nothing that round. `VivaSync.diagPin()` reports whether a build needs that (`memberPinKeptGroup`). `test/15-pinned.js` §8, §11, §12 (mixed groups), §13-§17 (pinned stacks).
- **A stack's COLOUR syncs on the name's terms — with one extra rule.** Vivaldi
  stores the colour the user picks (Tab Stack > Color) in every member's
  `vivExtData.groupColor`, beside `fixedGroupTitle`, so a stack item carries
  `color` too: it is in the signature (a recolour alone is worth publishing),
  it is applied in place, and it is asserted only when the live stack actually
  differs — a re-assertion per reconcile is churn and costs a settle wait
  (`awaitStackColor`). Because a rebuilt group is a **new** group carrying
  neither property, every path that rebuilds a stack (a join that did not land,
  a pin that took the group apart) re-applies the name *and* the colour. The
  extra rule: `color: null` means "no colour", but a stack item with **no
  `color` key at all** claims nothing about it, and the colour here is left
  alone — a writer that does not track colour (or a hand-edited document) must
  not strip a colour the user just set. `pinned` has no such case, because a
  document that says nothing there means an ordinary stack.
  `test/06-stacks.js` §10-§14.
- **An excepted address is invisible to sync.** `sync.config` carries an
  `exceptions` list of address *prefixes* (the Exceptions dialog edits it);
  `isExceptedUrl` compares with the scheme, a leading `www.` and letter case
  stripped from both sides, so `www.google.com/maps` covers
  `https://google.com/maps/@40.08,-75.09,…`. A tab whose address matches is
  handled exactly like an empty new tab: filtered out of `buildSnapshot` (so it
  is in no document and no signature), `volatile` in `liveWorkspaceView` (never
  closed for being absent from a remote), dropped from a remote document by
  `itemsOf` (a peer that has not reloaded the config, or wrote before the
  exception existed, may still list it — it is not opened here), and **not
  counted as a stack member** in either view, so a stack of one synced tab and
  one excepted tab is the synced tab, top-level, on every device. The list is
  shared, not per device. Editing it (`writeExceptions`, or a reload that finds
  it changed) schedules a write, because the documents describe a different set
  of tabs now; a tab that stops being excepted is published as a fresh
  origination. The one-off cost of *adding* an exception for a tab that is
  already synced: the document without it may reach a peer before the config
  note does, and that peer closes its copy once. `test/14-exceptions.js`.
- **An empty new tab is not content and is never synced.** `isBlankTabUrl` matches `about:blank`, `chrome://newtab`, `chrome://vivaldi-webui/startpage`, `vivaldi://startpage` and friends. Such a tab is filtered out in `buildSnapshot` (so it is absent from the document *and* the signature) and marked `volatile` in `liveWorkspaceView` (so it is never closed for being absent from a remote — the user is probably typing in it). Publishing one means each device broadcasting its own spelling of "nothing" while the other opens and closes it — a new tab flipping between empty and loaded on both machines in step. No wait fixes that — the trigger is the unbounded human pause between opening a tab and typing into it. Consequence worth knowing: a workspace holding nothing but a new tab snapshots as **empty**.
- **A completed load is not a settled address.** A site that drives its URL from an input box (Google Translate, search-as-you-type) *completes* a navigation on every intermediate value, so `isLoadingTab` lets every prefix of what the user is typing through as publishable content — the peer would open each one, publish it back, and the user's own tab would reload through its own typing history. The tell is not the load state but a quiet period: `writeChanged` holds a workspace until every URL in it has been unchanged for `SETTINGS.urlSettleMs` (2.5s by default, overridable from the config note's `settings` or with `VivaSync.urlSettle(ms)`), re-arming for exactly the time left rather than burning the load-defer budget in 500ms steps. `SETTINGS.maxSettleHoldMs` (15s) bounds it, so a page that rewrites its URL on a timer delays the publish instead of cancelling it. Fed by `urlChangedAt`, which `chrome.tabs.onUpdated` stamps. `test/04-url-churn.js` §5 pins it.
- **Loading tabs are untouchable — unless this device opened them.** A tab mid-navigation has a transient URL, so it is never deleted for being absent from a remote document, and a workspace with one is not published at all (`isLoadingTab`, `loadSince`). Publishing a pre-redirect URL propagates a tab that will not exist a second later. **The deletion half of that rule is about a tab the USER opened**: `createTab` records every tab it opens in `syncBorn` (cleared when the tab commits its address — `onUpdated` with `status: "complete"` — or closes), and such a tab is not `volatile` in `liveWorkspaceView`, so a NEWER document that no longer names it closes it while it is still loading. Nobody is typing in a tab we opened from a document. Without that, a second document arriving inside the first apply's load window would leave every tab of the first one open, and the acknowledgement would publish them back under the peer's own provenance — which the peer never applies (invariant 2), so the two devices would sit on different tab sets until something else changed. The harness creates tabs `loading` so this is exercised; `test/04-url-churn.js` §6.
- **Churn circuit breaker.** Normalisation cannot fix a URL that genuinely lands elsewhere (geo redirect, session id, login bounce). `mayOpen()` gives each URL `OPEN_ATTEMPT_CAP` (3) attempts, then refuses and logs; counters are device-local, expire after 30 min, and clear as soon as a URL sticks. This is what *guarantees* termination — see `VivaSync.diagChurn()` / `VivaSync.clearChurn()`.
- **Stack** identity = **name** (if named), else best member-URL overlap. NOT the group id: ids are backend-assigned UUIDs that differ per device (see ADAPTER notes above). Matching by name/contents keeps stacks stable across devices and makes rename non-destructive.
- **A tab is moved between containers, never closed and re-opened.** Deletes are *planned* first, but every unwanted tab stays in an adoption pool through the create phase; only what nothing claimed is closed. This is correctness, not tidiness: a loading tab is never closed, so leaving it in place *and* opening a copy in the target container puts the same URL in two containers at once — deleting a stack member on one device would leave the other with a leftover top-level tab **plus** the intact stack. `test/06-stacks.js` §5 pins it.
- **Workspace** identity = name (from the config note).
- **A document belongs to the workspace its PAYLOAD names, not the one its title
  starts with.** Titles are `<workspace>-<device>.json` and both halves may
  contain `-`, so `Shared-2-workshop.json` is a well-formed name for workspace
  `Shared-2` on device `workshop` *and* for workspace `Shared` on a device
  called `2-workshop`. A `startsWith("Shared-")` prefix match would adopt the
  other workspace's document — newest-wins whole-document, so every tab in
  `Shared` would be replaced by `Shared-2`'s tabs on the peer and written
  straight back over the original (SPEC.md F12). `listDocs()` filters the
  prefix listing on `data.workspace`; a document that fails to parse or lacks
  the field is not a sync document and is ignored, never matched by title.
  `test/08-workspace-names.js` pins it.
- **Device** identity = `vivaldi.sync.session_name` → `vivaldi.sync.getDefaultSessionName()` → a persisted random `dev-xxxxxxxx`, reduced to `[\w-]` so it is safe in a note title.

## Configuration

`VivaSync/sync.config` (a note) — **one** document, shared by every device, in
which each entry names the devices that synchronize that workspace, plus the
shared `exceptions` list of address prefixes that are never synchronized (see
"Key identity rules"):

```json
{ "workspaces": [ { "name": "Shared", "peers": ["workshop", "cinfra"] } ],
  "exceptions": [ "www.google.com/maps" ],
  "settings": { "urlSettleMs": 4000 } }
```

Optional keys: `autoPull` (false turns off pulling on peer note changes) and
`settings`. `writeConfig`, `writeExceptions` and `writeSettings` each re-read
the note and carry every key they do not own through unchanged.

### `settings` — every timing the engine runs on

`SETTINGS_DEFAULTS` at the top of `vivasync-mod.js` is the **fallback**, not the
value: each key may be overridden from the note's `settings` object, and because
`sync.config` is itself a synced note, tuning it once tunes every device.

| key | default | what it is |
|---|---|---|
| `writeDebounceMs` | 500 | coalesce a burst of tab events (R2.1) |
| `switchDebounceMs` | 250 | coalesce the event burst of a workspace switch |
| `minNoteWriteGapMs` | 5000 | floor between two writes of the **same** note |
| `remoteDebounceMs` | 1000 | coalesce inbound sync notifications |
| `groupSettleRetryMs` | 3000 | hold-off after a grouping failed to settle |
| `urlSettleMs` | 2500 | quiet period a URL must hold before it is publishable |
| `maxSettleHoldMs` | 15000 | upper bound on that hold |
| `logMax` | 400 | log ring buffer, lines |
| `logLineMax` | 2000 | log ring buffer, chars per line |
| `showDebug` | `false` | whether the menu offers the Debug window |

The first seven and `showDebug` are what the **Settings dialog** edits; the two
log sizes are note-only. `showDebug` is the one non-numeric key — the default's
type is what `applySettings` validates against, so it wants `true`/`false` and
refuses anything else the same way a timing refuses a string.

Rules, all in `applySettings` and pinned by `test/17-settings.js`:

- **Read through `SETTINGS` at the point of use.** Never copy one into a local
  or capture it in a closure: the engine is running before the note has been
  read, and an edit to the note has to take effect without a restart. The log
  tap is the extreme case — it is installed at the top of the IIFE, long before
  there is a transport to read a note with.
- **A value is taken only if it is a finite number at or above that key's
  floor** (`SETTINGS_MIN`; 0 for the debounces, which may legitimately be "do
  not coalesce"). Anything else — a string, a negative, a misspelled key — falls
  back to the default and **warns**, because a garbage debounce is
  indistinguishable from a mod that has hung, and a typo is otherwise silent.
- **A key the note omits keeps its default**, and removing the object restores
  all of them on the next read.
- `"urlSettleMs"` is also accepted at the **top level** of the note
  (`settings` wins when both name it). `VivaSync.urlSettle(ms)` and
  `VivaSync.tunables({...})` set values for the session only — the next
  `readConfig` puts back what the note says.
- What an install has actually changed is in `VivaSync.config().tuned`, in the
  Debug window's `A. engine` row, and in one startup log line (only when there
  is something to say).

A device synchronizes a workspace when, and only when, it finds **its own name**
in that entry's `peers`. So the selection is shared and per-device at once, and
every machine can also *see* who a workspace is shared with — the Workspaces
dialog's "Synced on" line, and the Debug window's `C. config` row, are that list.
The workspace itself must exist under the same name on each peer; the mod never
creates a workspace.

The note's change event only arrives if this device is running to hear it —
initial sync at startup is the common miss — so a stale selection is normal, not
freak. `readConfig()` is therefore re-run when the Workspaces, Exceptions or
Settings dialog opens and when the user switches into a workspace this device
believes is *not* synced; without that, a workspace ticked on a peer would stay
un-synced here for ever.

**Saving edits this device's membership and nothing else.** `writeConfig(chosen,
scope)` re-reads the note, then adds/removes `machine` in the entries named by
`scope` — the workspaces the dialog could actually *show*, i.e. the ones that
exist on this machine. Entries for workspaces this device does not have are
carried through untouched, or saving on a laptop that has three of the five
configured workspaces would delete the other two for everyone. That guard is
only real because the dialog seeds `chosen` from the **rows it drew**, not from
`syncedWorkspaces`: seed it from the latter and every out-of-scope entry is
implicitly re-ticked, and the guard never fires. An entry left with an empty
`peers` is dropped, and an entry without a `peers` array is ignored.
`test/09-peer-config.js` pins the behaviour.

Device-local state that must **not** replicate (the fallback device id, the URL-churn counters) lives in the `KV` store — `localStorage`, falling back to `chrome.storage.local`, then memory. Configuration never goes there.
