// R2.5 — ticking a workspace in Settings publishes it there and then.
//
// Without it, ticking a workspace would do nothing at all: R2.4 will not
// snapshot a workspace Vivaldi has not materialized, and invariant 5 will not
// reconcile one that is not active, so the workspace would stay invisible to
// every peer until the user happened to switch into it. Correct, and
// indistinguishable from a dead transport.
//
// Publishing on the tick is only safe because of the provenance it is written
// with, since reconcile is newest-wins whole-document:
//   - the FIRST device on a workspace publishes normally; there is nothing to
//     overwrite;
//   - a device JOINING one the others already share publishes version 0 at
//     1970, so its document exists and names it but loses every comparison,
//     and the shared content replaces what was here rather than the other way
//     round.
//
// Unticking removes this device's document.
//
// Own file: the mod is a one-shot IIFE guarded on window.__vivasyncLoaded.
const { createEnv, ok, done, WS } = require("./harness");

const env = createEnv({
  ui: true,
  workspaces: [
    { id: WS.WORK, name: "Work" },
    { id: WS.PERSONAL, name: "Personal" },
    { id: WS.LOCAL, name: "Solo" },
  ],
  tabs: [
    // "Work" is the ACTIVE workspace throughout; the other two are inactive,
    // which is the whole point — a tick must not require a switch.
    { id: 90, url: "https://work.example/", ws: WS.WORK, active: true },
    { id: 91, url: "https://personal-a.example/", ws: WS.PERSONAL },
    { id: 92, url: "https://personal-b.example/", ws: WS.PERSONAL },
    { id: 93, url: "https://mine.example/", ws: WS.LOCAL },
  ],
});

const doc = (title) => {
  const n = env.noteByTitle(title);
  return n ? JSON.parse(n.content) : null;
};
// Tick/untick the named workspaces in the settings dialog and save.
const settings = async (toggle) => {
  await global.VivaSync.settings();
  await env.sleep(60); // openSettings awaits the workspace list
  const dlg = env.ui.overlay();
  for (const name of toggle) env.ui.click(dlg._find((e) => e["data-ws"] === name));
  env.ui.click(env.ui.buttons(dlg).find((b) => b._text === "Save"));
  await env.sleep(5600); // the config write sleeps out MIN_NOTE_WRITE_GAP_MS
};

(async () => {
  const W = await env.boot();

  // --- 1. the first device on a workspace publishes it on the tick ----------
  ok("1. precondition: nothing is published for Personal",
     !env.noteTitles().includes("Personal-boxA.json"), JSON.stringify(env.noteTitles()));

  await settings(["Personal"]);
  const personal = doc("Personal-boxA.json");
  ok("1b. ticking an INACTIVE workspace publishes it — no switch needed",
     !!personal, JSON.stringify(env.noteTitles()));
  ok("1c. it carries the workspace's real content",
     JSON.stringify((personal.items || []).map((i) => i.url)) ===
       '["https://personal-a.example/","https://personal-b.example/"]',
     JSON.stringify(personal.items));
  ok("1d. the first device stamps a real timestamp and originates version 1",
     personal.timestamp > Date.now() / 1000 - 60 && personal.origin === "boxA" && personal.version === 1,
     `${personal.origin} v${personal.version} @${personal.timestamp}`);
  ok("1e. ...and the workspace is no longer waiting to be opened",
     !W.config().pending.includes("Personal"), JSON.stringify(W.config().pending));

  // --- 2. joining a workspace the others already share ----------------------
  // boxB has "Solo" with content of its own. This device has different tabs in
  // its local "Solo" — and it is the newcomer, so the shared content wins.
  await env.putPeerDoc("Solo-boxB.json", {
    workspace: "Solo",
    origin: "boxB",
    version: 3,
    timestamp: Date.now() / 1000 - 3600,
    items: [{ type: "tab", url: "https://shared.example/", title: "S", pinned: false }],
  });
  await env.setConfig({ workspaces: [{ name: "Personal", peers: ["boxA"] },
                                     { name: "Solo", peers: ["boxB"] }] });

  await settings(["Solo"]);
  const solo = doc("Solo-boxA.json");
  ok("2. joining publishes a document too", !!solo, JSON.stringify(env.noteTitles()));
  ok("2b. ...version 0 at 1970, so it loses every newest-wins comparison",
     solo.timestamp === 0 && solo.version === 0 && solo.origin === "boxA",
     `${solo.origin} v${solo.version} @${solo.timestamp}`);
  ok("2c. the peer's document is still the newest one on the workspace",
     doc("Solo-boxB.json").timestamp > solo.timestamp,
     `${doc("Solo-boxB.json").timestamp} vs ${solo.timestamp}`);
  ok("2d. nothing was applied yet — it is not the active workspace",
     JSON.stringify(env.urls(WS.LOCAL)) === '["https://mine.example/"]',
     JSON.stringify(env.urls(WS.LOCAL)));

  // Switching into it adopts the shared content, discarding the local copy —
  // the direction the 1970 stamp exists to force.
  // Generous: the republish that follows the pull sleeps out the note throttle
  // left over from the join write.
  await env.switchWorkspace(WS.LOCAL, 7000);
  ok("2e. switching in adopts the peers' content",
     JSON.stringify(env.urls(WS.LOCAL)) === '["https://shared.example/"]',
     JSON.stringify(env.urls(WS.LOCAL)));
  ok("2f. ...and this device then acknowledges it under the peer's provenance",
     doc("Solo-boxA.json").timestamp > 0 &&
       doc("Solo-boxA.json").origin === "boxB" && doc("Solo-boxA.json").version === 3 &&
       JSON.stringify(doc("Solo-boxA.json").items.map((i) => i.url)) === '["https://shared.example/"]',
     JSON.stringify(doc("Solo-boxA.json")));

  // --- 3. unticking withdraws this device's document ------------------------
  await settings(["Solo"]);
  await env.sleep(6000); // any write still in the note throttle must not resurrect it
  ok("3. unticking removes this device's document",
     !env.noteTitles().includes("Solo-boxA.json"), JSON.stringify(env.noteTitles()));
  ok("3b. the peers' documents are untouched",
     env.noteTitles().includes("Solo-boxB.json"), JSON.stringify(env.noteTitles()));
  ok("3c. the workspace no longer syncs here",
     !W.config().syncedWorkspaces.includes("Solo"),
     JSON.stringify(W.config().syncedWorkspaces));

  // Re-ticking is a clean join, not a resumption: the session state that went
  // with the document was dropped with it, so this device comes back as the
  // newcomer it now is.
  await settings(["Solo"]);
  ok("3d. re-ticking joins again at version 0 rather than resuming",
     doc("Solo-boxA.json") && doc("Solo-boxA.json").timestamp === 0 && doc("Solo-boxA.json").version === 0,
     JSON.stringify(doc("Solo-boxA.json")));

  done();
})();
