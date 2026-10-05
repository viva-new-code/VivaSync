// The transport must never leave two notes with one title — and, since Vivaldi
// Sync can produce exactly that, must clean it up when it finds it.
//
// The symptom: copies of <workspace>-<device>.json multiplying, or a second
// sync.config appearing. Every reader of the folder then picks one copy at
// random and the whole engine stops making sense. Three ways a copy comes into
// being, each pinned here:
//
//   1. getTree() reports a note's content as "" (it does not reliably
//      populate `content`); if "unparsable" read the same as "missing",
//      readConfig() would seed a NEW sync.config next to the existing one.
//      Absent and unreadable are different answers, and the empty string
//      falls back to notes.get() like a missing field does.
//   2. A note's id changes under the mod (a sync merge replaces the entity),
//      so the cached id's update fails; recreating the note on that failure
//      would add a copy. Instead: re-resolve the title, retry, create only
//      when the title is really gone.
//   3. Two copies already exist (from either of the above, on any device):
//      the listing keeps exactly one, chosen from CONTENT so every device
//      keeps the same one, and removes the rest.
const { createEnv, ok, done } = require("./harness");

const env = createEnv({
  tabs: [{ id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true }],
});
const WORK = env.WS.WORK;
const item = (u) => ({ type: "tab", url: u, title: u, pinned: false });
const titled = (t) => env.noteTitles().filter((x) => x === t).length;
const rawCreate = (title, content) =>
  new Promise((res) =>
    env.notes.create({ parentId: env.folder().id, title, type: "note", content }, res));

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work"] });
  await W.reconcile("Work");
  await W.writeNow();
  ok("pre. one sync.config, one own document",
     titled("sync.config") === 1 && titled("Work-boxA.json") === 1, JSON.stringify(env.noteTitles()));

  // ===========================================================================
  // 1. A config note the tree shows as empty is not a missing one.
  // ===========================================================================
  env.hideTreeContent(env.noteByTitle("sync.config").id);
  const cfg = await W.reloadConfig();
  ok("1. reloadConfig with an empty-content tree does NOT seed a second sync.config",
     titled("sync.config") === 1, JSON.stringify(env.noteTitles()));
  ok("1b. ...and still read the real content through notes.get()",
     cfg.syncedWorkspaces.includes("Work"), JSON.stringify(cfg));
  env.hideTreeContent(env.noteByTitle("sync.config").id, false);

  // Same for a document note: an empty tree content must not stop the write
  // from finding it and updating it in place.
  env.hideTreeContent(env.noteByTitle("Work-boxA.json").id);
  env.addTab({ id: 12, url: "https://b.example/", ws: WORK });
  await env.sleep(5200);
  await W.writeNow();
  ok("1c. a write updates the existing document even when the tree hides its content",
     titled("Work-boxA.json") === 1 &&
       JSON.parse(env.noteByTitle("Work-boxA.json").content).items.length === 2,
     JSON.stringify(env.noteTitles()));
  env.hideTreeContent(env.noteByTitle("Work-boxA.json").id, false);

  // ===========================================================================
  // 2. The note's id changes under the mod: update fails, the title is re-resolved.
  // ===========================================================================
  const oldNote = env.noteByTitle("Work-boxA.json");
  await new Promise((res) => env.notes.remove(oldNote.id, res));
  await rawCreate("Work-boxA.json", oldNote.content); // same title, new id
  env.addTab({ id: 13, url: "https://c.example/", ws: WORK });
  await env.sleep(5200);
  await W.writeNow();
  const after = env.noteByTitle("Work-boxA.json");
  ok("2. a failed update re-resolves the title and updates the replacement, creating nothing",
     titled("Work-boxA.json") === 1 && after && String(after.id) !== String(oldNote.id) &&
       JSON.parse(after.content).items.length === 3,
     `${titled("Work-boxA.json")} copies; ids ${oldNote.id} -> ${after && after.id}`);

  // ===========================================================================
  // 3. Existing duplicates are collapsed to one, chosen from content.
  // ===========================================================================
  const older = JSON.stringify({ workspace: "Work", origin: "boxB", version: 3,
    timestamp: Date.now() / 1000 - 60, items: [item("https://older.example/")] });
  const newer = JSON.stringify({ workspace: "Work", origin: "boxB", version: 4,
    timestamp: Date.now() / 1000 + 60, items: [item("https://newer.example/")] });
  await rawCreate("Work-boxB.json", newer);
  await rawCreate("Work-boxB.json", older);
  await rawCreate("Work-boxB.json", older);
  ok("3pre. three copies of the peer's document are in the folder",
     titled("Work-boxB.json") === 3, JSON.stringify(env.noteTitles()));
  await W.reconcile("Work");
  ok("3. the listing keeps exactly one copy",
     titled("Work-boxB.json") === 1, JSON.stringify(env.noteTitles()));
  ok("3b. ...the one with the highest provenance",
     JSON.parse(env.noteByTitle("Work-boxB.json").content).version === 4,
     env.noteByTitle("Work-boxB.json").content);
  ok("3c. ...and that is the one that was applied",
     env.urls(WORK).includes("https://newer.example/") && !env.urls(WORK).includes("https://older.example/"),
     JSON.stringify(env.urls(WORK)));

  // Two identical copies: content ties, one still survives (either — they are
  // the same document) and nothing else in the folder is touched.
  await rawCreate("sync.config", env.noteByTitle("sync.config").content);
  await W.reloadConfig();
  ok("3d. a duplicated sync.config collapses to one",
     titled("sync.config") === 1 && titled("Work-boxA.json") === 1 && titled("Work-boxB.json") === 1,
     JSON.stringify(env.noteTitles()));

  ok("no errors logged during the run", env.consoleErrors.length === 0,
     env.consoleErrors.join(" | ") || "clean");
  done();
})();
