// End-to-end happy path: cold start -> bootstrap -> configure -> publish ->
// pull a peer's document. This is the "does the whole thing work at all" test.
const { createEnv, ok, done } = require("./harness");

const env = createEnv({
  tabs: [
    { id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true },
    { id: 12, url: "https://b.example/", ws: 1717425015828.0, group: "g1", stackName: "Stack One" },
    { id: 13, url: "https://c.example/", ws: 1717425015828.0, group: "g1", stackName: "Stack One" },
  ],
});
const WORK = env.WS.WORK;

(async () => {
  const W = await env.boot();

  // --- bootstrap: folder + config note are created on first run -------------
  ok("device name resolved via getDefaultSessionName", W.config().device === "boxA", W.config().device);
  ok("VivaSync folder created", !!env.folder(), "id=" + env.folder()?.id);
  ok("sync.config note seeded", env.noteTitles().includes("sync.config"), JSON.stringify(env.noteTitles()));
  ok("nothing is synced until configured", W.config().syncedWorkspaces.length === 0);

  // --- configure -------------------------------------------------------------
  await env.setConfig({ workspaces: ["Work"] });
  ok("config note drives the synced list", W.config().syncedWorkspaces[0] === "Work",
     JSON.stringify(W.config().syncedWorkspaces));

  // --- snapshot: tabs and stacks interleave in tab-bar order ------------------
  const snap = await W.snapshot("Work");
  ok("snapshot has 1 top-level tab + 1 stack", snap.items.length === 2,
     JSON.stringify(snap.items.map((i) => i.type)));
  const stack = snap.items.find((i) => i.type === "stack");
  ok("stack carries its name and both members",
     stack && stack.name === "Stack One" && stack.tabs.length === 2,
     JSON.stringify(stack && stack.tabs.map((t) => t.url)));

  // --- publish ---------------------------------------------------------------
  await W.reconcile("Work");
  await W.writeNow();
  const doc = env.noteByTitle("Shared-boxA.json") || env.noteByTitle("Work-boxA.json");
  ok("own document written as <workspace>-<device>.json", !!env.noteByTitle("Work-boxA.json"),
     JSON.stringify(env.noteTitles()));
  const parsed = JSON.parse(doc.content);
  ok("payload is {workspace, items, origin, version, timestamp}",
     parsed.workspace === "Work" && Array.isArray(parsed.items) && typeof parsed.timestamp === "number" &&
       parsed.origin === "boxA" && typeof parsed.version === "number",
     Object.keys(parsed).join(","));

  // --- pull a peer's document ------------------------------------------------
  // Peer keeps tab A, drops the stack, adds a tab of its own.
  await env.putPeerDoc("Work-peerbox.json", {
    workspace: "Work",
    origin: "peerbox",
    version: 10,
    timestamp: Date.now() / 1000 + 60,
    items: [
      { type: "tab", url: "https://a.example/", title: "A", pinned: false },
      { type: "tab", url: "https://peer.example/", title: "Peer", pinned: false },
    ],
  });
  await W.reconcile("Work");
  ok("live workspace converged to the peer's document",
     JSON.stringify(env.urls(WORK)) === JSON.stringify(["https://a.example/", "https://peer.example/"]),
     JSON.stringify(env.urls(WORK)));

  ok("no errors logged during the run", env.consoleErrors.length === 0,
     env.consoleErrors.join(" | ") || "clean");
  done();
})();
