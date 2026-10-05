# Security Policy

VivaSync is a Vivaldi browser **mod**: a script injected into Vivaldi's
privileged UI core (`main.html`). It runs with the same access as the browser's
own interface — every tab, every workspace, the Notes store, the browser's
private APIs. Please treat security issues in it accordingly, and report them
privately.

## Supported versions

Only the latest release receives security fixes. The version is the `VERSION`
constant at the top of `mod/vivasync-mod.js`, also shown in the ⇄ menu's
**About** dialog.

| Version | Supported |
|---|---|
| 0.17.x (latest) | ✅ |


Vivaldi updates overwrite `main.html` and remove the mod; re-running the
installer after a Vivaldi update also installs the copy of the mod in your
checkout, so keep that checkout current.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (GitHub private vulnerability reporting). The
report is visible only to the maintainers until an advisory is published.

Please include:

- the VivaSync version and the Vivaldi version and OS;
- what an attacker needs (e.g. "write access to one synced device", "a
  malicious web page open in a synced workspace", "local access");
- steps to reproduce, and what happens versus what should happen;
- if you can, the Debug window's **Copy report** output — check it first for
  URLs or device names you would rather not share.

What to expect — this is a volunteer-maintained project, so these are
best-effort targets rather than guarantees:

| Step | Target |
|---|---|
| Acknowledgement | within 7 days |
| Initial assessment (confirmed / not a vulnerability / need more information) | within 14 days |
| Fix or mitigation for a confirmed issue | depends on severity; critical issues first |

We will credit you in the advisory unless you ask us not to. Please give us a
reasonable chance to release a fix before disclosing publicly; we will agree a
disclosure date with you, normally no later than 90 days after the report.

## Security model

Knowing what the mod trusts makes it easier to tell a vulnerability from
intended behaviour.

### What the mod does and does not do

- **No network access of its own.** The mod makes no HTTP requests, opens no
  sockets and sends no telemetry. All data moves through **Vivaldi Sync**,
  which replicates the Notes tree between your devices.
- **No file I/O, no native host, no extension.** Everything lives in notes in
  the `VivaSync` folder of Vivaldi Notes: one document per workspace and
  device (`<workspace>-<device>.json`) and one shared `sync.config`.
- **What is stored:** the URLs, titles, pin state and tab-stack structure of
  the workspaces you tick; the device names you sync between; the
  configuration. Nothing else — no page content, cookies, history or
  credentials.
- **Device-local state** (a fallback device id and URL-churn counters) is kept
  in `localStorage` / `chrome.storage.local` of the Vivaldi UI and never
  synced.

### Trust boundary: your Vivaldi Sync account

Every device signed in to the same Vivaldi Sync account (with Notes included)
can write the notes the mod reads, and **the mod acts on them**: a sync
document can make the mod open tabs with the URLs it lists, close tabs in the
synced workspace, regroup, pin and reorder them. The configuration note decides
which workspaces are synchronized and on which devices.

The mod therefore treats **every device on your Sync account as trusted**,
exactly as Vivaldi does for bookmarks, passwords and the rest of the synced
data. Someone who can write to your synced Notes already controls far more
than your tabs. Protecting the account (a strong password, Vivaldi Sync's
encryption password) is what protects VivaSync.

Out of scope, as intended behaviour:

- a device on your own Sync account opening or closing tabs in a synced
  workspace;
- anyone who can edit your Notes (locally or through your Sync account)
  changing what is synchronized;
- anything requiring administrator/root access or local access to your
  unlocked session, where the attacker could modify Vivaldi itself.

In scope — please report:

- anything that lets content **outside** that boundary influence the mod: a
  web page, a link, a note outside the `VivaSync` folder, another Vivaldi
  profile or Sync account;
- script injection into the mod's UI (the ⇄ menu and its dialogs render into
  Vivaldi's privileged `window.html`) from note content, tab titles, URLs or
  device names;
- the mod causing data loss outside the workspaces you ticked, or leaking
  synced data anywhere but Vivaldi Notes;
- installer or uninstaller behaviour that weakens the system beyond what is
  documented below.

### Known limitations

- **No URL scheme allowlist.** A sync document can name any URL, and the mod
  passes it to `chrome.tabs.create` in the privileged UI context. That is
  within the trust boundary above, but it means a compromised device on your
  Sync account can make your other devices open arbitrary addresses, including
  browser-internal pages. Restricting documents to ordinary web schemes is a
  welcome hardening contribution.
- **The mod is not signed or verified by Vivaldi.** Vivaldi loads whatever
  script is injected into `main.html`. Install only from a source you trust,
  and review changes to `mod/vivasync-mod.js` before re-running the installer.

## Installation and debugging notes

- **The installers modify the browser installation.** On Linux the resources
  directory is usually root-owned, so `install-linux.sh` uses `sudo` to copy
  the mod and edit `main.html`. On Windows the script edits files under
  `%LOCALAPPDATA%\Vivaldi\Application`. Read a script before running it with
  elevated rights.
- **macOS re-signing.** Editing inside `Vivaldi.app` invalidates Apple's code
  signature, so `install-macos.sh` and `uninstall-macos.sh` re-sign the bundle
  **ad-hoc** (`codesign --force --deep --sign -`). The browser then no longer
  carries Vivaldi's own signature, which affects Gatekeeper and Keychain trust
  in the same way as any locally modified app. `--no-resign` skips this if you
  sign the bundle yourself. Reinstalling Vivaldi restores the original
  signature.
- **Debugging flags.** `--debug-packed-apps --silent-debugger-extension-api`
  (to reach `vivaldi://inspect`) and `--remote-debugging-port=9222` (for
  `test/cdp.js`) expose the browser's internals — the debug port to **any
  process on the machine** while Vivaldi runs. Use them only while debugging,
  and restart Vivaldi normally afterwards.
- **Bug reports can contain private data.** The Debug window's report and log
  include URLs, workspace names and device names. Review them before posting
  publicly.
- **Uninstalling does not delete synced data.** The uninstallers remove the mod
  and its injection only. To remove the data, delete the `VivaSync` folder in
  the Notes panel. That deletion propagates to every device via Vivaldi Sync.

## Security-relevant changes

Contributors: a change that widens what a sync document or the configuration
can make the mod do — new actions taken on the strength of a note's content,
new places where note content is rendered as HTML, new browser APIs called — is
security-relevant. Say so in the pull request, and keep untrusted strings out
of `innerHTML` (the Debug window escapes everything it renders there; new UI
should prefer `textContent`).
