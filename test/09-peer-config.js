// R1.3 — per-device membership in the SHARED config note.
//
// Which devices synchronize a workspace is part of the one `sync.config` note:
// each entry carries a `peers` list and a device syncs a workspace only when it
// names itself in it, so every machine can see, and agree on, who a workspace
// is shared with, and unticking a workspace over there is visible over here.
//
// So the document is edited by several devices at once, and this suite covers
// the two things that go wrong with that: reading your own membership out of
// it, and editing ONLY your own membership into it.
const { createEnv, ok, done } = require("./harness");

// A folder that already exists, as it does on every device but the first:
// - "Work" is synced by boxB alone — this device is configured out of it
// - "Personal" is synced by this device
// - "Elsewhere" does not exist on this machine at all — the dialog cannot show
//   it, so nothing this device saves may touch it
// - "Ghost" is the same, except that THIS device is one of its peers: a synced
//   workspace can be absent from Vivaldi's workspace list (it lives on another
//   machine, or the list has not been populated yet), and a save driven by a
//   list that does not mention it must not quietly resign this device from it
const seeded = {
  id: "800", title: "VivaSync", type: "folder", parentId: "1",
  children: [
    { id: "801", title: "sync.config", type: "note", parentId: "800",
      content: JSON.stringify({
        workspaces: [
          { name: "Work", peers: ["boxB"] },
          { name: "Personal", peers: ["boxA"] },
          { name: "Elsewhere", peers: ["boxB", "boxC"] },
          { name: "Ghost", peers: ["boxA", "boxB"] },
        ],
      }) },
  ],
};

const env = createEnv({
  ui: true,
  rootChildren: [seeded],
  tabs: [
    { id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true },
    { id: 12, url: "https://p.example/", ws: 1783536779848.0 },
  ],
});

const cfgEntries = () => JSON.stringify(global.VivaSync.config().workspaces);
const entry = (name) =>
  global.VivaSync.config().workspaces.find((e) => e && e.name === name);

(async () => {
  const W = await env.boot();
  const ui = env.ui;

  // --- 1. this device reads its own membership out of the shared document ---
  ok("1. the pre-existing folder was adopted, not duplicated",
     env.folder() && env.folder().id === "800", "id=" + (env.folder() || {}).id);
  ok("1b. only the entries naming this device are synced here",
     JSON.stringify(W.config().syncedWorkspaces) === '["Personal","Ghost"]',
     JSON.stringify(W.config().syncedWorkspaces));
  ok("1c. the other devices' entries are readable in full",
     JSON.stringify(entry("Work")) === '{"name":"Work","peers":["boxB"]}' &&
       JSON.stringify(entry("Elsewhere")) === '{"name":"Elsewhere","peers":["boxB","boxC"]}',
     cfgEntries());

  // --- 2. the dialog shows who each workspace is shared with -----------------
  await W.settings();
  await env.sleep(60); // openSettings awaits the workspace list
  let dlg = ui.overlay();
  const rowFor = (n) => dlg._find((e) => e["data-ws"] === n);
  ok("2. a workspace another device syncs names that device",
     rowFor("Work").textContent.includes("Synced on: boxB"), rowFor("Work").textContent);
  ok("2b. a workspace this device syncs names this device",
     rowFor("Personal").textContent.includes("Synced on: boxA"), rowFor("Personal").textContent);
  ok("2c. a workspace that is not on this machine is not offered",
     !rowFor("Elsewhere"), "Elsewhere row present");

  // Ticking adds this device to the line; unticking removes it. The line is the
  // only feedback that the checkbox edits a SHARED list rather than a local one.
  ui.click(rowFor("Work"));
  ui.click(rowFor("Personal"));
  ok("2d. ticking appends this device to the shared list",
     rowFor("Work").textContent.includes("Synced on: boxB, boxA"), rowFor("Work").textContent);
  ok("2e. unticking drops this device from the line",
     !rowFor("Personal").textContent.includes("Synced on"), rowFor("Personal").textContent);

  // --- 3. saving edits THIS device's membership and nothing else -------------
  ui.click(ui.buttons(dlg).find((b) => b._text === "Save"));
  await env.sleep(5500); // MIN_NOTE_WRITE_GAP_MS since the boot-time config write
  ok("3. this device joined the workspace it ticked",
     JSON.stringify(entry("Work")) === '{"name":"Work","peers":["boxB","boxA"]}', cfgEntries());
  ok("3b. an entry left with no devices at all is dropped",
     !entry("Personal"), cfgEntries());
  ok("3c. a workspace this machine does not have is untouched by its save",
     JSON.stringify(entry("Elsewhere")) === '{"name":"Elsewhere","peers":["boxB","boxC"]}',
     cfgEntries());
  ok("3c2. ...including one this device syncs but the dialog could not list",
     JSON.stringify(entry("Ghost")) === '{"name":"Ghost","peers":["boxA","boxB"]}',
     cfgEntries());
  ok("3d. the local view follows the document",
     JSON.stringify(W.config().syncedWorkspaces) === '["Work","Ghost"]',
     JSON.stringify(W.config().syncedWorkspaces));

  done();
})();
