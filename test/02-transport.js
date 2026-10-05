// The notes transport and configuration layer. Trash handling, shared vs
// per-device config, and the change-event pull path including own-write
// filtering.
const { createEnv, ok, done } = require("./harness");

// Pre-existing TRASHED VivaSync folder. Deleting the folder in the Notes panel
// moves it to trash rather than removing it; adopting that copy would resurrect
// dead configuration.
const trashedFolder = {
  id: "900", title: "Trash", type: "trash", parentId: "1",
  children: [
    { id: "901", title: "VivaSync", type: "folder", parentId: "900", children: [
      { id: "902", title: "sync.config", type: "note", parentId: "901",
        content: '{"workspaces":[{"name":"SHOULD-NOT-BE-USED","peers":["boxA"]}]}' },
    ] },
  ],
};

const env = createEnv({ rootChildren: [trashedFolder] });
const WORK = env.WS.WORK;

(async () => {
  const W = await env.boot();

  // --- trash must be invisible to folder resolution -------------------------
  ok("live folder created outside the trash", env.folder() && env.folder().id !== "901",
     "id=" + env.folder()?.id);
  ok("trashed sync.config was NOT adopted",
     !W.config().syncedWorkspaces.includes("SHOULD-NOT-BE-USED"),
     JSON.stringify(W.config().syncedWorkspaces));

  // --- shared config ---------------------------------------------------------
  await env.setConfig({ workspaces: ["Work"] });
  ok("shared sync.config is in effect", W.config().configSource === "sync.config",
     W.config().configSource);

  // --- per-device membership (R1.3) ------------------------------------------
  // There is ONE config note and every device reads the same document; each
  // entry names the devices that synchronize that workspace, so every machine
  // can show, and agree on, who a workspace is shared with. (env.setConfig expands
  // a bare name to {name, peers:[thisDevice]}; the note has no bare-name form.)
  await env.setConfig({ workspaces: [{ name: "Work", peers: ["boxA", "boxB"] }] });
  ok("a workspace whose peers list this device is synced here",
     JSON.stringify(W.config().syncedWorkspaces) === '["Work"]',
     JSON.stringify(W.config().syncedWorkspaces));

  await env.setConfig({ workspaces: [{ name: "Work", peers: ["boxB", "boxC"] }] });
  ok("a workspace whose peers do NOT list this device is not synced here",
     !W.config().syncedWorkspaces.includes("Work"),
     JSON.stringify(W.config().syncedWorkspaces));
  ok("...but the entry itself is untouched — it belongs to the other devices",
     JSON.stringify(W.config().workspaces) === '[{"name":"Work","peers":["boxB","boxC"]}]',
     JSON.stringify(W.config().workspaces));

  // Another device's membership is not this device's business.
  await env.setConfig({ workspaces: [{ name: "NOPE", peers: ["boxB"] }, { name: "Work", peers: ["boxA"] }] });
  ok("a workspace only another device syncs is ignored here",
     !W.config().syncedWorkspaces.includes("NOPE"),
     JSON.stringify(W.config().syncedWorkspaces));

  // --- autoPull switch -------------------------------------------------------
  await env.setConfig({ workspaces: ["Work"], autoPull: false });
  ok("\"autoPull\": false in the config note is honoured", W.config().autoPull === false);
  await env.setConfig({ workspaces: ["Work"] });
  ok("autoPull defaults back on when unset", W.config().autoPull === true);

  // --- change-event pull path -------------------------------------------------
  await W.reconcile("Work");
  await W.writeNow();
  await env.sleep(5200); // clear the per-note write throttle
  let reconciles = 0;
  const realLog = console.log;
  console.log = (...a) => { if (String(a[1] || "").startsWith("reconcile:")) reconciles++; realLog(...a); };

  // Our OWN note changing must not trigger a reconcile. Note that onCreated
  // fires before create() returns the id, so the filter cannot rely solely on
  // knowing our note ids at event time.
  const ownNote = env.noteByTitle("Work-boxA.json");
  env.fire("onChanged", ownNote.id, { content: ownNote.content });
  await env.sleep(1600);
  ok("our own note changing triggers ZERO reconciles", reconciles === 0, `reconciles=${reconciles}`);

  // An unrelated note elsewhere in the tree must be ignored too.
  await new Promise((res) => env.notes.create({ parentId: "1", title: "shopping list", type: "note", content: "milk" }, res));
  await env.sleep(1600);
  ok("an unrelated note outside the folder triggers ZERO reconciles", reconciles === 0,
     `reconciles=${reconciles}`);

  // A peer's document must pull WITHOUT a workspace switch.
  await env.putPeerDoc("Work-peerbox.json", {
    workspace: "Work",
    origin: "peerbox",
    version: 10,
    timestamp: Date.now() / 1000 + 120,
    items: [
      { type: "tab", url: "https://a.example/", title: "A", pinned: false },
      { type: "tab", url: "https://pulled.example/", title: "P", pinned: false },
    ],
  });
  await env.sleep(2500);
  console.log = realLog;
  ok("a peer's note pulls with no workspace switch",
     env.urls(WORK).includes("https://pulled.example/"), JSON.stringify(env.urls(WORK)));

  done();
})();
