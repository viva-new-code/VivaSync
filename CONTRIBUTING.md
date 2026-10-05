# Contributing to VivaSync

Thank you for contributing.

## Before You Start
Read the project documentation first
- [`docs/SPEC.md`](docs/SPEC.md) — what the mod must do and why, requirement by
  requirement, and the **approaches that failed** (read those before changing
  the engine).
- [`AGENTS.md`](AGENTS.md) — architecture, the Vivaldi internals the mod relies
  on, and the reconcile invariants every change must keep.
- [`test/README.md`](test/README.md) — what each suite covers and how to extend
  the test doubles.
- [`SECURITY.md`](SECURITY.md) — the security model and how to report a
  vulnerability privately.

Run `./test/run.sh` before sending a change; a failing test in
`test/03-regressions.js` means the change is wrong, not the test.

- Be respectful and follow the Code of Conduct in CODE_OF_CONDUCT.md.
- For security issues, do not open a public issue. Follow SECURITY.md.

## Why a mod (not an extension)

Vivaldi **workspaces** and **tab stacks** are Vivaldi-internal concepts. They are
**not exposed to the standard Chromium extension API**, so a normal extension
cannot see them. Only a **mod** — JavaScript injected into the Vivaldi UI core
(`main.html`) — can read and manipulate them (tabs carry a `vivExtData` blob with
`workspaceId`, the stack id `group`, the stack name `fixedGroupTitle` and the
stack colour `groupColor`).

That same context also has everything the sync needs:

```
Vivaldi UI (main.html) ── vivasync-mod.js
                            │
                            ├─ vivaldi.notes  ──▶ Notes/VivaSync/<ws>-<device>.json
                            │                          │
                            │                     Vivaldi Sync
                            │                          ▼
                            └─ vivaldi.prefs   ──▶ other devices
```

Earlier versions did file I/O through a Python native messaging host plus a
companion extension holding the `nativeMessaging` permission. Both are gone.

## Development Setup
There is no build step required, all source code lives in a single mod file which is used directly when installed in Vivaldi resources folder. 

Node.js (latest stable version recommended) is required to run the offline test suite.

## Files

| Path                         | Role                                    |
| ---------------------------- | --------------------------------------- |
| `mod/vivasync-mod.js`        | The mod — everything                    |
| `install-linux.sh` / `install-macos.sh` / `install-windows.ps1` | Installers (and an `uninstall-*` beside each) |
| `test/`                      | Offline suite + live-browser tool ([docs](test/README.md)) |
| `docs/SPEC.md`               | The specification the mod is built to (R0–R4), and the approaches that failed |
| `AGENTS.md`                  | Architecture and engine rules for contributors (human or agent) |

Worth running `./test/run.sh` before installing after any change — about three
minutes, needs only Node, and covers the reconcile and tab-stack failure modes
that eat tabs on a two-device setup.

### Accessing debug information and logs

Open **⇄ → Debug** (tick
*Show the Debug window in the menu* under **⇄ → Settings** first, (or run
`VivaSync.debug()` in the console)): it shows
the same information the console helpers below do — engine version and device,
whether the notes transport came up, which config note is live, the active
workspace, URL churn, and a tail of the mod's log with a "Copy report" button
for bug reports. The report rows themselves are folded away behind the counts
line at the top ("9 report row(s): 3 pass, 0 fail, …") — click it to unfold
them; "Copy report" copies them either way. Use the console only if you need the
lower-level `diag*` dumps.

### Inspecting the mod context (`VivaSync`)
`VivaSync` lives on the **Vivaldi core** page (`main.html`), which is an *invisible*
document — a normal `F12` on a web page is the wrong context and will say
`VivaSync is not defined`. To reach the core page:

1. Quit Vivaldi completely.
2. Relaunch with the UI-debug flag:
   ```bash
   vivaldi --debug-packed-apps --silent-debugger-extension-api
   ```
3. Open a tab on `vivaldi://inspect/#apps`, find the Vivaldi UI entry whose
   page is `main.html` (the "Vivaldi core"), and click **inspect**.
4. In that DevTools console:
   ```js
   VivaSync.introspect()   // device name, notes folder, config source, workspaces
   VivaSync.diagNotes()    // every sync document, its age and item count
   ```

`introspect()` also reports the parsed window extData and sample tab
`vivExtData` — use it to confirm the field names the mod relies on.

Other console helpers: `VivaSync.writeNow()`, `VivaSync.snapshot("Work")`,
`VivaSync.reconcile("Work")`, `VivaSync.reloadConfig()`, `VivaSync.version`,
`VivaSync.status()` (the Debug window's rows as data), `VivaSync.log(50)`, and
`VivaSync.settings()` (the Workspaces dialog) / `VivaSync.tuning()` (the Settings
dialog) / `VivaSync.exceptions()` / `VivaSync.debug()` (works whether or not
the menu offers it) / `VivaSync.about()` / `VivaSync.menu()`.

After a Vivaldi update it is worth re-confirming the tab-stack primitives,
since nothing else notices when one of them quietly stops working:
`VivaSync.diagMakeStack()` (create and colour a stack), `VivaSync.diagAddToStack()`
(add a tab to an existing one), `VivaSync.diagDetach()` (take a tab back out),
`VivaSync.diagOrder()` (index moves) and `VivaSync.diagPin()` (pinning). Each
creates a couple of throwaway tabs and cleans up after itself.

### End-to-end test (two "devices" on one machine)

1. Tick a real workspace; add tabs, a named stack, and an unnamed stack. Confirm
   the `<ws>-<device>.json` note appears and updates on changes.
2. In the Notes panel, create a sibling note `<ws>-laptop.json` with a
   different layout, `"origin": "laptop"` and a **higher** `version` than your
   own note carries (the document must have `workspace`, `origin`, `version`
   and `items`, or it is ignored). The live workspace should converge to that
   layout, and `<ws>-<device>.json` should be rewritten as an acknowledgement
   carrying the sibling's `origin` and `version`.
3. Confirm a workspace **not** ticked produces no note.

## Multi-device note (important)

Vivaldi lazy-loads inactive workspaces, so a workspace's tabs aren't visible to
the mod until you **open that workspace at least once** in a session. The mod
therefore only writes a workspace's note after it has been opened (safeguard
**R2.4** in [`docs/SPEC.md`](docs/SPEC.md)).

Ticking a workspace publishes it right away all the same, from whatever tabs it
has loaded here:

- If another device already syncs it, **this machine's copy of that workspace
  is discarded** and replaced by the shared content the first time you open
  it — the newcomer never overwrites what the others hold. Practical rule when
  adding a device: **open each synced workspace once** before relying on sync.
- If no other device is on it yet and it has no tabs loaded here, nothing is
  published until you switch into it once — the mod cannot tell an empty
  workspace from an unloaded one, and publishing the wrong answer would close
  it everywhere. The Debug window's `E. materialized` row names the workspaces
  still waiting.

Unticking deletes this device's document for the workspace.

## Caveats

- `main.html` injection reverts on Vivaldi updates — re-run the installer.
- Sync latency is Vivaldi Sync's, not a filesystem's. Writes to the same note are
  additionally throttled to one per 5s to avoid churning the Notes store.
- The sync documents are ordinary notes: they are visible (and deletable) in the
  Notes panel, and they count toward whatever you sync.
- Tab-bar **absolute** ordering is shared with other workspaces' tabs, so only
  the **relative** order within a synced workspace is guaranteed.
- Duplicate identical URLs within the same container collapse to one (by design;
  identity is `(container, url)`).
- The version-sensitive Vivaldi field names are centralized in the `ADAPTER`
  object in `mod/vivasync-mod.js`; adjust there if `VivaSync.introspect()` shows a
  mismatch on a future Vivaldi version.

## Pull Request Guidelines

- Open a PR with a clear problem statement and scope.
- Include tests that cover your changes.
- Ensure that all suite of offline tests passes, refer to [`test/README.md`](test/README.md) for details of the test suite logic.
- Update docs when behavior or configuration changes.
- Keep PRs small and reviewable.

## Commit Messages

This repository uses Conventional Commits.

Examples:

- feat(ui): added new configuration
- fix(sync): fixed tab order synchronization
- docs: clarify setup on MacOS

## Legal

No Contributor License Agreement (CLA) and no DCO sign-off are currently required.

By submitting a contribution, you confirm that:

- You have the right to submit the contribution.
- You agree to license your contribution under the repository license.

If this policy changes, it will be announced in this file and in repository settings.