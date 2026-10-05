// Talk to a RUNNING Vivaldi over the Chrome DevTools Protocol and evaluate
// JavaScript in the main.html core page — the context where the mod lives.
// This is the only test tool that exercises the real browser; everything else
// runs against doubles.
//
// Start Vivaldi with a debug port first:
//   vivaldi --user-data-dir="$HOME/.config/vivaldi" --remote-debugging-port=9222 \
//           --debug-packed-apps --silent-debugger-extension-api
//
// Then:
//   node test/cdp.js --list                 # show CDP targets
//   node test/cdp.js 'VivaSync.diagNotes()'    # evaluate in the core page
//   node test/cdp.js --capture              # refresh fixtures/vivaldi-api.json
//
// Requires node >= 22 (uses the built-in WebSocket). Port override: CDP_PORT.
const fs = require("fs");
const path = require("path");

const PORT = process.env.CDP_PORT || 9222;

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return r.json();
}

async function evalIn(wsUrl, expr) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("websocket connect failed"));
  });
  const result = await new Promise((res, rej) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      ws.removeEventListener("message", onMsg);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression:
          `(async () => { try { const v = await (${expr}); return JSON.stringify(v, null, 1); }` +
          ` catch (e) { return "THREW: " + ((e && e.stack) || e); } })()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
    }));
  });
  ws.close();
  if (result.exceptionDetails) return "EXCEPTION: " + JSON.stringify(result.exceptionDetails, null, 1);
  return result.result && result.result.value;
}

// Everything the harness models, read straight out of the live browser.
const CAPTURE_EXPR = `(async () => ({
  notesApi: Object.keys(vivaldi.notes || {}).sort(),
  hasPrefs: typeof vivaldi.prefs?.get,
  hasSync: typeof vivaldi.sync?.getDefaultSessionName,
  workspaceFields: Object.keys((await new Promise(r => vivaldi.prefs.get('vivaldi.workspaces.list', r)))[0] || {}),
  noteFields: await (async () => {
    const t = await vivaldi.notes.getTree();
    const root = Array.isArray(t) ? t[0] : t;
    const kid = (root.children || [])[0];
    return kid ? Object.keys(kid) : [];
  })(),
  device: (typeof VivaSync !== 'undefined' && VivaSync.config) ? VivaSync.config().device : null
}))()`;

(async () => {
  const arg = process.argv[2];
  let list;
  try {
    list = await targets();
  } catch (_e) {
    console.error(`cannot reach CDP on :${PORT} — is Vivaldi running with --remote-debugging-port=${PORT}?`);
    process.exit(1);
  }

  if (!arg || arg === "--list") {
    for (const t of list) {
      console.log(`${String(t.type).padEnd(14)} ${String(t.title || "").slice(0, 38).padEnd(40)} ${String(t.url).slice(0, 90)}`);
    }
    return;
  }

  const core = list.find((t) => /main\.html/.test(t.url) && t.webSocketDebuggerUrl);
  if (!core) {
    console.error("main.html target not found. Is this Vivaldi, and is the debug port on? Targets:");
    for (const t of list) console.error(`  ${t.type} ${String(t.url).slice(0, 100)}`);
    process.exit(1);
  }

  if (arg === "--capture") {
    const raw = await evalIn(core.webSocketDebuggerUrl, CAPTURE_EXPR);
    let live;
    try {
      live = JSON.parse(raw);
    } catch (_e) {
      console.error("capture failed:", raw);
      process.exit(1);
    }
    const file = path.join(__dirname, "fixtures", "vivaldi-api.json");
    const cur = JSON.parse(fs.readFileSync(file, "utf8"));

    const added = live.notesApi.filter((k) => !cur.notesApi.includes(k));
    const gone = cur.notesApi.filter((k) => !live.notesApi.includes(k));
    if (added.length || gone.length) {
      console.log("vivaldi.notes surface CHANGED since the last capture:");
      if (added.length) console.log("  added:   " + added.join(", "));
      if (gone.length) console.log("  REMOVED: " + gone.join(", ") + "   <-- check the mod still works");
    } else {
      console.log("vivaldi.notes surface unchanged.");
    }

    cur.notesApi = live.notesApi;
    if (live.workspaceFields?.length) cur.workspaceFields = live.workspaceFields;
    if (live.noteFields?.length) cur.noteFields = live.noteFields;
    cur.capturedAt = new Date().toISOString().slice(0, 10);
    const v = await evalIn(core.webSocketDebuggerUrl, "navigator.userAgentData?.brands?.map(b=>b.brand+' '+b.version) || navigator.userAgent");
    cur.capturedFrom = `live capture (${live.device || "unknown device"})`;
    void v;
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n");
    console.log("wrote " + path.relative(process.cwd(), file));
    console.log("note fields seen on a live note node: " + (live.noteFields || []).join(", "));
    return;
  }

  console.log(await evalIn(core.webSocketDebuggerUrl, arg));
})();
