// The tunables — SETTINGS_DEFAULTS in the source, overridden per install by the
// "settings" object of the sync.config note.
//
// The point of the object is that the note wins and the source is only a
// fallback, so what is pinned here is: a value from the note is in force, a key
// the note omits keeps its default, junk is refused in favour of the default
// (loudly — a garbage debounce looks exactly like a mod that has hung), and the
// engine reads every one of them at the point of use, so an edit to the note
// takes effect without a restart. The last part is what a "const copied into a
// local" would quietly break; §7 and §8 are its two witnesses.
//
// Own file: the mod is a one-shot IIFE guarded on window.__vivasyncLoaded.
const { createEnv, ok, done, WS } = require("./harness");

const env = createEnv({
  ui: true,
  workspaces: [{ id: WS.WORK, name: "Work" }, { id: WS.PERSONAL, name: "Personal" }],
  tabs: [{ id: 90, url: "https://a.example/", ws: WS.WORK, active: true }],
});

const cfgNote = () => JSON.parse(env.noteByTitle("sync.config").content);
const doc = () => {
  const n = env.noteByTitle("Work-boxA.json");
  return n ? JSON.parse(n.content) : null;
};

// The warnings are half of the contract: a refused setting must say so.
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.map(String).join(" ")); realWarn(...a); };
const warnedAbout = (needle) => warnings.some((w) => w.includes(needle));

(async () => {
  const W = await env.boot();

  // --- 1. the defaults are what runs when the note says nothing -------------
  await env.setConfig({ workspaces: ["Work"] });
  const defaults = { ...W.config().settings };
  ok("1a. every tunable has a value with no settings in the note",
     ["writeDebounceMs", "switchDebounceMs", "minNoteWriteGapMs", "remoteDebounceMs",
      "groupSettleRetryMs", "urlSettleMs", "maxSettleHoldMs", "logMax", "logLineMax"]
       .every((k) => typeof defaults[k] === "number"),
     JSON.stringify(defaults));
  ok("1b. and nothing is reported as tuned", W.config().tuned.length === 0,
     JSON.stringify(W.config().tuned));

  // --- 2. a value in the note wins; the rest keep their defaults ------------
  await env.setConfig({ workspaces: ["Work"], settings: { urlSettleMs: 1234, logMax: 7 } });
  ok("2a. a setting from the note is in force",
     W.config().settings.urlSettleMs === 1234 && W.config().settings.logMax === 7,
     JSON.stringify(W.config().settings));
  ok("2b. a key the note does not mention keeps its default",
     W.config().settings.minNoteWriteGapMs === defaults.minNoteWriteGapMs,
     String(W.config().settings.minNoteWriteGapMs));
  ok("2c. the changed keys are reported as tuned",
     JSON.stringify(W.config().tuned.sort()) === JSON.stringify(["logMax=7", "urlSettleMs=1234"]),
     JSON.stringify(W.config().tuned));
  const engineRow = (await W.status()).find((r) => r.key === "A. engine").detail;
  ok("2d. the Debug window's engine row says what is not stock",
     engineRow.includes("urlSettleMs=1234") && engineRow.includes("logMax=7"), engineRow);

  // --- 3. junk is refused in favour of the default, and says so -------------
  warnings.length = 0;
  await env.setConfig({ workspaces: ["Work"], settings: { urlSettleMs: "quickly", logMax: -5 } });
  ok("3a. a non-number falls back to the default",
     W.config().settings.urlSettleMs === defaults.urlSettleMs,
     String(W.config().settings.urlSettleMs));
  ok("3b. a value below the floor for its key falls back too",
     W.config().settings.logMax === defaults.logMax, String(W.config().settings.logMax));
  ok("3c. both refusals are warned about",
     warnedAbout("settings.urlSettleMs") && warnedAbout("settings.logMax"),
     JSON.stringify(warnings));
  // ...but once per offending value, not once per read: the note is re-read on
  // every dialog open and every peer edit, and a line each time would bury the
  // log the Debug window shows.
  warnings.length = 0;
  await env.setConfig({ workspaces: ["Work"], settings: { urlSettleMs: "quickly", logMax: -5 } });
  ok("3d. the same junk on the next read is not warned about again",
     warnings.length === 0, JSON.stringify(warnings));
  await env.setConfig({ workspaces: ["Work"], settings: { urlSettleMs: 2000 } });
  warnings.length = 0;
  await env.setConfig({ workspaces: ["Work"], settings: { urlSettleMs: "quickly" } });
  ok("3e. ...but it is again once the value has been fixed in between",
     warnedAbout("settings.urlSettleMs"), JSON.stringify(warnings));

  warnings.length = 0;
  await env.setConfig({ workspaces: ["Work"], settings: { urlSettleMz: 100 } });
  ok("4a. an unknown setting is ignored, not stored",
     W.config().settings.urlSettleMz === undefined &&
       W.config().settings.urlSettleMs === defaults.urlSettleMs,
     JSON.stringify(W.config().settings));
  ok("4b. ...and named in a warning — a typo is otherwise silent",
     warnedAbout("urlSettleMz"), JSON.stringify(warnings));

  // A debounce of 0 is meaningful ("do not coalesce"), so 0 is a value, not junk.
  await env.setConfig({ workspaces: ["Work"], settings: { writeDebounceMs: 0 } });
  ok("4c. zero is a legitimate debounce, not a refused value",
     W.config().settings.writeDebounceMs === 0, String(W.config().settings.writeDebounceMs));

  // --- 5. "urlSettleMs" is also accepted at the top level -------------------
  await env.setConfig({ workspaces: ["Work"], urlSettleMs: 999 });
  ok("5a. a top-level urlSettleMs is honoured",
     W.config().settings.urlSettleMs === 999, String(W.config().settings.urlSettleMs));
  await env.setConfig({ workspaces: ["Work"], urlSettleMs: 999, settings: { urlSettleMs: 111 } });
  ok("5b. settings wins when both name it",
     W.config().settings.urlSettleMs === 111, String(W.config().settings.urlSettleMs));

  // --- 6. dropping the object goes back to the defaults ---------------------
  await env.setConfig({ workspaces: ["Work"] });
  ok("6. removing the settings object restores every default",
     JSON.stringify(W.config().settings) === JSON.stringify(defaults),
     JSON.stringify(W.config().settings));

  // --- 7. the log buffer is sized at the point of use -----------------------
  // Not at load: the tap on console.* runs before any note has been read, so a
  // captured constant here would mean the note could never size the buffer.
  await env.setConfig({ workspaces: ["Work"], settings: { logMax: 4, logLineMax: 120 } });
  for (let i = 0; i < 9; i++) console.info("[vivasync]", "settings suite line " + i);
  const tail = W.log(99);
  ok("7a. logMax from the note trims the ring buffer", tail.length === 4, String(tail.length));
  ok("7b. ...keeping the newest lines", tail[tail.length - 1].includes("line 8"), tail.join(" | "));
  console.info("[vivasync]", "x".repeat(400));
  const long = W.log(1)[0];
  ok("7c. logLineMax from the note truncates a long line",
     long.includes("…[truncated]") && long.length < 200, String(long.length));

  // --- 8. the note-write throttle reads its floor per write -----------------
  // minNoteWriteGapMs is the one tunable with teeth: it decides whether a write
  // armed now publishes now (invariant 3 re-arms rather than queues).
  await env.setConfig({ workspaces: ["Work"], settings: { minNoteWriteGapMs: 0 } });
  await W.reconcile("Work");
  await W.writeNow();
  ok("8a. precondition: the workspace is published", !!doc(), JSON.stringify(env.noteTitles()));

  env.addTab({ id: 91, url: "https://b.example/", ws: WS.WORK });
  await W.writeNow();
  ok("8b. with a zero gap the very next write lands immediately",
     (doc().items || []).some((i) => i.url === "https://b.example/"),
     JSON.stringify((doc().items || []).map((i) => i.url)));

  // The control: back at the default floor the same second write is deferred,
  // not queued — the state it would have published is already stale.
  await env.setConfig({ workspaces: ["Work"] });
  await W.writeNow();
  const before = doc().timestamp;
  env.addTab({ id: 92, url: "https://c.example/", ws: WS.WORK });
  await W.writeNow();
  ok("8c. at the default floor that write is held back instead",
     !(doc().items || []).some((i) => i.url === "https://c.example/") && doc().timestamp === before,
     JSON.stringify((doc().items || []).map((i) => i.url)));
  await env.sleep(5400); // the re-armed write, once the floor has passed
  ok("8d. ...and lands once the floor has passed",
     (doc().items || []).some((i) => i.url === "https://c.example/"),
     JSON.stringify((doc().items || []).map((i) => i.url)));

  // --- 9. saving from a dialog carries the settings through -----------------
  // writeConfig/writeExceptions re-read the note and keep every key they do not
  // own; a Save that dropped the settings would silently un-tune every device.
  await env.setConfig({ workspaces: ["Work"], settings: { minNoteWriteGapMs: 0, urlSettleMs: 4321 } });
  await global.VivaSync.settings();
  await env.sleep(60); // openSettings awaits the workspace list
  const wsDlg = env.ui.overlay();
  env.ui.click(wsDlg._find((e) => e["data-ws"] === "Personal"));
  env.ui.click(env.ui.buttons(wsDlg).find((b) => b._text === "Save"));
  await env.sleep(300);
  ok("9a. the Workspaces dialog's Save keeps the settings object",
     JSON.stringify(cfgNote().settings) === JSON.stringify({ minNoteWriteGapMs: 0, urlSettleMs: 4321 }),
     JSON.stringify(cfgNote().settings));
  ok("9b. ...and the tick it was saving for took effect",
     W.config().syncedWorkspaces.includes("Personal"),
     JSON.stringify(W.config().syncedWorkspaces));
  ok("9c. the settings are still in force after that write",
     W.config().settings.urlSettleMs === 4321, String(W.config().settings.urlSettleMs));

  // --- 10. the session override still works ---------------------------------
  W.urlSettle(77);
  ok("10a. VivaSync.urlSettle() overrides for the session",
     W.config().settings.urlSettleMs === 77, String(W.config().settings.urlSettleMs));
  W.tunables({ remoteDebounceMs: 42 });
  ok("10b. VivaSync.tunables() sets any of them",
     W.config().settings.remoteDebounceMs === 42, String(W.config().settings.remoteDebounceMs));
  await env.setConfig({ workspaces: ["Work"] });
  ok("10c. a config reload takes the session back to what the note says",
     W.config().settings.urlSettleMs === defaults.urlSettleMs &&
       W.config().settings.remoteDebounceMs === defaults.remoteDebounceMs,
     JSON.stringify(W.config().tuned));

  // --- 11-17. the Settings dialog ------------------------------------------
  // The dialog is the only way most users will ever touch these, so what it
  // writes matters as much as what the engine reads: the note is meant to stay
  // a short list of "what this install changed", not a dump of every key.
  const openTuning = async () => {
    await global.VivaSync.tuning();
    await env.sleep(60); // it reloads the config first
    return env.ui.overlay();
  };
  const field = (dlg, key) => dlg._find((e) => e["data-setting"] === key);
  const clickSave = async (dlg) => {
    env.ui.click(env.ui.buttons(dlg).find((b) => b._text === "Save"));
    await env.sleep(300); // Save closes, then writes
  };
  // A zero write gap throughout, or every save in this section would sleep out
  // the note throttle (§8 is where that floor is exercised on purpose).
  const FAST = { minNoteWriteGapMs: 0 };

  await env.setConfig({ workspaces: ["Work"], settings: { ...FAST, urlSettleMs: 4000 } });
  let dlg = await openTuning();
  ok("11a. the Settings dialog opens", !!dlg);
  ok("11b. a field carries the value from the note", field(dlg, "urlSettleMs").value === "4000",
     field(dlg, "urlSettleMs").value);
  ok("11c. ...and an untouched one the code default",
     field(dlg, "writeDebounceMs").value === String(defaults.writeDebounceMs),
     field(dlg, "writeDebounceMs").value);
  ok("11d. the log-buffer sizes are not offered — they change nothing a user sees",
     !field(dlg, "logMax") && !field(dlg, "logLineMax"));
  ok("11e. every field carries a tooltip that says which way to move it",
     ["urlSettleMs", "writeDebounceMs", "groupSettleRetryMs"].every((k) => {
       const t = field(dlg, k).title || "";
       return t.includes("INCREASE") && t.includes("DECREASE");
     }));
  // The switch is the whole row (box + label), with one click listener on it —
  // a click on either child reaches it by bubbling in the browser.
  const dbgRow = field(dlg, "showDebug");
  const tick = () => dbgRow.children[0];
  ok("11f. the Debug switch is off and carries its tooltip",
     tick().checked === false && dbgRow.title.startsWith("Turns on an optional Debug UI"),
     dbgRow.title);
  // It has to SHOW its state, not merely hold it: a native
  // <input type=checkbox> holds `checked` perfectly and renders as an empty
  // square under Vivaldi's window.html CSS.
  // The tick box is drawn by the mod (mkToggle), so the glyph, the fill and the
  // aria state are what to assert.
  ok("11g. an off switch is drawn empty",
     tick().textContent === "" && tick()["aria-checked"] === "false",
     JSON.stringify([tick().textContent, tick()["aria-checked"]]));
  env.ui.click(dbgRow);
  ok("11h. clicking it draws the tick",
     tick().textContent === "✓" && tick()["aria-checked"] === "true" && tick().checked === true,
     JSON.stringify([tick().textContent, tick()["aria-checked"], tick().checked]));
  ok("11i. ...and the box is filled, not just marked",
     tick().style.background.includes("colorHighlightBg"), tick().style.background);
  env.ui.click(dbgRow);
  ok("11j. clicking it again clears both",
     tick().textContent === "" && tick().checked === false,
     JSON.stringify([tick().textContent, tick().checked]));
  ok("11k. the box and the label carry no listener of their own — one click, one flip",
     !(tick()._handlers.click || []).length && !tick().onclick,
     JSON.stringify(Object.keys(tick()._handlers)));

  field(dlg, "writeDebounceMs").value = "800";
  await clickSave(dlg);
  ok("12a. a changed value is written into the settings object",
     cfgNote().settings.writeDebounceMs === 800, JSON.stringify(cfgNote().settings));
  ok("12b. ...and is in force at once", W.config().settings.writeDebounceMs === 800,
     String(W.config().settings.writeDebounceMs));
  ok("12c. the values it did not change are left where they were",
     cfgNote().settings.urlSettleMs === 4000, JSON.stringify(cfgNote().settings));

  dlg = await openTuning();
  field(dlg, "urlSettleMs").value = String(defaults.urlSettleMs);
  await clickSave(dlg);
  ok("13a. a value set back to the default is REMOVED, not written",
     !("urlSettleMs" in cfgNote().settings), JSON.stringify(cfgNote().settings));
  ok("13b. ...and the engine is back on the default",
     W.config().settings.urlSettleMs === defaults.urlSettleMs,
     String(W.config().settings.urlSettleMs));

  dlg = await openTuning();
  field(dlg, "writeDebounceMs").value = "   ";
  await clickSave(dlg);
  ok("14. an empty field means the default too, so that key leaves the note",
     !("writeDebounceMs" in cfgNote().settings) &&
       W.config().settings.writeDebounceMs === defaults.writeDebounceMs,
     JSON.stringify(cfgNote().settings));

  // A typo must not close the dialog: a save that dropped the field being
  // edited and kept everything else is the worst of both.
  const beforeBad = JSON.stringify(cfgNote());
  dlg = await openTuning();
  field(dlg, "remoteDebounceMs").value = "soon";
  env.ui.click(env.ui.buttons(dlg).find((b) => b._text === "Save"));
  await env.sleep(200);
  ok("15a. a value that is not a number keeps the dialog open", !!env.ui.overlay());
  ok("15b. ...with a message naming the field",
     (env.ui.overlay().textContent || "").includes("Delay before applying other devices"),
     (env.ui.overlay().textContent || "").slice(-160));
  ok("15c. ...and nothing is written", JSON.stringify(cfgNote()) === beforeBad);
  env.ui.key("Escape");

  // showDebug end to end: the switch decides whether the menu offers Debug.
  dlg = await openTuning();
  env.ui.click(field(dlg, "showDebug"));
  await clickSave(dlg);
  ok("16a. ticking the switch writes it", cfgNote().settings.showDebug === true,
     JSON.stringify(cfgNote().settings));
  env.ui.click(env.ui.button());
  ok("16b. ...and the menu now offers Debug",
     env.ui.menu().children.map((c) => c._text).includes("Debug"),
     JSON.stringify(env.ui.menu().children.map((c) => c._text)));
  env.ui.key("Escape");

  dlg = await openTuning();
  env.ui.click(field(dlg, "showDebug"));
  await clickSave(dlg);
  ok("16c. unticking it removes the key again — false is the default",
     !("showDebug" in (cfgNote().settings || {})), JSON.stringify(cfgNote().settings));
  env.ui.click(env.ui.button());
  ok("16d. ...and Debug is gone from the menu",
     !env.ui.menu().children.map((c) => c._text).includes("Debug"),
     JSON.stringify(env.ui.menu().children.map((c) => c._text)));
  env.ui.key("Escape");

  // The top-level spelling has to go when the dialog saves, or it would
  // take effect again the moment the object stops naming urlSettleMs.
  await env.setConfig({ workspaces: ["Work"], urlSettleMs: 999, settings: { ...FAST } });
  dlg = await openTuning();
  ok("17a. the dialog shows the value the top-level key put in force",
     field(dlg, "urlSettleMs").value === "999", field(dlg, "urlSettleMs").value);
  await clickSave(dlg);
  ok("17b. saving moves it into the settings object",
     cfgNote().settings.urlSettleMs === 999, JSON.stringify(cfgNote().settings));
  ok("17c. ...and drops the top-level key it superseded",
     !("urlSettleMs" in cfgNote()), JSON.stringify(Object.keys(cfgNote())));

  // Keys the dialog does not show belong to whoever set them by hand.
  await env.setConfig({ workspaces: ["Work"], settings: { ...FAST, logMax: 40 } });
  dlg = await openTuning();
  field(dlg, "switchDebounceMs").value = "300";
  await clickSave(dlg);
  ok("18. a hand-set key the dialog does not offer is carried through",
     cfgNote().settings.logMax === 40 && cfgNote().settings.switchDebounceMs === 300,
     JSON.stringify(cfgNote().settings));

  ok("no errors logged while driving the settings",
     env.consoleErrors.length === 0, env.consoleErrors.join(" | "));

  done();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
