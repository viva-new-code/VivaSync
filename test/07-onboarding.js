// Adding a THIRD machine to an existing pair — R2.4's blind spot.
//
// The user creates the workspace by hand on the new machine and switches to it.
// `sync.config` has replicated (it is one small note), but the peers'
// `<ws>-<device>.json` documents have NOT arrived yet. Notes replicate as
// separate entities, so that window is ordinary rather than freak.
//
// An empty snapshot is an instruction to every peer to close the whole
// workspace, and it carries a NEWER timestamp than either peer's document — so
// publishing one here wipes the workspace on both existing machines. A device
// that has never seen a peer document cannot tell an empty workspace from one
// whose document has not replicated yet, so it must say nothing at all.
//
// This needs its own file: the mod is a one-shot IIFE guarded on
// window.__vivasyncLoaded, so a second createEnv() in the same process would boot
// against the first env's globals and prove nothing.
const { createEnv, ok, done } = require("./harness");

const env = createEnv({
  // A brand-new workspace holds exactly one empty new tab, which snapshots as
  // empty (see isBlankTabUrl) — precisely the dangerous state.
  tabs: [{ id: 90, url: "chrome://vivaldi-webui/startpage", ws: 1717425015828.0, active: true }],
});
const WORK = env.WS.WORK;

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work"] });

  ok("1. precondition: the config note is here, no peer documents are",
     env.noteTitles().includes("sync.config") &&
     !env.noteTitles().some((t) => t.startsWith("Work-")),
     JSON.stringify(env.noteTitles()));

  await W.reconcile("Work"); // the user switches to the workspace
  await W.writeNow();        // ...and any tab event lands here

  ok("2. the new device publishes NOTHING for a workspace it knows nothing about",
     !env.noteByTitle("Work-boxA.json"), JSON.stringify(env.noteTitles()));

  // The moment a peer document arrives, normal service resumes: the workspace
  // is populated from it, and what we publish back describes that.
  await env.putPeerDoc("Work-boxB.json", {
    workspace: "Work",
    origin: "boxB",
    version: 1,
    timestamp: Date.now() / 1000 + 60,
    items: [
      { type: "tab", url: "https://one.example/", title: "1", pinned: false },
      { type: "tab", url: "https://two.example/", title: "2", pinned: false },
    ],
  });
  await W.reconcile("Work");
  const real = env.urls(WORK).filter((u) => !/startpage|newtab|about:blank/.test(u));
  ok("3. once the peer document arrives, the workspace is populated from it",
     JSON.stringify(real) ===
       JSON.stringify(["https://one.example/", "https://two.example/"]),
     JSON.stringify(env.urls(WORK)));
  ok("3b. ...and the empty new tab the user may be typing in is left alone",
     env.urls(WORK).length === real.length + 1, JSON.stringify(env.urls(WORK)));

  await W.writeNow();
  // The two tabs the apply just opened are still LOADING, and a workspace with
  // a loading tab is not published at all (invariant: publishing a
  // pre-redirect URL propagates a tab that will not exist a second later) —
  // `writeNow` forces past the signature gate, not past that. The write is
  // re-armed and lands once they commit, so poll for it rather than reading the
  // note straight back.
  for (let i = 0; i < 60 && !env.noteByTitle("Work-boxA.json"); i++) await env.sleep(250);
  const own = env.noteByTitle("Work-boxA.json");
  ok("4. ...and the new device now publishes its own document",
     own && JSON.parse(own.content).items.length === 2,
     own ? own.content : "(nothing)");

  // And the legitimate case still works: the user genuinely empties a workspace
  // this device has held content in, and that MUST propagate.
  for (const t of env.TABS.filter((t) => String(Number(JSON.parse(t.vivExtData).workspaceId)) ===
                                         String(Number(WORK)))) {
    env.closeTab(t.id);
  }
  env.addTab({ url: "chrome://vivaldi-webui/startpage", ws: WORK, active: true });
  await W.writeNow();
  // The write above is re-armed behind the note throttle (invariant 3) rather
  // than queued with a stale snapshot, so wait for it to land.
  const ownItems = () => JSON.parse(env.noteByTitle("Work-boxA.json").content).items;
  for (let i = 0; i < 40 && ownItems().length; i++) await env.sleep(250);
  const emptied = JSON.parse(env.noteByTitle("Work-boxA.json").content);
  ok("5. emptying a workspace we HAVE held content in still publishes empty",
     emptied.items.length === 0, JSON.stringify(emptied.items));

  done();
})();
