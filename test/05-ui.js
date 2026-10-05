// Toolbar menu, the dialogs it opens, and the version surface.
//
// Runs against the DOM double in harness.js (opts.ui) — the settings/debug/
// about UI is built with the VISIBLE window document's createElement, which
// getViews() hands over. Everything here is what a user actually clicks:
// button -> menu -> item -> dialog.
const fs = require("fs");
const { createEnv, ok, done, MOD_PATH } = require("./harness");

const env = createEnv({
  ui: true,
  tabs: [
    { id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true },
    { id: 12, url: "https://b.example/", ws: 1717425015828.0 },
  ],
});

// The mod has no build step, so VERSION lives in exactly one place. Read it back
// out of the source: a stale copy here would defeat the point of the check.
const SRC_VERSION = /const VERSION = "([^"]+)"/.exec(fs.readFileSync(MOD_PATH, "utf8"))[1];

(async () => {
  const W = await env.boot();
  const ui = env.ui;

  // --- versioning ------------------------------------------------------------
  ok("VERSION is declared once in the mod source", !!SRC_VERSION, SRC_VERSION);
  ok("VivaSync.version exposes it", W.version === SRC_VERSION, W.version);
  const intro = await W.introspect();
  ok("introspect() reports the version", intro.version === SRC_VERSION, intro.version);
  ok("the startup log line carries name and version",
     W.log(200).some((l) => l.includes("VivaSync v" + SRC_VERSION)),
     W.log(200).slice(0, 3).join(" | "));

  // --- the toolbar button mounts and opens a MENU, not the settings dialog ---
  const btn = ui.button();
  ok("button mounted into the status bar", !!btn && btn.parentNode === ui.bar,
     btn ? btn.parentNode && btn.parentNode.className : "(no button)");
  ok("button is titled with name and version", btn.title === "VivaSync " + SRC_VERSION, btn.title);
  ok("no menu until the button is clicked", !ui.menu());

  // Seed the button's box so the menu's flip-above-the-status-bar logic is
  // exercised against a realistic position rather than the origin.
  btn._rect = { left: 1200, top: 780, right: 1220, bottom: 798, width: 20, height: 18 };

  ui.click(btn);
  const menu = ui.menu();
  ok("clicking the button opens the menu", !!menu);
  ok("no dialog opened directly", !ui.overlay());
  const labels = menu ? menu.children.map((c) => c._text) : [];
  // Debug is not among them: it is a diagnostic, offered only once the user has
  // asked for it under Settings (showDebug, off by default).
  ok("menu has Workspaces / Exceptions / Settings / About",
     JSON.stringify(labels) === JSON.stringify(["Workspaces", "Exceptions", "Settings", "About"]),
     JSON.stringify(labels));
  ok("the About entry previews the version",
     menu.children[3].title === "VivaSync " + SRC_VERSION, menu.children[3].title);

  // The status bar is in the lower half of the window, so the menu flips above it.
  ok("menu is positioned above a status-bar button",
     parseInt(menu.style.top, 10) < ui.bar._rect.top, menu.style.top);

  // --- menu dismissal --------------------------------------------------------
  // With the dismiss listeners armed — which is the only case a real user ever
  // hits. They sit in the capture phase, so they run BEFORE the button's own
  // handler; if they did not skip the anchor, this click would close the menu
  // and the button's toggle would immediately reopen it.
  await env.sleep(5);
  ui.click(btn);
  ok("clicking the button again closes the menu", !ui.menu());

  // The listeners arm on the next tick, so the click that opened the menu
  // cannot close it again on its way out.
  ui.click(btn);
  ui.click(ui.body);
  ok("the opening click does not close the menu", !!ui.menu());
  await env.sleep(5);
  ui.click(ui.body);
  ok("a click outside closes the menu", !ui.menu());

  ui.click(btn);
  await env.sleep(5);
  ui.key("Escape");
  ok("Escape closes the menu", !ui.menu());

  // --- About -----------------------------------------------------------------
  ui.click(btn);
  ui.click(ui.byText(ui.menu(), "About"));
  await env.sleep(20); // menu items run their action off a microtask
  let dlg = ui.overlay();
  ok("About opens a dialog", !!dlg);
  ok("About shows the mod name and version",
     dlg && dlg.textContent.includes("VivaSync") && dlg.textContent.includes("Version " + SRC_VERSION),
     dlg && dlg.textContent.slice(0, 80));
  ok("About names this device", dlg && dlg.textContent.includes("boxA"));
  ok("the menu closed when the item was chosen", !ui.menu());
  ui.key("Escape");
  ok("Escape closes the About dialog", !ui.overlay());

  // --- Workspaces (openSettings) ---------------------------------------------
  ui.click(btn);
  ui.click(ui.byText(ui.menu(), "Workspaces"));
  await env.sleep(50); // openSettings awaits the workspace list
  dlg = ui.overlay();
  ok("Workspaces opens the workspace picker", !!dlg && dlg.textContent.includes("workspaces to synchronize"));
  ok("the picker lists the workspaces", dlg.textContent.includes("Work") && dlg.textContent.includes("Personal"));

  // Select "Work" and save — the dialog is the only way a user configures the mod.
  // Rows carry data-ws: the label is two lines (name + "Synced on ..."),
  // so the name span's parent is the label, not the clickable row.
  const workRow = dlg._find((e) => e["data-ws"] === "Work");
  ui.click(workRow);
  const save = ui.buttons(dlg).find((b) => b._text === "Save");
  ok("the picker has a Save button", !!save);
  ui.click(save);
  // The config note was written at boot, so this save sleeps out the remainder
  // of MIN_NOTE_WRITE_GAP_MS inside NOTES.write before it lands.
  await env.sleep(5500);
  ok("the row names the devices the workspace is shared with",
     workRow.textContent.includes("Synced on: boxA"), workRow.textContent);
  ok("saving writes the selection to the config note",
     JSON.stringify(W.config().syncedWorkspaces) === JSON.stringify(["Work"]),
     JSON.stringify(W.config().syncedWorkspaces));
  ok("the dialog closed on save", !ui.overlay());

  // --- Exceptions ------------------------------------------------------------
  // The "exceptions" list of sync.config: address prefixes never synchronized.
  // Rows are text inputs; Add appends one, ✕ removes one, Save writes the list.
  ui.click(btn);
  ui.click(ui.byText(ui.menu(), "Exceptions"));
  await env.sleep(50); // openExceptions re-reads the config note first
  dlg = ui.overlay();
  ok("Exceptions opens the exclusion list", !!dlg && dlg.textContent.includes("addresses excluded from sync"));
  ok("an empty list says so", dlg.textContent.includes("No exceptions"));
  const addBtn = ui.buttons(dlg).find((b) => b._text === "Add");
  ok("the list has an Add button", !!addBtn);
  ui.click(addBtn);
  ui.click(addBtn);
  let inputs = dlg._all((e) => e.tagName === "INPUT");
  ok("Add appends an input row each time", inputs.length === 2, String(inputs.length));
  inputs[0].value = "  www.google.com/maps ";
  inputs[1].value = "https://mail.example/";
  const rmBtns = ui.buttons(dlg).filter((b) => b._text === "✕");
  ui.click(rmBtns[1]);
  inputs = dlg._all((e) => e.tagName === "INPUT");
  ok("✕ removes its row", inputs.length === 1 && inputs[0].value.trim() === "www.google.com/maps");
  ui.click(ui.buttons(dlg).find((b) => b._text === "Save"));
  // sync.config was just written by the Workspaces save, so this one sleeps
  // out the per-note throttle before it lands.
  await env.sleep(5500);
  ok("the dialog closed on save", !ui.overlay());
  ok("saving writes the trimmed list to the config",
     JSON.stringify(W.config().exceptions) === JSON.stringify(["www.google.com/maps"]),
     JSON.stringify(W.config().exceptions));
  const cfgNote = JSON.parse(env.noteByTitle("sync.config").content);
  ok("the note keeps the workspaces next to the exceptions",
     JSON.stringify(cfgNote.exceptions) === JSON.stringify(["www.google.com/maps"]) &&
       cfgNote.workspaces.length === 1 && cfgNote.workspaces[0].name === "Work",
     JSON.stringify(cfgNote));
  ui.click(btn);
  ui.click(ui.byText(ui.menu(), "Exceptions"));
  await env.sleep(50);
  dlg = ui.overlay();
  inputs = dlg._all((e) => e.tagName === "INPUT");
  ok("reopening lists the saved exception", inputs.length === 1 && inputs[0].value === "www.google.com/maps",
     JSON.stringify(inputs.map((i) => i.value)));
  ok("...and the empty-list note is hidden", dlg._find((e) => e._text.startsWith("No exceptions")).style.display === "none");
  ui.key("Escape");
  ok("Escape closes the Exceptions dialog", !ui.overlay());

  // --- Debug -----------------------------------------------------------------
  // It takes the switch to reach it from the menu at all (see 17-settings.js for
  // the dialog that sets it); everything below is the window itself.
  await env.setConfig({ workspaces: ["Work"], settings: { showDebug: true } });
  ui.click(btn);
  const dbgLabels = ui.menu().children.map((c) => c._text);
  ok("showDebug puts Debug back in the menu, between Settings and About",
     JSON.stringify(dbgLabels) === JSON.stringify(["Workspaces", "Exceptions", "Settings", "Debug", "About"]),
     JSON.stringify(dbgLabels));
  ui.click(ui.byText(ui.menu(), "Debug"));
  await env.sleep(150); // collectStatus() hits the notes API
  dlg = ui.overlay();
  ok("Debug opens a dialog", !!dlg);
  const text = dlg ? dlg.textContent : "";
  ok("Debug reports the engine row with the version", text.includes("VivaSync v" + SRC_VERSION), "");
  ok("Debug reports the transport row", text.includes("A. engine") && text.includes("B. transport"), "");
  ok("Debug reflects the configured workspaces",
     text.includes("C. config") && text.includes("1 workspace(s) synced: Work"), "");
  ok("Debug lists the notes in the folder", text.includes("note sync.config"), "");
  ok("Debug shows the log tail", text.includes("[") && dlg._find((e) => e.tagName === "PRE") !== null, "");

  // The report rows are a disclosure: collapsed on open, the counts line above
  // them is the toggle. They are still in textContent while collapsed (the
  // block is display:none, not absent), which is why the assertions above hold
  // either way — what is pinned here is the display and the toggling.
  const report = dlg._find((e) => e.id === "vivasync-debug-report");
  const reportToggle = dlg._find((e) => e.id === "vivasync-debug-report-toggle");
  ok("the report block is collapsed on open",
     !!report && report.style.display === "none", report && report.style.display);
  ok("the counts line says how many rows are collapsed",
     !!reportToggle && /\d+ report row\(s\)/.test(reportToggle._text), reportToggle && reportToggle._text);
  ui.click(reportToggle);
  ok("clicking the counts line expands the report", report.style.display !== "none", report.style.display);
  // A refresh repaints the rows; it must not fold the block back up under the
  // reader — the reason to refresh is usually to watch a row change.
  ui.click(ui.buttons(dlg).find((b) => b._text === "Refresh"));
  await env.sleep(1300); // long enough for the button to flash "ok" and go back
  ok("refreshing keeps the report expanded", report.style.display !== "none", report.style.display);
  ui.click(reportToggle);
  ok("clicking it again collapses the report", report.style.display === "none", report.style.display);

  // The buttons along the top are the reason to open this window at all.
  const tools = ui.buttons(dlg).map((b) => b._text);
  for (const label of ["Refresh", "Write now", "Reconcile active", "Reload config", "Clear churn", "Copy report", "Copy log"]) {
    ok(`Debug has a "${label}" button`, tools.includes(label), JSON.stringify(tools));
  }

  const copyReport = ui.buttons(dlg).find((b) => b._text === "Copy report");
  ui.click(copyReport);
  await env.sleep(50);
  ok("Copy report puts the rows on the clipboard",
     (ui.clipboard.text || "").includes("VivaSync v" + SRC_VERSION) &&
     (ui.clipboard.text || "").includes("B. transport"),
     (ui.clipboard.text || "").slice(0, 60));
  ok("the report includes the log tail", (ui.clipboard.text || "").includes("--- log tail ---"));

  // "Write now" is writeChanged(true), so R2.4 still applies: a workspace is
  // only serialized once reconcile() has marked it opened this session. Open it
  // the way a workspace switch would, then check the button actually publishes.
  await W.reconcile("Work");
  const writeNow = ui.buttons(dlg).find((b) => b._text === "Write now");
  ui.click(writeNow);
  await env.sleep(500);
  ok("Write now publishes the workspace document",
     env.noteTitles().includes("Work-boxA.json"), JSON.stringify(env.noteTitles()));

  ui.key("Escape");
  ok("Escape closes the Debug window", !ui.overlay());

  // The log poll must not outlive the window — it would tick for the rest of the
  // session, which is exactly the polling this mod is built to avoid.
  const before = process._getActiveHandles().length;
  ui.click(btn);
  ui.click(ui.byText(ui.menu(), "Debug"));
  await env.sleep(150);
  ui.key("Escape");
  await env.sleep(50);
  ok("closing the Debug window clears its refresh timer",
     process._getActiveHandles().length <= before, `${before} -> ${process._getActiveHandles().length}`);

  // --- degraded rendering ----------------------------------------------------
  // The Debug window has to render when things are broken; that is when it is
  // opened. A status collection that throws on a dead transport is useless.
  const rows = await W.status();
  ok("status() returns rows for every section",
     ["A. engine", "B. transport", "C. config", "D. active workspace", "E. materialized", "F. churn", "G. windows"]
       .every((k) => rows.some((r) => r.key === k)),
     JSON.stringify(rows.map((r) => r.key)));
  ok("every row carries a known status",
     rows.every((r) => ["PASS", "FAIL", "WARN", "INFO"].includes(r.status)),
     JSON.stringify(rows.map((r) => r.status)));
  ok("the windows row sees the mounted button",
     rows.find((r) => r.key === "G. windows").detail.includes("button=yes"),
     rows.find((r) => r.key === "G. windows").detail);

  ok("no errors logged while driving the UI",
     env.consoleErrors.length === 0, env.consoleErrors.join(" | "));

  done();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
