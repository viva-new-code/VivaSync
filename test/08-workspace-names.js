// Two synced workspaces, where one name is a prefix of the other.
//
// This is the first thing that happens when a user adds a SECOND workspace to
// an existing pair, and matched by title it destroys a workspace: with "Shared"
// and "Shared-2" both synced, every tab in Shared is replaced by Shared-2's tabs
// on the peer, then written back over the original.
//
// The cause is that a document's title, `<workspace>-<device>.json`, is
// ambiguous — BOTH halves may contain "-". "Shared-2-workshop.json" is the
// document of workspace "Shared-2" on device "workshop" and an equally
// well-formed name for workspace "Shared" on a device called "2-workshop".
// reconcile() collected its peers with a `startsWith("Shared-")` prefix match,
// so it adopted the other workspace's document, and reconcile is newest-wins
// whole-document. The payload's own `workspace` field is what decides now.
//
// The same flow also covers two quieter bugs that made the feature look dead
// before the destructive one even got a chance: switching into a newly ticked
// workspace published nothing (reconcile returned early when there was no
// remote to pull, and R2.4 means nothing else ever publishes it), and a config
// note edited on a peer while this device was down was never re-read.
//
// Own file: the mod is a one-shot IIFE guarded on window.__vivasyncLoaded.
const { createEnv, ok, done, WS } = require("./harness");

const env = createEnv({
  workspaces: [
    { id: WS.WORK, name: "Shared" },
    { id: WS.PERSONAL, name: "Shared-2" },
    { id: WS.LOCAL, name: "Solo" },
  ],
  tabs: [
    { id: 90, url: "https://alpha.example/", ws: WS.WORK, active: true },
    { id: 91, url: "https://beta.example/", ws: WS.WORK },
    { id: 92, url: "https://gamma.example/", ws: WS.PERSONAL },
    { id: 93, url: "https://solo.example/", ws: WS.LOCAL },
  ],
});
const SHARED = WS.WORK;
const SHARED2 = WS.PERSONAL;
const SOLO = WS.LOCAL;
const now = () => Date.now() / 1000;

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Shared", "Shared-2"] });

  // ===========================================================================
  // 1. Switching into a newly ticked workspace publishes it.
  //
  // Ticking it in Settings cannot publish it — R2.4 refuses to snapshot a
  // workspace Vivaldi has not materialized, and invariant 5 refuses to
  // reconcile one that is not active. Opening it is what lifts both. A
  // reconcile() that returned the moment it found nothing newer to pull would
  // skip the workspace's FIRST write. Nothing else publishes an unopened
  // workspace, so it would stay invisible to every peer until some unrelated
  // tab event happened to fire a write.
  // ===========================================================================
  ok("1. precondition: nothing published for the new workspace yet",
     !env.noteByTitle("Shared-2-boxA.json"), JSON.stringify(env.noteTitles()));

  await env.switchWorkspace(SHARED2);
  const first = env.noteByTitle("Shared-2-boxA.json");
  ok("1b. opening it publishes it, with no remote to pull",
     first && JSON.parse(first.content).items.map((i) => i.url).join() ===
       "https://gamma.example/",
     first ? first.content.replace(/\s+/g, " ") : "(nothing)");

  // ===========================================================================
  // 2. A document belonging to "Shared-2" is not a document of "Shared".
  // ===========================================================================
  await env.putPeerDoc("Shared-2-boxB.json", {
    workspace: "Shared-2",
    origin: "boxB",
    version: 10,
    timestamp: now() + 600,
    items: [{ type: "tab", url: "https://intruder.example/", title: "X", pinned: false }],
  });
  await env.switchWorkspace(SHARED);

  ok("2. Shared-2's peer document is not applied to Shared",
     JSON.stringify(env.urls(SHARED)) ===
       JSON.stringify(["https://alpha.example/", "https://beta.example/"]),
     env.layout(SHARED));
  ok("2b. the intruding URL was not created anywhere",
     !env.TABS.some((t) => t.url === "https://intruder.example/"),
     JSON.stringify(env.TABS.map((t) => t.url)));
  const sharedDoc = env.noteByTitle("Shared-boxA.json");
  ok("2c. ...and Shared publishes its own two tabs, not Shared-2's",
     sharedDoc && JSON.parse(sharedDoc.content).items.map((i) => i.url).join() ===
       "https://alpha.example/,https://beta.example/",
     sharedDoc ? sharedDoc.content.replace(/\s+/g, " ") : "(nothing)");

  // ===========================================================================
  // 3. The filter must not be so tight that Shared stops syncing.
  // ===========================================================================
  await env.putPeerDoc("Shared-boxB.json", {
    workspace: "Shared",
    origin: "boxB",
    version: 10,
    timestamp: now() + 900,
    items: [
      { type: "tab", url: "https://alpha.example/", title: "a", pinned: false },
      { type: "tab", url: "https://delta.example/", title: "d", pinned: false },
    ],
  });
  await W.reconcile("Shared");
  ok("3. Shared's OWN peer document is still applied",
     JSON.stringify(env.urls(SHARED)) ===
       JSON.stringify(["https://alpha.example/", "https://delta.example/"]),
     env.layout(SHARED));

  // A document without `workspace` (or origin, or version) is not a sync
  // document at all.
  // It is ignored — never matched by title, however new its timestamp.
  await env.putPeerDoc("Shared-boxC.json", {
    timestamp: now() + 1200,
    items: [{ type: "tab", url: "https://legacy.example/", title: "l", pinned: false }],
  });
  await W.reconcile("Shared");
  ok("3b. a document without workspace/origin/version is ignored, not matched by title",
     JSON.stringify(env.urls(SHARED)) ===
       JSON.stringify(["https://alpha.example/", "https://delta.example/"]),
     env.layout(SHARED));

  // ===========================================================================
  // 4. A config note edited on a peer while this device was down.
  //
  // sync.config replicates like any note, but the change event only arrives if
  // we are running to hear it — initial sync at startup is the common miss. The
  // device then holds a stale selection and silently never publishes the
  // workspace every other machine considers synced. Switching into a workspace
  // we believe is unsynced is exactly the moment to check.
  // ===========================================================================
  await env.updateNote("sync.config", {
    workspaces: ["Shared", "Shared-2", "Solo"].map((name) => ({ name, peers: ["boxA"] })),
  });
  ok("4. precondition: the edit was not noticed (it is our own note id)",
     !W.config().syncedWorkspaces.includes("Solo"),
     JSON.stringify(W.config().syncedWorkspaces));

  await env.switchWorkspace(SOLO);
  ok("4b. switching into it re-reads the config note",
     W.config().syncedWorkspaces.includes("Solo"),
     JSON.stringify(W.config().syncedWorkspaces));
  const soloDoc = env.noteByTitle("Solo-boxA.json");
  ok("4c. ...and the workspace is published on that same switch",
     soloDoc && JSON.parse(soloDoc.content).items.map((i) => i.url).join() ===
       "https://solo.example/",
     soloDoc ? soloDoc.content.replace(/\s+/g, " ") : "(nothing)");

  done();
})();
