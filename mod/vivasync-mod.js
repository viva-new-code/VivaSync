// Vivaldi Workspace Sync — UI mod (sync documents live in Vivaldi Notes)
// ----------------------------------------------------------------------------
// Injected into the Vivaldi browser UI core (main.html, which loads bundle.js).
// Runs in the privileged Vivaldi UI context (extension id
// mpognobbkildjkofajifpdfhcoklimli), the only place Vivaldi workspaces and tab
// stacks are observable/mutable. (window.html is just a render shell — no JS.)
//
// There is NO native host, NO companion extension and NO file I/O. Each sync
// document is a NOTE named "<workspace>-<device>.json" under the "VivaSync"
// folder in Vivaldi Notes; cross-device transport is Vivaldi's own encrypted
// sync of the Notes tree. Vivaldi Sync must be enabled WITH notes included, or
// a device only ever sees its own note.
//
// Everything the mod needs from the browser is available in this context:
//   * vivaldi.notes.{getTree,get,create,update,remove}  -> the documents
//   * vivaldi.prefs.get("vivaldi.workspaces.list")      -> id<->name list
//   * vivaldi.sync.session_name / getDefaultSessionName -> the device name
//
// Field names / mechanisms below were grounded against this build's bundle.js:
//   * tab.vivExtData  (JSON string) -> { workspaceId:Number, group:StackId,
//                                         fixedGroupTitle:StackName,
//                                         groupColor:StackColour, ... }
//     READING vivExtData works fine. WRITING it via chrome.tabs.update is a
//     NO-OP in the UI context (verified) — Vivaldi ignores it here. So tabs are
//     grouped into stacks via vivaldi.tabsPrivate.move({tabIds, target,
//     tweaks:["create-new-group",...]}) and named via
//     vivaldi.tabsPrivate.setGroupProperties — exactly as bundle.js's
//     createTabStack does. See ADAPTER.createStack/addToStack/setStackName.
//   * Stack group ids are crypto.randomUUID() strings, ASSIGNED BY THE BACKEND
//     on stack creation — we cannot choose them. So stacks are matched across
//     devices by name/contents, not by id (see applyDesired).
// A couple of shapes still vary by version — run VivaSync.introspect() (and
// the VivaSync.diag* helpers) in the UI devtools console to confirm, then
// adjust ADAPTER.
//
// The user-facing surface is the "⇄" status-bar button, which opens a menu:
// Workspaces (workspace picker), Exceptions (address prefixes never synced),
// Settings (the tunables), Debug (status rows, actions, log tail — listed only
// when SETTINGS.showDebug) and About (name + VERSION). All of them are rendered
// into the visible window.html document, since main.html is 0x0 — see the "UI"
// section near the bottom.
// ----------------------------------------------------------------------------

(function () {
  "use strict";
  if (window.__vivasyncLoaded) {
    console.warn("[vivasync] already loaded");
    return;
  }
  window.__vivasyncLoaded = true;

  const LOG = "[vivasync]";
  // Single source of truth for the mod version (shown in the About dialog, the
  // Debug window, the startup log line and VivaSync.introspect()). Bump it
  // here and nowhere else — there is no build step to stamp it from.
  const NAME = "VivaSync";
  const VERSION = "0.17.2";
  const FOLDER = "VivaSync"; // notes folder holding every sync document
  const CONFIG_TITLE = "sync.config";
  const STARTED_AT = Date.now();

  // ===========================================================================
  // Tunables — defaults here, overrides in the config note's "settings" object
  // ---------------------------------------------------------------------------
  // Every timing the engine runs on is one key of SETTINGS. The values below
  // are only the FALLBACKS: whatever the `settings` object of the sync.config
  // note says wins, per key, so an install can be tuned (a slow machine, a
  // typist the URL settle keeps up with badly) without editing the mod — and,
  // because sync.config is itself a synced note, tuned once for every device.
  //
  //   { "workspaces": [...], "settings": { "urlSettleMs": 4000 } }
  //
  // Read them through SETTINGS at the point of use, never copied into a local
  // or captured in a closure, or an edit to the note would take effect only
  // after a restart. applySettings() is what fills it (see applyConfig).
  // ===========================================================================
  const SETTINGS_DEFAULTS = {
    writeDebounceMs: 500, // coalesce bursts of tab events (R2.1)
    switchDebounceMs: 250, // coalesce the event burst of a workspace switch
    // Floor between two writes of the SAME note. Every note write rewrites
    // Vivaldi's whole Notes file and pushes a sync entity, so the 500ms event
    // debounce above is not a sufficient rate limit on its own.
    minNoteWriteGapMs: 5000,
    remoteDebounceMs: 1000, // coalesce inbound sync notifications
    // How long to hold off the write after a grouping failed to settle. Longer
    // than the ordinary debounce on purpose: the point is to publish AFTER the
    // browser has finished moving tabs, not to ask again while it still is.
    groupSettleRetryMs: 3000,
    // How long a tab's URL must hold still before that URL is publishable.
    //
    // "Wait for the load to complete" is not enough on its own, and this is the
    // whole reason the knob exists: a site that rewrites its address as you
    // type (Google Translate, search-as-you-type, anything driving the URL from
    // an input box) COMPLETES a navigation on every intermediate value. Each of
    // those is a perfectly well-formed, fully-loaded URL that the mod has no way
    // to tell from one the user meant to keep — so half-typed words reached the
    // peer, were opened there, and came back. What separates the two is not the
    // load state but a quiet period: the value the user stopped on is the one
    // still there a moment later. The right value depends on how fast the user
    // types and how hard the site debounces, which the mod cannot know —
    // VivaSync.urlSettle() changes it for the session.
    urlSettleMs: 2500,
    // ...but a publish is never held longer than this. A page that rewrites its
    // URL on a timer for ever would otherwise stop the workspace syncing at all,
    // which is worse than syncing a moving target.
    maxSettleHoldMs: 15000,
    logMax: 400, // log ring buffer, lines
    logLineMax: 2000, // chars per line — introspect() dumps a whole tab list in one call
    // The Debug window is a diagnostic, not a feature: off unless asked for, so
    // the menu stays four plain items for everyone who never needs it. It only
    // hides the MENU ITEM — VivaSync.debug() from the console always works, and
    // has to, because a user who cannot open the menu is exactly who needs it.
    showDebug: false,
  };

  // The effective values. Defaults until the config note is read; a key the
  // note does not mention keeps its default.
  const SETTINGS = { ...SETTINGS_DEFAULTS };

  // A floor per key, so a value that would break the engine outright cannot be
  // configured: a zero-line log buffer records nothing, a one-char line
  // truncates every message to nothing. The debounces may legitimately be 0
  // (that is "do not coalesce"), so their floor is 0.
  const SETTINGS_MIN = { logMax: 1, logLineMax: 80 };

  // A refusal is worth saying once per offending value, not once per read: the
  // config note is re-read on every dialog open, every switch into a workspace
  // this device believes is not synced, and every peer edit, and a line each
  // time would bury the log the Debug window shows.
  const settingsWarned = new Map(); // key -> the value already complained about
  function warnSetting(key, value, message) {
    const seen = JSON.stringify(value === undefined ? null : value);
    if (settingsWarned.get(key) === seen) return;
    settingsWarned.set(key, seen);
    console.warn(LOG, message);
  }

  // Take a value only if it is a finite number at or above that floor. Anything
  // else — a string, a negative, a misspelled key — falls back to the default
  // and says so: a garbage debounce is indistinguishable from a mod that has
  // hung, and silently running on a default the user thinks they changed is
  // worse than a warning they can act on.
  function applySettings(raw) {
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      const def = SETTINGS_DEFAULTS[key];
      const want = src[key];
      const min = SETTINGS_MIN[key] != null ? SETTINGS_MIN[key] : 0;
      // The default's type says what the key is: every timing is a number, and
      // showDebug is a switch.
      const okValue = typeof def === "boolean"
        ? typeof want === "boolean"
        : typeof want === "number" && isFinite(want) && want >= min;
      if (want !== undefined && !okValue) {
        warnSetting(key, want,
          `settings.${key}: ignoring ${JSON.stringify(want)} ` +
          `(${typeof def === "boolean" ? "true or false" : "a number >= " + min} is required) ` +
          `— using the default ${def}`);
      } else {
        settingsWarned.delete(key); // the value was fixed; complain again if it comes back
      }
      SETTINGS[key] = okValue ? want : def;
    }
    for (const key of Object.keys(src)) {
      if (!(key in SETTINGS_DEFAULTS)) {
        warnSetting(key, src[key], `settings.${key}: unknown setting, ignored`);
      }
    }
    return SETTINGS;
  }

  // The keys an install has actually changed — for the Debug window and the
  // startup line, where "which of these is not stock?" is the whole question.
  function tunedSettings() {
    return Object.keys(SETTINGS_DEFAULTS)
      .filter((k) => SETTINGS[k] !== SETTINGS_DEFAULTS[k])
      .map((k) => `${k}=${SETTINGS[k]}`);
  }

  // ===========================================================================
  // Log ring buffer
  // ---------------------------------------------------------------------------
  // The core devtools console (vivaldi://inspect) stays the primary log sink,
  // but the Debug window has to be usable WITHOUT it — that is the whole point
  // of having one. So every line the mod prints is also kept here.
  //
  // This is a tap on console.* rather than a rewrite of the ~70 call sites: it
  // records only calls whose first argument is our own LOG marker and always
  // forwards to the original function, so nothing else in the UI is affected.
  // ===========================================================================
  // Sized by SETTINGS.logMax / SETTINGS.logLineMax — read per line, so an edit
  // to the config note trims the buffer from the next line on.
  const logBuf = [];
  let logSeq = 0; // bumped on every recorded line; the Debug window polls it

  function logText(args) {
    return args
      .map((x) => {
        if (typeof x === "string") return x;
        try {
          return JSON.stringify(x);
        } catch (_e) {
          return String(x);
        }
      })
      .join(" ");
  }

  // "debug" belongs here as much as the rest: the reconcile engine reports its
  // NON-decisions at that level ("defer write of", "defer pull for", "skip
  // reconcile of", "already up to date"), and those are precisely what a bug
  // report needs — why the mod did nothing. Left untapped, the Debug window's
  // log tail would silently drop them.
  for (const level of ["debug", "log", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith(LOG)) {
        let text = logText(args.slice(1));
        const lineMax = SETTINGS.logLineMax;
        if (text.length > lineMax) text = text.slice(0, lineMax) + "…[truncated]";
        logBuf.push(
          new Date().toISOString().slice(11, 23) + " " +
            level.toUpperCase().padEnd(5) + " " + text
        );
        while (logBuf.length > SETTINGS.logMax) logBuf.shift();
        logSeq++;
      }
      orig(...args);
    };
  }

  // ===========================================================================
  // Vivaldi private-API plumbing
  // ---------------------------------------------------------------------------
  // These APIs accept a callback AND (on most builds) return a thenable. Handle
  // both: pass a callback, and if a thenable comes back, adopt it instead.
  // ===========================================================================
  function apiCall(fn, thisArg, ...args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cb = (v) => {
        if (settled) return;
        settled = true;
        const e = chrome.runtime.lastError;
        e ? reject(new Error(e.message)) : resolve(v);
      };
      let r;
      try {
        r = fn.call(thisArg, ...args, cb);
      } catch (_e) {
        // Build rejects the extra callback arg — retry promise-style.
        try {
          r = fn.call(thisArg, ...args);
        } catch (e2) {
          return reject(e2);
        }
      }
      if (r && typeof r.then === "function") {
        settled = true;
        r.then(resolve, reject);
      }
    });
  }

  // vivaldi.prefs.get returns the raw value on some builds and a wrapper object
  // ({value}/{currentValue}/{defaultValue}) on others. Unwrap, and NEVER let an
  // object reach String() — that produces an "[object Object]" device name,
  // and notes titled after it (see SPEC.md, "Approaches that failed").
  async function prefGet(path) {
    const raw = await apiCall(vivaldi.prefs.get, vivaldi.prefs, path);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const k of ["value", "currentValue", "val"]) if (k in raw) return raw[k];
    }
    return raw;
  }

  // ===========================================================================
  // Device-local key/value store
  // ---------------------------------------------------------------------------
  // NOT configuration — configuration lives in the sync.config note and is
  // replicated. This holds only what must stay on this device: the fallback
  // device id and the URL-churn counters.
  // ===========================================================================
  const KV = (() => {
    const LS_KEY = "vivasync.kv";
    let backend = "memory";
    let data = {};

    async function init() {
      try {
        localStorage.setItem("vivasync.probe", "1");
        localStorage.removeItem("vivasync.probe");
        backend = "local";
        data = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
        return;
      } catch (_e) {
        /* fall through */
      }
      try {
        if (globalThis.chrome && chrome.storage && chrome.storage.local) {
          backend = "chrome";
          const v = await apiCall(chrome.storage.local.get, chrome.storage.local, LS_KEY);
          data = (v && v[LS_KEY]) || {};
        }
      } catch (e) {
        console.warn(LOG, "kv init degraded:", e.message);
        data = {};
      }
    }

    function flush() {
      try {
        if (backend === "local") localStorage.setItem(LS_KEY, JSON.stringify(data));
        else if (backend === "chrome") chrome.storage.local.set({ [LS_KEY]: data });
      } catch (e) {
        console.warn(LOG, "kv flush failed:", e.message);
      }
    }

    return {
      init,
      get backend() {
        return backend;
      },
      get: (k) => data[k],
      set: (k, v) => {
        data[k] = v;
        flush();
      },
    };
  })();

  // ===========================================================================
  // Notes transport
  // ---------------------------------------------------------------------------
  // One note per (workspace, device), titled "<workspace>-<device>.json",
  // living directly under the VivaSync folder. list() returns [{name, data}]
  // (or {name, error} for a note whose content is not JSON).
  // ===========================================================================
  const NOTES = (() => {
    let folderId = null;
    const idByTitle = new Map();
    const lastWriteAt = new Map();
    // Notes this device wrote. Used to ignore the change events our own writes
    // generate, so a write never triggers a reconcile of itself.
    const ownIds = new Set();

    const api = () => {
      const n = globalThis.vivaldi && vivaldi.notes;
      if (!n) throw new Error("vivaldi.notes unavailable in this context");
      return n;
    };

    async function getTree() {
      const t = await apiCall(api().getTree, api());
      return Array.isArray(t) ? t : t ? [t] : [];
    }

    // Direct children of the notes root, skipping the trash subtree entirely —
    // a trashed VivaSync folder must never be adopted as the live one.
    async function rootChildren() {
      const tree = await getTree();
      const root = tree.find((n) => n && n.type !== "trash") || tree[0];
      if (!root) throw new Error("notes tree has no root");
      return { root, children: (root.children || []).filter((n) => n && n.type !== "trash") };
    }

    async function init() {
      const { root, children } = await rootChildren();
      // Two devices that both seeded the folder before their first sync leave
      // TWO folders of this name on every machine. Each device must pick the
      // same one or they never see each other's documents: the fullest wins,
      // ties broken by the greatest id, both of which every device can compute
      // from the same synced tree. The others are left alone and reported.
      const folders = children.filter((n) => n.type === "folder" && n.title === FOLDER);
      folders.sort((a, b) =>
        ((b.children || []).length - (a.children || []).length) ||
        (String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0));
      let folder = folders[0];
      if (folders.length > 1) {
        console.warn(LOG, `${folders.length} "${FOLDER}" folders in Notes — using id=${folder.id}` +
          ` (${(folder.children || []).length} notes); the others are ignored:`,
          folders.slice(1).map((f) => `id=${f.id} (${(f.children || []).length} notes)`).join(", "),
          "— move their notes into the used one or delete them.");
      }
      if (!folder) {
        folder = await apiCall(api().create, api(), { parentId: root.id, title: FOLDER, type: "folder" });
        console.info(LOG, `created notes folder "${FOLDER}" id=${folder.id}`);
      }
      folderId = folder.id;
      return folderId;
    }

    async function ensureFolder() {
      if (folderId == null) await init();
      return folderId;
    }

    // Live children of the VivaSync folder, refreshed from the tree each call so
    // notes arriving via sync are seen. Also refreshes the title->id map.
    async function children() {
      const id = await ensureFolder();
      const { children: top } = await rootChildren();
      let folder = top.find((n) => String(n.id) === String(id));
      if (!folder) {
        // Folder was deleted or replaced (e.g. by a sync merge) — re-resolve.
        folderId = null;
        await init();
        const again = await rootChildren();
        folder = again.children.find((n) => String(n.id) === String(folderId));
      }
      let kids = (folder && folder.children ? folder.children : []).filter(
        (n) => n && n.type !== "trash" && n.type !== "folder"
      );
      kids = await dedupe(kids);
      idByTitle.clear();
      for (const n of kids) if (n.title) idByTitle.set(n.title, n.id);
      return kids;
    }

    // Two notes with one title are one document twice, and every reader picks
    // one at random; keep exactly one. The keeper is chosen from CONTENT alone
    // — the highest provenance, then the greatest content string — so every
    // device deletes the same copies. Choosing by tree order or local id would
    // have each device delete a different one, and between them all of them.
    async function dedupe(kids) {
      const byTitle = new Map();
      for (const n of kids) {
        if (!n.title) continue;
        if (!byTitle.has(n.title)) byTitle.set(n.title, []);
        byTitle.get(n.title).push(n);
      }
      const drop = new Set();
      for (const [title, group] of byTitle) {
        if (group.length < 2) continue;
        const ranked = [];
        for (const n of group) {
          const raw = await contentOf(n);
          let rank = [-1, 0, ""];
          try {
            const d = JSON.parse(raw);
            rank = [
              typeof d.version === "number" ? d.version : 0,
              typeof d.timestamp === "number" ? d.timestamp : 0,
              raw,
            ];
          } catch (_e) {
            rank = [-1, 0, raw];
          }
          ranked.push({ n, rank });
        }
        ranked.sort((a, b) => {
          for (let i = 0; i < 3; i++) {
            if (a.rank[i] < b.rank[i]) return 1;
            if (a.rank[i] > b.rank[i]) return -1;
          }
          return 0;
        });
        const keep = ranked[0].n;
        console.warn(LOG, `${group.length} notes titled "${title}" — keeping id=${keep.id}, removing`,
          ranked.slice(1).map((r) => "id=" + r.n.id).join(", "));
        for (const r of ranked.slice(1)) {
          drop.add(String(r.n.id));
          try {
            await apiCall(api().remove, api(), r.n.id);
          } catch (e) {
            console.warn(LOG, `could not remove duplicate note id=${r.n.id}:`, e.message);
          }
        }
      }
      return drop.size ? kids.filter((n) => !drop.has(String(n.id))) : kids;
    }

    // getTree() does not always populate `content` — absent on some builds,
    // an empty string on others — so anything but a non-empty string falls
    // back to a direct get. Taken at face value, "" makes a present note read
    // as an unparsable one, and readConfig would then seed a SECOND sync.config.
    async function contentOf(node) {
      if (typeof node.content === "string" && node.content) return node.content;
      try {
        const r = await apiCall(api().get, api(), String(node.id));
        const n = Array.isArray(r) ? r[0] : r;
        return (n && n.content) || "";
      } catch (_e) {
        return "";
      }
    }

    // [{name, id, data}] or [{name, id, error}] on bad JSON, sorted by title.
    async function list(prefix) {
      const kids = await children();
      const out = [];
      for (const n of kids) {
        const name = n.title || "";
        if (prefix && !name.startsWith(prefix)) continue;
        const raw = await contentOf(n);
        const entry = { name, id: n.id };
        try {
          entry.data = JSON.parse(raw);
        } catch (e) {
          entry.error = String(e.message || e);
        }
        out.push(entry);
      }
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return out;
    }

    // null when no note of that title exists; otherwise {data} or {error}.
    // Callers that would CREATE the note on a miss must use this, not
    // readNote(): a present-but-unreadable note is not a missing one, and
    // seeding over it creates a second sync.config.
    async function readEntry(title) {
      const kids = await children();
      const node = kids.find((n) => n.title === title);
      if (!node) return null;
      const raw = await contentOf(node);
      try {
        return { id: node.id, data: JSON.parse(raw) };
      } catch (e) {
        console.warn(LOG, `note "${title}" is not valid JSON:`, e.message);
        return { id: node.id, error: String(e.message || e) };
      }
    }

    async function readNote(title) {
      const e = await readEntry(title);
      return e && e.data ? e.data : null;
    }

    // Stamps the payload's `timestamp`, then creates or updates the note.
    // Returns {name, id, timestamp}.
    //
    // `stampTs` overrides that clock. Only one caller uses it — joining a
    // workspace the other devices already share writes a document stamped 0, so
    // that it exists and names this device but loses every newest-wins
    // comparison it will ever be in (see publishOnEnable).
    // Writes to one title are serialized: two concurrent writes that both
    // miss the id cache would both create, and there is then a note too many.
    const locks = new Map(); // title -> tail of the write chain
    function write(title, data, stampTs) {
      const prev = locks.get(title) || Promise.resolve();
      const run = prev.catch(() => {}).then(() => writeLocked(title, data, stampTs));
      locks.set(title, run);
      run.finally(() => { if (locks.get(title) === run) locks.delete(title); });
      return run;
    }

    // The id of the note with this title, from a fresh listing. A create happens
    // only when this finds nothing: a failed update is retried against a fresh
    // id first, because "the update failed" is what a note replaced by a sync
    // merge looks like, and recreating on top of it multiplies the copies.
    async function resolveId(title) {
      const kids = await children();
      const found = kids.find((n) => n.title === title);
      return found ? found.id : null;
    }

    async function writeLocked(title, data, stampTs) {
      const id = await ensureFolder();
      const payload = data && typeof data === "object" && !Array.isArray(data) ? { ...data } : data;
      // Epoch SECONDS as a float.
      if (payload && typeof payload === "object") {
        payload.timestamp = typeof stampTs === "number" ? stampTs : Date.now() / 1000;
      }
      const content = JSON.stringify(payload, null, 2);

      const wait = (lastWriteAt.get(title) || 0) + SETTINGS.minNoteWriteGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));

      let noteId = idByTitle.get(title);
      if (noteId == null) noteId = await resolveId(title);
      if (noteId != null) {
        try {
          await apiCall(api().update, api(), noteId, { content });
        } catch (e) {
          const fresh = await resolveId(title);
          if (fresh != null) {
            console.warn(LOG, `note update failed (${title}, id=${noteId}): ${e.message}; retrying against id=${fresh}`);
            noteId = fresh;
            await apiCall(api().update, api(), noteId, { content });
          } else {
            console.warn(LOG, `note update failed (${title}): ${e.message}; the note is gone, recreating`);
            noteId = null;
          }
        }
      }
      if (noteId == null) {
        const n = await apiCall(api().create, api(), { parentId: id, title, content, type: "note" });
        noteId = n && n.id;
      }
      if (noteId != null) {
        idByTitle.set(title, noteId);
        ownIds.add(String(noteId));
      }
      lastWriteAt.set(title, Date.now());
      return { name: title, id: noteId, timestamp: payload && payload.timestamp };
    }

    async function remove(title) {
      const kids = await children();
      const node = kids.find((n) => n.title === title);
      if (!node) return false;
      await apiCall(api().remove, api(), node.id);
      idByTitle.delete(title);
      return true;
    }

    // Is this note id one of ours (i.e. a direct child of the VivaSync folder)?
    // Returns its title, or null for anything else in the user's notes tree.
    //
    // Fast path is a single-node get and a parentId compare — far cheaper than
    // re-walking the tree for every note the user edits. But `parentId` is NOT
    // a verified field on every Vivaldi build, and treating "no parentId" as
    // "not ours" would silently drop every remote event and kill auto-pull. So
    // when it is absent we fall back to matching the id against the folder
    // listing, which is authoritative if slower.
    async function classify(id) {
      let node = null;
      try {
        const r = await apiCall(api().get, api(), String(id));
        node = Array.isArray(r) ? r[0] : r;
      } catch (_e) {
        node = null;
      }
      if (node && node.parentId !== undefined && node.parentId !== null) {
        return String(node.parentId) === String(folderId) ? node.title || null : null;
      }
      try {
        const kids = await children();
        const hit = kids.find((n) => String(n.id) === String(id));
        return hit ? hit.title || null : null;
      } catch (_e) {
        return null;
      }
    }

    return {
      init,
      list,
      readNote,
      readEntry,
      write,
      remove,
      classify,
      // How long write() would sleep in the throttle for this title, right now.
      // Callers use it to RE-ARM rather than queue: a snapshot handed to write()
      // is serialized after the sleep, so a queued write publishes a state that
      // can be SETTINGS.minNoteWriteGapMs out of date — stamped as the newest
      // document in the folder. See writeChanged.
      writeDelay: (title) =>
        Math.max(0, (lastWriteAt.get(title) || 0) + SETTINGS.minNoteWriteGapMs - Date.now()),
      isOwn: (id) => ownIds.has(String(id)),
      titleOf: (id) => {
        for (const [t, i] of idByTitle) if (String(i) === String(id)) return t;
        return null;
      },
      get folderId() {
        return folderId;
      },
    };
  })();

  // ===========================================================================
  // Device name
  // ---------------------------------------------------------------------------
  // Prefer the name the user already sees in Vivaldi's Sync settings, so the
  // note titles are recognisable. Only ever accept a plain string: on some
  // builds prefs.get returns a wrapper object, and String()-ing it yields an
  // "[object Object]" device name.
  // ===========================================================================
  async function resolveDevice() {
    let raw = null;
    try {
      raw = await prefGet("vivaldi.sync.session_name");
    } catch (_e) {
      raw = null;
    }
    if (raw && typeof raw === "object") raw = null;
    if (!(typeof raw === "string" && raw.trim())) {
      // Pref unset — Vivaldi's own Sync settings then shows the default name.
      try {
        const d = await apiCall(vivaldi.sync.getDefaultSessionName, vivaldi.sync);
        if (typeof d === "string" && d.trim()) raw = d;
      } catch (e) {
        console.warn(LOG, "getDefaultSessionName failed:", e.message);
      }
    }
    // Note titles are parsed by prefix, so keep the name to safe characters.
    const clean = (typeof raw === "string" ? raw : "").replace(/[^\w-]/g, "");
    if (clean) return clean;

    const stored = KV.get("device");
    if (typeof stored === "string" && stored) return stored;
    const gen = "dev-" + (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).slice(0, 8);
    KV.set("device", gen);
    return gen;
  }

  // ===========================================================================
  // Vivaldi internals via webpack module cache
  // ---------------------------------------------------------------------------
  // chrome.tabs.update({vivExtData}) is a no-op in the UI context (confirmed by
  // diagClobber: the write never takes effect). The reconcile path does not
  // need this module — it mutates stacks through vivaldi.tabsPrivate (see
  // ADAPTER) — but Vivaldi's own internal module functions are reachable too,
  // and the diagnostics use them. Vivaldi exposes a webpack chunk array
  // (webpackChunkgapp_browser_react); we push a probe entry to capture
  // __webpack_require__, then scan the already-instantiated module cache for
  // the functions we need, matched by their (readable, non-minified) export key
  // names: updateExtData, createTabStack, getNewGroupId.
  // ===========================================================================
  const VIV = (() => {
    const CHUNK = "webpackChunkgapp_browser_react";
    const TARGET_KEYS = ["updateExtData", "createTabStack", "getNewGroupId", "setGroupProperties"];
    let cache = null; // { updateExtData, createTabStack, ... }
    let lastScanCount = 0;

    function getRequire() {
      const chunk = window[CHUNK];
      if (!chunk || typeof chunk.push !== "function") return null;
      let req = null;
      try {
        chunk.push([
          ["vivasync_probe_" + Date.now()],
          {},
          (r) => { req = r; },
        ]);
      } catch (e) {
        console.error(LOG, "VIV.getRequire push failed:", e);
        return null;
      }
      return req;
    }

    // Find the module cache on the require object. Webpack 5 uses `.c`, but
    // builds vary; locate the property whose value is an object map of
    // module-id -> { exports }.
    function moduleCache(req) {
      if (!req) return null;
      if (req.c && typeof req.c === "object") return req.c;
      for (const k of Object.keys(req)) {
        try {
          const v = req[k];
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const ids = Object.keys(v);
            if (ids.length && v[ids[0]] && typeof v[ids[0]] === "object" && "exports" in v[ids[0]]) {
              return v;
            }
          }
        } catch (_e) {}
      }
      return null;
    }

    // VIVA-DIAG: dump the captured webpack require's shape (cache/factory maps).
    function diagRequireShape() {
      const req = getRequire();
      if (!req) {
        console.log(LOG, "VIV.diag: require NOT captured (push callback never ran)");
        const chunk = window[CHUNK];
        console.log(LOG, "VIV.diag: chunk array length:", chunk && chunk.length);
        if (chunk && chunk[0]) {
          console.log(LOG, "VIV.diag: chunk[0] entry length:", chunk[0].length,
            "modules in chunk[0][1]:", chunk[0][1] ? Object.keys(chunk[0][1]).length : "n/a");
        }
        return;
      }
      console.log(LOG, "VIV.diag: require captured. typeof:", typeof req,
        "own keys:", Object.keys(req).join(","));
      for (const k of Object.keys(req)) {
        try {
          const v = req[k];
          if (v && typeof v === "object") {
            console.log(LOG, "VIV.diag: req." + k, "is object, size:", Object.keys(v).length);
          }
        } catch (_e) {}
      }
      const mc = moduleCache(req);
      console.log(LOG, "VIV.diag: module cache located:", !!mc, "size:", mc ? Object.keys(mc).length : 0);
    }

    // This build's require has no exposed module cache (.c), only the factory
    // registry (.m). So we scan each factory's SOURCE for the readable
    // definition of the functions we need, then instantiate only the matching
    // modules via req(id) (idempotent for already-loaded modules) and pull the
    // bound function out of the resulting exports.
    const PATTERNS = {
      updateExtData: /updateExtData\s*:/,
      createTabStack: /createTabStack\s*[:(]/,
      getNewGroupId: /getNewGroupId\s*[:(]/,
    };

    function pullFromExports(exp, out) {
      const candidates = [exp];
      for (const nk of ["Z", "ZP", "default", "V", "a", "b"]) {
        try { if (exp && exp[nk]) candidates.push(exp[nk]); } catch (_e) {}
      }
      for (const c of candidates) {
        if (!c || (typeof c !== "object" && typeof c !== "function")) continue;
        for (const key of Object.keys(PATTERNS)) {
          if (out[key]) continue;
          try {
            if (typeof c[key] === "function") out[key] = c[key].bind(c);
          } catch (_e) {}
        }
      }
    }

    function scan() {
      const req = getRequire();
      if (!req || !req.m) {
        console.warn(LOG, "VIV: webpack factory registry (req.m) unavailable");
        return {};
      }
      const out = {};
      let instantiated = 0;
      const wanted = Object.keys(PATTERNS);
      for (const mid in req.m) {
        if (wanted.every((k) => out[k])) break; // found everything
        let src;
        try { src = Function.prototype.toString.call(req.m[mid]); } catch (_e) { continue; }
        let interested = false;
        for (const key of wanted) {
          if (!out[key] && PATTERNS[key].test(src)) { interested = true; break; }
        }
        if (!interested) continue;
        let exp;
        try { exp = req(mid); } catch (_e) { continue; }
        instantiated++;
        pullFromExports(exp, out);
      }
      lastScanCount = instantiated;
      return out;
    }

    function find() {
      // Re-scan if we haven't found updateExtData yet (modules may load late).
      if (!cache || typeof cache.updateExtData !== "function") cache = scan();
      return cache;
    }

    return {
      find,
      diagRequireShape,
      get lastScanCount() { return lastScanCount; },
    };
  })();

  // ===========================================================================
  // Vivaldi adapter — the version-sensitive surface. Centralised on purpose.
  // ===========================================================================
  const ADAPTER = {
    parseTabExt(tab) {
      const raw = tab && (tab.vivExtData ?? tab.extData);
      if (!raw) return {};
      try {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (_e) {
        return {};
      }
    },

    stackIdOf(ext) {
      // Vivaldi stores the tab-stack id under `group` in vivExtData.
      return ext.group != null ? String(ext.group) : null;
    },

    stackNameOf(ext) {
      // bundle: `e.vivExtData?.fixedGroupTitle ?? "Stack"`
      return ext.fixedGroupTitle || ext.groupTitle || null;
    },

    // A stack's colour lives beside its name in every member's vivExtData
    // (bundle.js: `e.vivExtData.groupColor ?? undefined`) and is set through
    // the same setGroupProperties call, one property at a time — which is how
    // Vivaldi's own UI uses it (setFixedStackTitle passes groupTitle alone,
    // setStackColor passes groupColor alone), so neither erases the other.
    stackColorOf(ext) {
      return normStackColor(ext.groupColor);
    },

    async currentWindowId() {
      if (typeof window.vivaldiWindowId === "number") return window.vivaldiWindowId;
      try {
        const w = await chrome.windows.getCurrent();
        if (w && typeof w.id === "number") return w.id;
      } catch (_e) {}
      const w = await chrome.windows.getLastFocused();
      return w.id;
    },

    parseWinExt(win) {
      const raw = win && (win.vivExtData ?? win.extData);
      if (!raw) return {};
      try {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (_e) {
        return {};
      }
    },

    // Normalize a workspace id to a stable string key. Vivaldi stores ids as
    // timestamp-valued floats (e.g. 1717425015828.0); Number() drops the ".0".
    wsKey(id) {
      return id == null ? "" : String(Number(id));
    },

    // The workspaces list (id<->name) is the pref vivaldi.workspaces.list, NOT
    // window extData. Readable straight from this context via vivaldi.prefs.
    // Cached briefly because it changes only when the user edits workspaces;
    // pass forceRefresh from UI that must show the list as it is right now.
    async workspaceList(forceRefresh) {
      const now = Date.now();
      if (!forceRefresh && this._wsCache && now - this._wsCacheAt < 15000) return this._wsCache;
      try {
        const raw = await prefGet("vivaldi.workspaces.list");
        this._wsCache = (Array.isArray(raw) ? raw : [])
          .filter((x) => x && x.id != null)
          .map((x) => ({ id: x.id, name: x.name != null ? String(x.name) : "" }));
        this._wsCacheAt = now;
      } catch (e) {
        if (!this._wsCache) this._wsCache = [];
        console.error(LOG, "workspaceList read failed:", e.message);
      }
      return this._wsCache;
    },

    // Workspace ids that have live tabs right now. The prefs list can lag a
    // just-created workspace, so the settings dialog folds these in to avoid
    // showing an incomplete list.
    async liveWorkspaceIds() {
      const out = new Map();
      try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          const id = this.parseTabExt(t).workspaceId;
          if (id != null) out.set(this.wsKey(id), id);
        }
      } catch (e) {
        console.warn(LOG, "liveWorkspaceIds failed:", e.message);
      }
      return out;
    },

    // Active workspace = the workspaceId of the currently active tab (Vivaldi
    // only shows the active workspace's tabs). Live and version-independent.
    async activeWorkspaceId(winId) {
      const [t] = await chrome.tabs.query({ active: true, windowId: winId });
      if (!t) return null;
      const ext = this.parseTabExt(t);
      return ext.workspaceId != null ? ext.workspaceId : null;
    },

    // Returns { list: [{id, name}], activeId } for the focused window.
    async getWorkspaces() {
      const winId = await this.currentWindowId();
      const [list, activeId] = await Promise.all([
        this.workspaceList(),
        this.activeWorkspaceId(winId),
      ]);
      return { list, activeId };
    },

    async tabsInWindow(winId) {
      return chrome.tabs.query({ windowId: winId });
    },

    // --- Stack manipulation -------------------------------------------------
    // chrome.tabs.update({vivExtData}) is a no-op in the UI context (verified),
    // so tab grouping must go through Vivaldi's own tabsPrivate.move, exactly as
    // bundle.js's createTabStack does. The backend assigns the new group id and
    // returns it; we cannot choose it (so cross-device stack identity is matched
    // by name/contents, not id — see applyDesired).

    // Create a NEW stack containing the given tab ids. Returns the new group id.
    async createStack(tabIds) {
      if (!tabIds || tabIds.length === 0) return null;
      const res = await vivaldi.tabsPrivate.move({
        tabIds,
        target: tabIds[0],
        tweaks: ["do-not-reparent", "create-new-group", "target-is-tab"],
        debug: "vivasync.createStack",
      });
      return res && res.group ? res.group : null;
    },

    // Add a tab to an EXISTING stack. `groupExtId` is the STACK's group id, not
    // a tab id — this is Vivaldi's own "drop a tab onto a stack" call
    // (bundle.js endInternalDragging: tweaks ["do-not-reparent","on",
    // "create-group"] with the hovered tab's group as the target, and
    // deliberately NO "target-is-tab").
    //
    // tabsPrivate.move VALIDATES the tweak vocabulary and throws ("Value must
    // be one of above, below, …") on a name it does not know, so pass only the
    // tweaks bundle.js itself passes (test/harness.js enforces the list). A
    // join that silently fails makes a tab a peer opened inside a stack arrive
    // here as a plain tab — and, once published as one, leave the stack on the
    // peer too; applyDesired therefore verifies every join.
    // VIVA-DIAG: VivaSync.diagAddToStack() exercises this against a live build.
    async addToStack(tabId, groupExtId) {
      if (!groupExtId) throw new Error("addToStack needs a group id");
      await vivaldi.tabsPrivate.move({
        tabIds: [tabId],
        target: groupExtId,
        tweaks: ["do-not-reparent", "on", "create-group"],
        debug: "vivasync.addToStack",
      });
    },

    // vivaldi.tabsPrivate returns BEFORE the browser has written the change into
    // the tabs' vivExtData (which is why diagMakeStack/diagDetach sleep before
    // reading it back). Every grouping op therefore has to be waited out, not
    // just fired: reconcile() publishes the moment applyDesired returns, and a
    // snapshot taken inside that window reports plain tabs. The peer then
    // faithfully applies "no stack" by taking the stack apart and republishes —
    // and the two devices oscillate grouped/ungrouped for ever.
    async pollTabs(tabIds, predicate, timeoutMs = 2000) {
      const ids = (tabIds || []).filter((x) => x != null);
      if (!ids.length) return false;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let exts = null;
        try {
          exts = await Promise.all(
            ids.map(async (id) => this.parseTabExt(await chrome.tabs.get(id)))
          );
        } catch (_e) {
          exts = null; // a tab vanished mid-poll; keep waiting for the deadline
        }
        if (exts && predicate(exts)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 60));
      }
    },

    // Wait until these tabs really are one stack in vivExtData — and, when a
    // name is given, until the name has landed too (the snapshot includes it, so
    // publishing early makes the peers flap the name back and forth). Returns
    // the settled group id, or null if it never got there.
    //
    // `expect` is the group the caller ASKED for, when it knows it (the id
    // tabsPrivate.move answered with). Without it "one stack" is satisfied by
    // the group the tabs are in ALREADY — and two tabs created for a new stack
    // start out in one group together, because Vivaldi drops every newborn into
    // the active tab's stack. That would return the user's stack as the new
    // stack's group, and the caller would rename the user's stack to the new
    // one's name ("a second stack arriving while I sit in a stack renames
    // mine").
    async awaitStack(tabIds, name, timeoutMs = 2000, expect = null) {
      const ids = [...new Set((tabIds || []).filter((x) => x != null))];
      if (ids.length < 2) return null; // a group of one is not a stack
      let gid = null;
      const settled = await this.pollTabs(ids, (exts) => {
        const g = this.stackIdOf(exts[0]);
        if (!g || !exts.every((e) => this.stackIdOf(e) === g)) return false;
        if (expect && g !== expect) return false;
        if (name && !exts.some((e) => this.stackNameOf(e) === name)) return false;
        gid = g;
        return true;
      }, timeoutMs);
      if (!settled) {
        console.warn(LOG, "stack did not settle within", timeoutMs + "ms — tabs", ids.join(","));
        return null;
      }
      return gid;
    },

    // Do these tabs already carry this stack name? Mirrors awaitStack's own
    // test (a named member wins), so "already named" and "settled with the
    // name" mean exactly the same thing. Used to skip a redundant rename.
    async stackNamed(tabIds, name) {
      const ids = [...new Set((tabIds || []).filter((x) => x != null))];
      if (!ids.length || !name) return false;
      try {
        const exts = await Promise.all(
          ids.map(async (id) => this.parseTabExt(await chrome.tabs.get(id)))
        );
        return exts.some((e) => this.stackNameOf(e) === name);
      } catch (_e) {
        return false;
      }
    },

    // Take a tab OUT of the stack it is in, leaving it as an ordinary tab.
    // Vivaldi's own "remove from tab stack" moves the tab with the `ungroup`
    // tweak (bundle.js removeFromTabStack -> moveToIndex(..., ["untile",
    // "ungroup"])), so that is attempt 1. Two fallbacks follow it — a move
    // allowed to reparent, then a group of one — and every attempt VERIFIES the
    // outcome by reading vivExtData back: a silent no-op here would strand a
    // tab inside a stack the user never put it in, and two devices would fight
    // over that stack. Returns true once the tab is out of its original group.
    // VIVA-DIAG: VivaSync.diagDetach() exercises this against a live build.
    async detachFromStack(tabId, workspaceId, winId) {
      const gidNow = async () => {
        try {
          return this.stackIdOf(this.parseTabExt(await chrome.tabs.get(tabId)));
        } catch (_e) {
          return null;
        }
      };
      const before = await gidNow();
      if (before == null) return true;
      // Poll, don't peek: reading vivExtData straight after the move sees the
      // pre-move value, so a single read would report failure every time and
      // send us into the fallback (which then really does leave the tab in a
      // group of its own, alongside the copy the caller opens as a "recovery").
      const left = () =>
        this.pollTabs([tabId], (exts) => {
          const g = this.stackIdOf(exts[0]);
          return g == null || g !== before;
        }, 1500);
      // 1. The documented way: move with "ungroup". workspaceId is passed (and
      //    target:-1 used) rather than Vivaldi's window-wide "last index + 1",
      //    because the tab-strip index spans ALL workspaces and moving to the
      //    window end reassigns the tab to a neighbouring workspace.
      try {
        await vivaldi.tabsPrivate.move({
          tabIds: [tabId],
          target: -1,
          windowId: winId,
          workspaceId: workspaceId,
          tweaks: ["untile", "ungroup"],
          debug: "vivasync.detachFromStack.ungroup",
        });
      } catch (e) {
        console.debug(LOG, "detach via ungroup failed:", e && e.message);
      }
      if (await left()) return true;
      // 2. A move that is simply allowed to reparent (no "do-not-reparent").
      try {
        await vivaldi.tabsPrivate.move({
          tabIds: [tabId],
          target: -1,
          windowId: winId,
          workspaceId: workspaceId,
          tweaks: [],
          debug: "vivasync.detachFromStack",
        });
      } catch (e) {
        console.debug(LOG, "detach via move failed:", e && e.message);
      }
      if (await left()) return true;
      // 3. Failing that, give it a group of its own. A one-member group is not
      //    a stack (see buildSnapshot), so this is equivalent to ungrouping.
      try {
        await this.createStack([tabId]);
      } catch (e) {
        console.debug(LOG, "detach via new group failed:", e && e.message);
      }
      return left();
    },

    // Set (or change) a stack's display name.
    async setStackName(groupExtId, name) {
      if (!groupExtId) return;
      await vivaldi.tabsPrivate.setGroupProperties({
        groupExtId,
        groupTitle: name || "",
      });
    },

    // Set (or clear) a stack's colour. The empty string is how Vivaldi's own
    // menu clears it (bundle.js: setStackColor(win, gid, "")). The call carries
    // groupColor alone, exactly as setStackName carries groupTitle alone.
    async setStackColor(groupExtId, color) {
      if (!groupExtId) return;
      await vivaldi.tabsPrivate.setGroupProperties({
        groupExtId,
        groupColor: normStackColor(color) || "",
      });
    },

    // Is this the colour these tabs carry? The mirror of stackNamed, with "no
    // colour" spelled as null: a colour is settled once ANY member shows it
    // (members catch up separately, as they do for a name), and cleared only
    // once NONE of them does.
    colorSettled(exts, color) {
      const want = normStackColor(color);
      return want
        ? exts.some((e) => this.stackColorOf(e) === want)
        : exts.every((e) => this.stackColorOf(e) == null);
    },

    async stackColored(tabIds, color) {
      const ids = [...new Set((tabIds || []).filter((x) => x != null))];
      if (!ids.length) return false;
      try {
        const exts = await Promise.all(
          ids.map(async (id) => this.parseTabExt(await chrome.tabs.get(id)))
        );
        return this.colorSettled(exts, color);
      } catch (_e) {
        return false;
      }
    },

    // Wait for a colour change to reach vivExtData, exactly as awaitStack waits
    // out a grouping or a rename and for the same reason: the snapshot carries
    // the colour, so publishing before it lands describes a colour the user has
    // just changed as still being the old one.
    async awaitStackColor(tabIds, color, timeoutMs = 2000) {
      const ids = [...new Set((tabIds || []).filter((x) => x != null))];
      if (!ids.length) return false;
      const ok = await this.pollTabs(ids, (exts) => this.colorSettled(exts, color), timeoutMs);
      if (!ok) {
        console.warn(LOG, "stack colour did not settle within", timeoutMs + "ms — tabs", ids.join(","));
      }
      return ok;
    },

    // Pin a (top-level) tab to a workspace and place it at the end of that
    // workspace's region. chrome.tabs.create can drop the new tab at the window
    // end (next to another workspace's tabs), where Vivaldi reassigns its
    // workspaceId and it vanishes from the intended workspace. Passing
    // workspaceId explicitly (as Vivaldi's own move-to-workspace does) forces
    // the assignment; target:-1 keeps relative (creation) order.
    async pinToWorkspace(tabId, workspaceId, winId) {
      await vivaldi.tabsPrivate.move({
        tabIds: [tabId],
        target: -1,
        windowId: winId,
        workspaceId: workspaceId,
        tweaks: ["do-not-reparent"],
        debug: "vivasync.pinToWorkspace",
      });
    },

    // Move tabs to a STRIP INDEX, membership untouched — the order phase's one
    // primitive, and bundle.js's own `moveToIndex` call (tabsPrivate.move with
    // a numeric target; "do-not-reparent" is what bundle.js passes for its
    // move-to-beginning/end). `target` is the index the first moved tab ends
    // up at once the movers are taken out of the strip — chrome.tabs.move
    // semantics, which is how bundle.js computes the indices it passes. The
    // workspace is named explicitly, because a bare index move is the
    // chrome.tabs.move({index}) hazard: the strip index spans every workspace
    // and a tab re-homed by its neighbours vanishes from this one. Should a
    // build take the workspace argument to mean "move to the end of that
    // workspace" and ignore the index, the plain index move is tried next.
    // Both are verified by reading the strip back; the caller only ever asks
    // for a boundary between units (a whole stack moves as one call), so the
    // movers never land inside another stack's run — see applyOrder.
    // VIVA-DIAG: VivaSync.diagOrder() exercises it against a live build.
    async moveToIndex(tabIds, target, winId, workspaceId) {
      const landedAt = async () => {
        const t = await chrome.tabs.get(tabIds[0]).catch(() => null);
        return t ? t.index : -1;
      };
      const attempt = async (extra, debug) => {
        try {
          await vivaldi.tabsPrivate.move({
            tabIds, target, windowId: winId, tweaks: ["do-not-reparent"], debug, ...extra,
          });
        } catch (e) {
          console.debug(LOG, debug, "failed:", e && e.message);
        }
        return (await landedAt()) === target;
      };
      if (await attempt({ workspaceId }, "vivasync.moveToIndex")) return true;
      return attempt({}, "vivasync.moveToIndex.plain");
    },
  };

  // ===========================================================================
  // Serialization (R2.1.1) + change signature
  // ===========================================================================
  // Build the canonical workspace snapshot from the live tabs of one workspace.
  // The file shape is `items`: the ordered tab-bar sequence where each entry is
  // either { type:"tab", url, title, pinned } or
  // { type:"stack", id, name, pinned, tabs:[{url,title,pinned}] }. A stack
  // occupies the position of its first member, so top-level/stack interleaving
  // is preserved. A stack's `pinned` is the state of the WHOLE stack — Vivaldi
  // pins a stack as a unit and it stays a stack in the pinned strip — and its
  // members repeat it. A stack without the field is an ordinary stack.
  // `color` is the stack's colour token, or null for none (see normStackColor).
  // ===========================================================================
  // URL identity
  // ---------------------------------------------------------------------------
  // Tab identity is (container, url), so the URL string must survive a
  // round-trip between devices or the two of them fight over the tab for ever:
  // A publishes "https://www.example.com", B opens it, the site redirects to
  // "https://example.com/", B publishes THAT, A no longer recognises its own tab
  // and deletes + recreates it, and so on — a tab opening and closing in a
  // loop on both machines.
  //
  // So compare on a canonical form. The RAW url is still what gets stored and
  // opened — this is only for matching. Deliberately conservative: query and
  // fragment are preserved, because collapsing those would delete tabs the user
  // considers distinct (two views of the same SPA).
  function normUrl(u) {
    const s = String(u || "").trim();
    if (!s) return "";
    let p;
    try {
      p = new URL(s);
    } catch (_e) {
      return s; // not a parseable URL (about:blank, chrome://…) — compare raw
    }
    const scheme = p.protocol.toLowerCase();
    const host = p.hostname.toLowerCase().replace(/^www\./, "");
    const defaultPort = (scheme === "https:" && p.port === "443") || (scheme === "http:" && p.port === "80");
    const port = p.port && !defaultPort ? ":" + p.port : "";
    let path = p.pathname || "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return scheme + "//" + host + port + path + (p.search || "") + (p.hash || "");
  }

  // A tab stack's COLOUR, as it goes into a document: a short opaque token, or
  // null for "no colour". Vivaldi's own picker produces the nine names
  // "color1".."color9" (grey, blue, red, yellow, green, pink, purple, teal,
  // orange) and the empty string for no colour, but the value is deliberately
  // NOT validated against that list — a later build may add to it, and a colour
  // the mod does not recognise is still the user's choice, which it would be
  // wrong to drop on the way through. It is only bounded, so that a corrupt
  // or hostile document cannot hand setGroupProperties an essay.
  function normStackColor(v) {
    if (typeof v !== "string") return null;
    const c = v.trim();
    return c && c.length <= 32 ? c : null;
  }

  // A brand-new, empty tab is not content, and must not be synced as if it were.
  // It has no address the other device could meaningfully open; the address it
  // does have is spelled differently across builds and workspaces (about:blank,
  // chrome://newtab, chrome://vivaldi-webui/startpage, vivaldi://startpage…);
  // and it is about to turn into something else the moment the user finishes
  // typing. Publishing one means each device broadcasting its own spelling of
  // "nothing" while the other opens, closes and re-opens it — a new tab
  // flipping between empty and loaded on both machines, in step, for as long
  // as it is left alone. A wait cannot fix that: the trigger
  // is the human pause between opening a tab and typing into it, which is
  // unbounded. So an empty tab is never published — and, symmetrically, never
  // deleted for being absent from a remote document, because the user is
  // most likely typing in it right now.
  const BLANK_URL =
    /^(about:(blank|newtab)|chrome:\/\/(newtab|startpage|vivaldi-webui\/startpage)|vivaldi:\/\/(newtab|startpage))\b/i;
  function isBlankTabUrl(u) {
    const s = String(u || "").trim();
    return s === "" || BLANK_URL.test(s);
  }

  // "Exceptions" — address prefixes the user has excluded from synchronization
  // (the "exceptions" list of sync.config, edited in the Exceptions dialog). A
  // tab whose address begins with one is treated like an empty new tab: absent
  // from the document and the signature here (buildSnapshot), never closed for
  // being absent from a remote (liveWorkspaceView marks it volatile), and never
  // opened from a remote that still lists it (itemsOf drops it). The comparison
  // ignores the scheme, a leading "www." and letter case on both sides, so
  // "www.google.com/maps" covers https://www.google.com/maps/@40.08,-75.09,...
  // and http://google.com/maps alike. `exceptionKeys` is the normalised form of
  // `exceptionsRaw`, both set by applyConfig.
  function exceptionKey(u) {
    return String(u || "").trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/^www\./, "");
  }
  function isExceptedUrl(u) {
    if (!exceptionKeys.length) return false;
    const k = exceptionKey(u);
    return k !== "" && exceptionKeys.some((p) => k.startsWith(p));
  }

  // A tab mid-navigation has a transient URL: it may still be about:blank, or
  // the pre-redirect address. Publishing that propagates a URL that will not
  // exist a second later, and deleting on the strength of it kills tabs while
  // they load. Treat such tabs as "not yet knowable".
  function isLoadingTab(t) {
    if (!t) return false;
    // Only a tab that is genuinely NAVIGATING has an untrustworthy URL.
    // chrome.tabs.Tab.status is one of "unloaded" | "loading" | "complete", and
    // "unloaded" is a HIBERNATED tab, not an in-flight one — Vivaldi discards
    // background tabs and restores a session lazily, so right after a restart
    // most of a workspace sits in that state holding a perfectly good URL.
    // Lumping it in with "loading" would pin every such tab in place: nothing
    // could be deleted for being absent from a remote document (deletes would
    // stop propagating between devices at all) and every publish would burn the
    // whole load-defer budget before going out.
    if (t.status === "loading") return true;
    if (!t.url && t.pendingUrl) return true; // navigating to its first URL
    return !(t.url || t.pendingUrl);
  }

  // The address a tab stands for. `url` is the committed address; while a
  // navigation is in flight `pendingUrl` is where it is going. A new tab the
  // user has just typed into still reports the start page as `url`, and taking
  // that would drop the tab from the snapshot as "blank" the moment a publish
  // goes out mid-load — which, on the originating device, is a fresh document
  // telling every peer the tab does not exist.
  function tabUrl(t) {
    const u = t.url || "";
    if (t.pendingUrl && (!u || (t.status === "loading" && isBlankTabUrl(u)))) return t.pendingUrl;
    return u || t.pendingUrl || "";
  }

  // What kind of stack each group in `tabs` is: `false` an ordinary stack,
  // `true` a PINNED stack, `null` not a stack at all. Shared by the two views
  // (buildSnapshot and liveWorkspaceView), which have to agree about it or the
  // document this device writes looks like a peer taking its own stack apart.
  //
  // Pinning is a property of the whole stack, so the members of a group agree
  // on it — except when something has gone wrong, and one thing does: Vivaldi
  // drops a newborn into the ACTIVE TAB's stack whatever either one's pin state
  // is, so a pinned tab can become the first member of an ordinary stack. So
  // partition the group by pin state and let the
  // larger part be the stack, ties going to the unpinned side; the odd tabs out
  // are top-level tabs, which is exactly the repair that case needs. A part of
  // one is not a stack either — Vivaldi dissolves a stack below two members —
  // so a group that is half pinned and half not (two tabs) is two plain tabs.
  function groupPinStates(tabs) {
    const counts = new Map(); // gid -> [unpinned, pinned]
    for (const t of tabs) {
      const gid = ADAPTER.stackIdOf(ADAPTER.parseTabExt(t));
      if (!gid) continue;
      const c = counts.get(gid) || [0, 0];
      c[t.pinned ? 1 : 0]++;
      counts.set(gid, c);
    }
    const out = new Map(); // gid -> true | false | null
    for (const [gid, c] of counts) {
      const [plain, pinned] = c;
      out.set(gid, plain >= 2 && plain >= pinned ? false : pinned >= 2 ? true : null);
    }
    return out;
  }

  function buildSnapshot(tabs, workspaceId, workspaceName) {
    const mine = tabs
      .filter((t) => {
        const ext = ADAPTER.parseTabExt(t);
        if (ADAPTER.wsKey(ext.workspaceId) !== ADAPTER.wsKey(workspaceId)) return false;
        // An empty new tab is not content — see isBlankTabUrl. Filtered here
        // rather than downstream so it is absent from the document AND from the
        // change signature: an unstable start-page address would otherwise keep
        // the signature permanently different from the last published one,
        // which makes reconcileActive defer every pull for ever. An excepted
        // address (isExceptedUrl) is filtered here for the same reason.
        const u = tabUrl(t);
        return !isBlankTabUrl(u) && !isExceptedUrl(u);
      })
      .sort((a, b) => a.index - b.index);

    // A group with a single member is NOT a tab stack. Vivaldi dissolves a
    // stack the moment it drops below two tabs, but whether it also clears
    // `group` in the survivor's vivExtData is not something we can rely on —
    // and publishing that survivor as a one-member stack makes every peer
    // rebuild a stack the user has just taken apart. Count first, then decide.
    //
    // A group is either an ordinary stack or a PINNED stack, and a tab whose
    // own pin state disagrees with its group's is not a member of it — see
    // groupPinStates. Publishing such a tab as a member would tell every peer
    // to move ITS pinned tab into the stack (applyDesired adopts a tab into the
    // container the document names), turning one device's accident into both
    // devices' broken stack.
    const groupPin = groupPinStates(mine);

    const items = [];
    const stackItemById = new Map(); // gid -> stack item (placed at first member)

    for (const t of mine) {
      const ext = ADAPTER.parseTabExt(t);
      const entry = { url: tabUrl(t), title: t.title || "", pinned: !!t.pinned };
      const rawGid = ADAPTER.stackIdOf(ext);
      const sp = rawGid == null ? null : groupPin.get(rawGid);
      // A member of a stack shares the stack's pin state, by definition of what
      // a stack's pin state is. Anything else is the odd tab out of a mixed
      // group, and it is published top-level with its own pin.
      const stackId = sp != null && sp === entry.pinned ? rawGid : null;
      if (stackId == null) {
        items.push({ type: "tab", url: entry.url, title: entry.title, pinned: entry.pinned });
      } else {
        let s = stackItemById.get(stackId);
        if (!s) {
          s = {
            type: "stack", id: stackId, name: ADAPTER.stackNameOf(ext),
            color: ADAPTER.stackColorOf(ext), pinned: sp, tabs: [],
          };
          stackItemById.set(stackId, s);
          items.push(s); // placed at first appearance -> preserves interleaving
        }
        if (!s.name) s.name = ADAPTER.stackNameOf(ext); // a named member wins
        // ...and a coloured one. `color: null` is this device SAYING "no
        // colour", which is not the same as a stack with no `color` key, which
        // says nothing about colour at all (see applyDesired).
        if (!s.color) s.color = ADAPTER.stackColorOf(ext);
        s.tabs.push(entry);
      }
    }

    return { workspace: workspaceName, items };
  }

  // The ordered items list of a snapshot or desired-state document.
  function itemsOf(snap) {
    // Same rules as buildSnapshot, applied to a document we are about to APPLY:
    // an excepted address is not there (a peer that has not yet reloaded the
    // config, or wrote before the exception existed, may still list it), a
    // member whose pin state disagrees with its stack's is the odd tab out of a
    // mixed group and comes out as a top-level tab with its own pin (a
    // document listing a pinned tab as a member of an ordinary stack would
    // otherwise move our pinned tab into the stack too), and a stack of one —
    // including a stack that exceptions or hoisting reduce to one — is a plain
    // tab, carrying the stack's pin. A stack with no `pinned` is ordinary.
    const items = snap && Array.isArray(snap.items) ? snap.items : [];
    const asTab = (x, pinned) => ({ type: "tab", url: x.url, title: x.title, pinned });
    return items
      .flatMap((i) => {
        if (!i || typeof i !== "object") return [];
        if (i.type !== "stack") return isExceptedUrl(i.url) ? [] : [i];
        const sp = !!i.pinned; // the pin state of the stack AS A WHOLE
        const kept = (i.tabs || []).filter((x) => x && !isExceptedUrl(x.url));
        const hoisted = kept.filter((x) => !!x.pinned !== sp).map((x) => asTab(x, !!x.pinned));
        const tabs = kept.filter((x) => !!x.pinned === sp);
        if (tabs.length >= 2) {
          return [...hoisted, tabs.length === (i.tabs || []).length ? i : { ...i, tabs }];
        }
        return [...hoisted, ...(tabs.length === 1 ? [asTab(tabs[0], sp)] : [])];
      })
      .filter((i) => i && (i.type !== "tab" || i.url));
  }

  // A remote state, with what this device's user did since it last published
  // laid over it. `base` is the document this device last published, the
  // state its user started from; `live` is a snapshot of what is here now.
  //
  //   - A tab here that neither `base` nor the remote knows is LOCAL NEWS — a
  //     tab opened, or moved in from another workspace, since the last publish.
  //     It is kept: appended at the end of the remote's items, inside the
  //     remote's copy of its stack when the rest of that stack was already
  //     published, or as its own stack when the whole stack is new.
  //   - With `dropGone`, a tab `base` has and `live` does not is a local close,
  //     and it is taken out of the remote too. Only when `base` is this
  //     session's own publish of a workspace that was materialized all along:
  //     on the first open of a session a tab missing here may simply not have
  //     been restored yet, and a close that is a guess must never propagate.
  //
  // Everything else is the remote's: it out-ranks what we hold, so its closes,
  // renames, pins and order stand. Returns the merged document and how many
  // tabs the local side changed in it (0 = the remote, untouched).
  function withLocalNews(remote, base, live, dropGone) {
    const urlsIn = (items) => {
      const s = new Set();
      for (const i of items) {
        if (i.type === "stack") for (const x of i.tabs || []) s.add(normUrl(x.url));
        else s.add(normUrl(i.url));
      }
      return s;
    };
    const baseItems = itemsOf(base);
    const liveItems = itemsOf(live);
    const known = urlsIn(baseItems);
    const here = urlsIn(liveItems);
    const gone = dropGone ? new Set([...known].filter((u) => !here.has(u))) : new Set();
    const taken = new Set(); // urls the merged document already holds
    let changed = 0;
    const keep = (x) => {
      if (!gone.has(normUrl(x.url))) return true;
      changed++;
      return false;
    };
    const out = [];
    for (const i of itemsOf(remote)) {
      if (i.type !== "stack") {
        if (keep(i)) { out.push(i); taken.add(normUrl(i.url)); }
        continue;
      }
      const tabs = (i.tabs || []).filter(keep);
      for (const x of tabs) taken.add(normUrl(x.url));
      if (tabs.length >= 2) out.push({ ...i, tabs });
      else if (tabs.length === 1) out.push({ type: "tab", url: tabs[0].url, title: tabs[0].title, pinned: !!i.pinned });
    }
    const fresh = (x) => !known.has(normUrl(x.url)) && !taken.has(normUrl(x.url));
    const asTab = (x) => ({ type: "tab", url: x.url, title: x.title, pinned: !!x.pinned });
    for (const i of liveItems) {
      if (i.type !== "stack") {
        if (fresh(i)) { out.push(asTab(i)); taken.add(normUrl(i.url)); changed++; }
        continue;
      }
      const added = i.tabs.filter(fresh);
      if (!added.length) continue;
      for (const x of added) taken.add(normUrl(x.url));
      changed += added.length;
      // Some members were published before: the stack is one the remote may
      // still have (by name, else by one of those members), so join it there.
      const old = i.tabs.filter((x) => !added.includes(x)).map((x) => normUrl(x.url));
      const into = old.length ? out.find((o) => o.type === "stack" && (
        (i.name && o.name === i.name) || o.tabs.some((x) => old.includes(normUrl(x.url))))) : null;
      if (into) into.tabs = [...into.tabs, ...added];
      else if (added.length >= 2) out.push({ ...i, tabs: added });
      else out.push(asTab({ ...added[0], pinned: i.pinned }));
    }
    return { doc: { ...remote, items: out }, changed };
  }

  // Stable structural signature (timestamp- and provenance-excluded).
  // Normalised, so a cosmetic URL flap (trailing slash, www., redirect to the
  // canonical host) is not mistaken for a change worth republishing.
  //
  // ORDER: the sequence of UNPINNED top-level items (tabs and stacks, a stack at
  // its first member) is compared, and so is the member sequence of each
  // unpinned stack — the order phase of applyDesired reproduces both, so a
  // peer's reorder must arrive as a state that out-ranks ours, and a reorder
  // here must be a change worth publishing. What stays order-insensitive is
  // the pinned strip alone (pinned stacks included): the mod never moves a
  // pinned tab, and pinning already puts it at the front. An order nothing
  // reproduces cannot be compared — an order-only difference would look like
  // unpublished local news for ever and invariant 4 would defer every pull.
  // What makes the sequence safe to compare is not only that it is reproduced
  // but that a rendering the browser will not reproduce exactly is
  // acknowledged under the peer's provenance, which the peer never applies
  // (invariant 2): the difference costs one acknowledgement, never a swap.
  //
  // `pinned` IS part of a top-level tab's state here, unlike title: the user
  // set it, and pinning a tab must be a change worth publishing on its own —
  // left out, the flag would only reach a peer when something else in the
  // workspace happened to change. Provenance is what makes this safe: a pin
  // the browser declines cannot become an endless swap, because the write
  // after an apply is an acknowledgement carrying the peer's origin whatever
  // the browser made of the apply, and the peer never applies its own origin —
  // so a refusal costs one acknowledgement without the pin, never a lap. (See
  // SPEC.md, "Approaches that failed", for the swap this prevents.) A STACK's pin is in it for
  // the same reason (the user pins a whole stack, and that must reach the other
  // machine as a pinned stack, not as loose pinned tabs); its members repeat
  // the stack's state, so theirs adds nothing and is not compared separately.
  // A stack's NAME and COLOUR are in it for the same reason: the user set them
  // on the stack, and either one changing must be a change worth publishing on
  // its own. A colour the browser will not take costs one acknowledgement and
  // nothing more, exactly as a refused pin does.
  function signature(snap) {
    const pinned = [], sequence = [];
    for (const i of itemsOf(snap)) {
      if (i.type === "tab") {
        if (i.pinned) pinned.push(JSON.stringify(["p", normUrl(i.url)]));
        else sequence.push(JSON.stringify(["t", normUrl(i.url)]));
      } else if (i.pinned) {
        // A PINNED stack is part of the pinned strip, and the strip is compared
        // order-insensitively because nothing here reproduces its order — the
        // mod never moves a pinned tab. Its members are sorted for the same
        // reason: the order phase leaves a pinned stack alone, so an order-only
        // difference inside one would otherwise read as unpublished local news
        // for ever and defer every pull (invariant 4).
        pinned.push(JSON.stringify(["ps", i.name || null, normStackColor(i.color),
          (i.tabs || []).map((x) => normUrl(x.url)).sort()]));
      } else {
        sequence.push(JSON.stringify(["s", i.name || null, normStackColor(i.color),
          (i.tabs || []).map((x) => normUrl(x.url))]));
      }
    }
    return JSON.stringify([pinned.sort(), sequence]);
  }

  function isEmptySnap(snap) {
    return itemsOf(snap).length === 0;
  }

  // ===========================================================================
  // State
  // ===========================================================================
  let machine = "unknown";
  // Names from sync.config whose `peers` list includes THIS device (R1.1/R1.3).
  // Derived from configWorkspaces by applyConfig — never assigned directly.
  let syncedWorkspaces = [];
  const lastSig = new Map(); // workspaceName -> last written signature
  // Tabs THIS device opened from a document and that have not finished loading
  // yet. A loading tab is otherwise never closed, because its address is not a
  // fact yet and closing it would take a page out from under the user — but
  // that reasoning is about a tab the USER opened. A tab we opened because a
  // document named it is the opposite case: if a NEWER document no longer names
  // it, nobody is typing in it and it should go. Without this a second document
  // arriving inside the first apply's load window would leave every tab of the
  // first one open, and the acknowledgement would publish them back under the
  // peer's own provenance — which the peer never applies (invariant 2), so the
  // two devices would sit on different tab sets until something else changed.
  // Cleared
  // the moment the tab commits its address (it is an ordinary tab from then on)
  // or closes. Session state, device-local, no timer.
  const syncBorn = new Set(); // tab ids
  // Safeguard (R2.4): a synced workspace is only writable AFTER it has been
  // opened/reconciled at least once this session. Vivaldi lazy-loads inactive
  // workspaces, so a not-yet-opened workspace's tabs are not materialized and
  // would serialize as empty — which, with newest-wins reconcile, could wipe
  // the workspace on other devices. Gating writes on "opened" prevents that,
  // including at startup, when no workspace but the active one is loaded.
  const openedWorkspaces = new Set(); // names materialized this session
  const everHadContent = new Set(); // names we have written non-empty at least once
  // Workspaces for which we have actually SEEN another device's document. Until
  // then this device has no idea what the workspace is supposed to contain, so
  // it must not publish an empty snapshot of it — see the guard in writeChanged.
  const sawPeerDoc = new Set();
  let lastActiveWsName = null;
  let writeTimer = null;
  let switchTimer = null;

  // ---------------------------------------------------------------------------
  // Churn circuit breaker
  // ---------------------------------------------------------------------------
  // normUrl() fixes URLs that differ only cosmetically, but it cannot fix a site
  // that genuinely lands somewhere else than where it was opened (geo redirect,
  // session id in the path, a login bounce). For those, this device opens the
  // tab, the URL changes, the peer no longer recognises it, deletes it,
  // republishes — and the tab blinks open/closed on both machines for ever.
  //
  // Nothing can make such a URL sync correctly, so the goal is only to make it
  // STOP. After a few failed attempts at the same URL we refuse to open it
  // again and say so. Counters are device-local and expire, and any URL that
  // successfully sticks clears its own counter.
  const OPEN_ATTEMPT_CAP = 3;
  const OPEN_ATTEMPT_TTL_MS = 30 * 60 * 1000;
  let openAttempts = {}; // normalised url -> { n, at }
  const churnBlocked = new Map(); // normalised url -> raw url, for diagnostics

  function openAttemptsOf(nurl) {
    const a = openAttempts[nurl];
    if (!a) return 0;
    if (Date.now() - (a.at || 0) > OPEN_ATTEMPT_TTL_MS) {
      delete openAttempts[nurl];
      return 0;
    }
    return a.n || 0;
  }

  function clearOpenAttempts(nurl) {
    if (openAttempts[nurl]) {
      delete openAttempts[nurl];
      churnBlocked.delete(nurl);
      KV.set("openAttempts", openAttempts);
    }
  }

  // Gate every tab creation the reconciler wants to do.
  function mayOpen(nurl, rawUrl) {
    const n = openAttemptsOf(nurl);
    if (n >= OPEN_ATTEMPT_CAP) {
      if (!churnBlocked.has(nurl)) {
        churnBlocked.set(nurl, rawUrl);
        console.warn(
          LOG, "refusing to reopen", rawUrl, `— it failed to stay put ${n} times.`,
          "The URL this device opens is not the URL that ends up in the tab, so it can never match.",
          "See VivaSync.diagChurn(); clear with VivaSync.clearChurn()."
        );
      }
      return false;
    }
    openAttempts[nurl] = { n: n + 1, at: Date.now() };
    KV.set("openAttempts", openAttempts);
    return true;
  }
  let busy = false; // guard: don't write while reconciling
  const writing = new Set(); // workspace names with a note write in flight
  // workspace name -> when we first held its write for a loading tab. Bounded
  // by TIME, not by a count of 500ms polls: a page that takes ten seconds to
  // commit is ordinary, and publishing before it commits describes the tab as
  // absent (or as its pre-redirect address), which every peer then applies.
  // Waiting for a load to finish is the one place a clock belongs in sync.
  const loadSince = new Map();
  const MAX_LOAD_HOLD_MS = 30000;
  // tab id -> when its URL last changed. A completed load is not the same thing
  // as a settled address (see SETTINGS.urlSettleMs), so the publish waits on this too.
  const urlChangedAt = new Map();
  const settleSince = new Map(); // workspace name -> when we first held its write
  // ---------------------------------------------------------------------------
  // Provenance: who ORIGINATED a state, and a logical clock that orders states
  // ---------------------------------------------------------------------------
  // Every document carries {origin, version}: the device whose user made the
  // state it describes, and that device's logical clock reading when it did.
  // Ordering between states is by version first — a Lamport clock: every
  // version seen in the folder feeds the clock, a fresh origination is numbered
  // above all of them, so a change made AFTER seeing another device's state
  // always out-ranks it however the two wall clocks are set. The wall-clock
  // timestamp is only a tie-break between concurrent originations (equal
  // versions from different devices).
  //
  // Two rules follow, and between them they are what stops a device's own
  // change coming back at it as though the peer had made it:
  //
  //   1. A document whose origin is THIS device is never applied. It is our
  //      own state coming back through a peer, however that peer rendered it
  //      and whatever it stamped it with. Applying it can only undo what the
  //      user has done here since. The origin, not a timestamp or the
  //      content, is what recognises it: the peer's rendering of our state is
  //      not guaranteed to be signature-identical to ours.
  //
  //   2. The first write after adopting a state is an ACKNOWLEDGEMENT: it
  //      carries the origin's provenance unchanged, whatever the browser made
  //      of the apply. A peer's rendering of our state is not the peer's news.
  //      A change the peer's user makes during the apply window is folded into
  //      that acknowledgement and published under the next fresh version
  //      instead — delayed, never lost to a swap.
  //
  // `current` is the provenance of the state this device HOLDS: seeded from our
  // own document on the first reconcile of a session, moved by every apply and
  // every write. A remote is applied only when it out-ranks `current`, which
  // is what makes two concurrent originations resolve the same way on both
  // sides (each compares the other's against its own) instead of swapping.
  const versionClock = new Map(); // workspace name -> highest version seen
  const ackPending = new Map(); // workspace name -> provenance adopted, not yet acknowledged
  const current = new Map(); // workspace name -> {origin, version, timestamp} held
  // A pull deferred for unpublished local changes (invariant 4) is retried once
  // the write lands, rather than waiting for the next unrelated note event.
  let pullWanted = false;

  function noteVersion(ws, v) {
    if (typeof v === "number" && isFinite(v) && v > (versionClock.get(ws) || 0)) versionClock.set(ws, v);
  }
  function nextVersion(ws) {
    const v = (versionClock.get(ws) || 0) + 1;
    versionClock.set(ws, v);
    return v;
  }
  // A sync document is {workspace, origin, version, items, timestamp}, and
  // nothing else is one: a note lacking any of workspace, origin, version or
  // items is not read. listDocs drops such notes, so everything past it can
  // rely on the fields being there.
  function isSyncDoc(d) {
    return !!d && typeof d === "object" &&
      typeof d.workspace === "string" && d.workspace !== "" &&
      typeof d.origin === "string" && d.origin !== "" &&
      typeof d.version === "number" && isFinite(d.version) &&
      Array.isArray(d.items);
  }
  function provenanceOf(f) {
    const d = f.data;
    return {
      origin: d.origin,
      version: d.version,
      timestamp: typeof d.timestamp === "number" && isFinite(d.timestamp) ? d.timestamp : 0,
    };
  }
  // Total order over states: version, then wall clock, then device name.
  function cmpProv(a, b) {
    if (a.version !== b.version) return a.version - b.version;
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0;
  }
  // The same state, seen twice: the origin's own document and a peer's
  // acknowledgement of it carry identical provenance.
  const sameState = (a, b) => a.origin === b.origin && a.version === b.version;
  function describeProv(p) {
    return p ? `${p.origin} v${p.version} @${p.timestamp || 0}` : "(none)";
  }
  // Consecutive pulls skipped because our own state was not published yet
  // (invariant 4). One or two is normal — the write is on its way. A number
  // that keeps climbing means the local write is never landing, and since a
  // deferred pull is silent, sync simply stops in one direction with nothing to
  // show for it. Count them so the log and the Debug window can say so.
  const pullDefers = new Map(); // workspace name -> consecutive pulls deferred

  function isSynced(name) {
    return syncedWorkspaces.includes(name);
  }

  // ===========================================================================
  // Configuration — the sync.config NOTE (R1.1 / R1.3)
  // ---------------------------------------------------------------------------
  // ONE note, shared by every device — it rides Vivaldi Sync with everything
  // else. Each workspace entry carries the list of devices that synchronize it:
  //
  //   { "workspaces": [ { "name": "Shared", "peers": ["workshop", "cinfra"] } ] }
  //
  // So the selection is shared AND per-device at once: every machine reads the
  // same document and looks for its own name in it, and every machine can see
  // who a workspace is shared with — which a per-device selection could not
  // communicate.
  //
  // A workspace only ever synchronizes between devices that BOTH list
  // themselves; the workspace itself must exist, by the same name, on each of
  // them (workspace identity is its name — the mod never creates a workspace).
  // ===========================================================================
  let configSource = CONFIG_TITLE; // there is exactly one config note
  let configWorkspaces = []; // [{name, peers}] — the whole document, all devices
  // Pull on a peer's note change (as opposed to only on workspace switch).
  // Settable from the config note ("autoPull": false) or
  // VivaSync.autoPull(false).
  let autoPull = true;
  // Address prefixes excluded from sync — see isExceptedUrl. `exceptionsRaw` is
  // the list as the user wrote it (what the Exceptions dialog edits);
  // `exceptionKeys` its normalised form, what the engine compares against.
  let exceptionsRaw = [];
  let exceptionKeys = [];

  // The "exceptions" list is strings; blanks and repeats are dropped, anything
  // that is not a string is ignored rather than guessed at.
  function normalizeExceptions(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const e of raw) {
      if (typeof e !== "string") continue;
      const v = e.trim();
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }

  // An entry is {name, peers}; anything else in the note is ignored rather than
  // guessed at, since a malformed entry cannot say which devices it means.
  function normalizeEntries(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const e of raw) {
      if (!e || typeof e !== "object" || typeof e.name !== "string" || !e.name) continue;
      out.push({
        name: e.name,
        peers: Array.isArray(e.peers) ? e.peers.map(String).filter(Boolean) : [],
      });
    }
    return out;
  }

  // An entry no device is left in says nothing; drop it rather than accumulate
  // tombstones in a note the user reads.
  function serializeEntries(entries) {
    return entries.filter((e) => e.peers.length).map((e) => ({ name: e.name, peers: e.peers }));
  }

  function syncsHere(entry) {
    return entry.peers.includes(machine);
  }

  // The devices sharing a workspace, for the Settings dialog and the Debug window.
  function peersOf(name) {
    const e = configWorkspaces.find((x) => x.name === name);
    return e ? e.peers.slice() : [];
  }

  function applyConfig(cfg) {
    configWorkspaces = normalizeEntries(cfg && cfg.workspaces);
    syncedWorkspaces = configWorkspaces.filter(syncsHere).map((e) => e.name);
    autoPull = !(cfg && cfg.autoPull === false);
    // The tunables (see SETTINGS_DEFAULTS). "urlSettleMs" is also accepted as
    // a top-level key; "settings" wins when both name it.
    const top = cfg && cfg.urlSettleMs !== undefined ? { urlSettleMs: cfg.urlSettleMs } : {};
    const given = cfg && cfg.settings && typeof cfg.settings === "object" && !Array.isArray(cfg.settings)
      ? cfg.settings
      : {};
    applySettings({ ...top, ...given });
    exceptionsRaw = normalizeExceptions(cfg && cfg.exceptions);
    exceptionKeys = exceptionsRaw.map(exceptionKey).filter(Boolean);
  }

  async function readConfig() {
    const entry = await NOTES.readEntry(CONFIG_TITLE);
    if (entry) {
      // Present. Unreadable is not the same as missing: seeding over it would
      // put a second sync.config next to the one every other device is using.
      if (entry.error) console.warn(LOG, `${CONFIG_TITLE} is unreadable; treating as empty until it syncs again`);
      return entry.data || { workspaces: [] };
    }
    // First run on the first device: seed the note so the user has something to
    // edit in the Notes panel.
    const seed = { workspaces: [] };
    await NOTES.write(CONFIG_TITLE, seed);
    console.warn(
      LOG,
      `created default config note "${FOLDER}/${CONFIG_TITLE}" — pick workspaces with the ` +
        `toolbar button, or edit it by hand: {"workspaces":[{"name":"Work","peers":["${machine}"]}]}`
    );
    return seed;
  }

  // Add/remove THIS device to/from the peers of the chosen workspaces.
  //
  // `scope` is the set of workspaces the caller could actually see — the
  // Settings dialog lists the workspaces that exist on THIS machine — and
  // anything outside it is left exactly as it was. Saving from a device that
  // happens to have three of the five configured workspaces must not delete the
  // other two, nor speak for any device but this one.
  async function writeConfig(chosenNames, scopeNames) {
    const chosen = new Set((chosenNames || []).map(String));
    const scope = new Set((scopeNames || chosenNames || []).map(String));
    // Re-read before merging: the note is shared, so a peer may have changed an
    // entry we are not touching since we last read it.
    const cfg = (await readConfig()) || {};
    const entries = normalizeEntries(cfg.workspaces);
    const byName = new Map(entries.map((e) => [e.name, e]));
    for (const name of chosen) {
      if (!byName.has(name)) {
        const e = { name, peers: [] };
        entries.push(e);
        byName.set(name, e);
      }
    }
    for (const e of entries) {
      if (!scope.has(e.name) && !chosen.has(e.name)) continue;
      const listed = e.peers.includes(machine);
      if (chosen.has(e.name) && !listed) e.peers.push(machine);
      else if (!chosen.has(e.name) && listed) e.peers = e.peers.filter((d) => d !== machine);
    }
    const payload = { ...cfg, workspaces: serializeEntries(entries) };
    await NOTES.write(CONFIG_TITLE, payload);
    applyConfig(payload);
    reportPending();
    return payload;
  }

  // Replace the shared "exceptions" list (the Exceptions dialog's Save). Like
  // writeConfig it re-reads the note first and carries everything else through.
  // The list is shared, not per device: an address the user does not want
  // synchronized is not wanted on any machine's document.
  async function writeExceptions(list) {
    const cfg = (await readConfig()) || {};
    const payload = { ...cfg, exceptions: normalizeExceptions(list) };
    await NOTES.write(CONFIG_TITLE, payload);
    applyConfig(payload);
    console.info(LOG, "exceptions:", exceptionsRaw.length ? exceptionsRaw.join(" | ") : "(none)");
    // The documents change with the list: an excepted tab leaves this device's
    // document, a tab no longer excepted joins it. Publish rather than wait for
    // the next tab event to notice.
    scheduleWrite();
    return payload;
  }

  // Replace the tunables the Settings dialog owns. The note carries only what
  // DIFFERS from the code's defaults: a key set back to its default is removed
  // rather than written, so the note stays a short list of "what this install
  // changed" and a later change to a default reaches every device that never
  // overrode it. Keys the dialog does not show (logMax, logLineMax) are carried
  // through untouched, like every other key writeConfig does not own.
  async function writeSettings(values) {
    const cfg = (await readConfig()) || {};
    const settings = cfg.settings && typeof cfg.settings === "object" && !Array.isArray(cfg.settings)
      ? { ...cfg.settings }
      : {};
    for (const [key, value] of Object.entries(values || {})) {
      if (!(key in SETTINGS_DEFAULTS)) continue;
      if (value === SETTINGS_DEFAULTS[key]) delete settings[key];
      else settings[key] = value;
    }
    const payload = { ...cfg };
    // A top-level urlSettleMs would otherwise take effect again the moment the
    // object stops naming it (settings wins only while it is there), which
    // would silently undo what the user just saved.
    delete payload.urlSettleMs;
    if (Object.keys(settings).length) payload.settings = settings;
    else delete payload.settings;
    await NOTES.write(CONFIG_TITLE, payload);
    applyConfig(payload);
    console.info(LOG, "settings:", tunedSettings().join(", ") || "(all default)");
    return payload;
  }

  async function reloadConfig() {
    const before = syncedWorkspaces.join("\u0000");
    const exBefore = exceptionKeys.join("\u0000");
    applyConfig(await readConfig());
    // Quiet when nothing moved: this runs on every switch into a workspace
    // that is not synced (see checkActiveWorkspace), and an unconditional line
    // there would bury the log the Debug window shows.
    if (syncedWorkspaces.join("\u0000") !== before) {
      console.info(LOG, "config reloaded from", configSource, "->", syncedWorkspaces,
        autoPull ? "" : "(autoPull off)");
      reportPending();
    }
    if (exceptionKeys.join("\u0000") !== exBefore) {
      console.info(LOG, "exceptions reloaded from", configSource, "->",
        exceptionsRaw.length ? exceptionsRaw.join(" | ") : "(none)");
      // A peer edited the list: our documents describe a different set of tabs
      // now (see writeExceptions).
      scheduleWrite();
    }
    return { syncedWorkspaces, configSource, autoPull, exceptions: exceptionsRaw.slice() };
  }

  // Ticking a workspace in Settings does not switch to it, and a workspace that
  // has not been opened this session is never published (R2.4) — nor may it be
  // reconciled, because applyDesired creates tabs into whatever workspace is
  // ACTIVE (invariant 5). So a freshly ticked workspace legitimately does
  // nothing until the user switches into it.
  //
  // That is correct but invisible, and "I enabled it and nothing happened" is
  // indistinguishable from a broken transport. Say so, once, by name.
  function pendingSynced() {
    return syncedWorkspaces.filter((n) => !openedWorkspaces.has(n));
  }

  function reportPending() {
    const waiting = pendingSynced();
    if (waiting.length) {
      console.info(LOG, "waiting to be opened before first publish:", waiting.join(", "),
        "— switch to a workspace once to synchronize it (R2.4: a workspace Vivaldi has",
        "not materialized cannot be snapshotted without publishing an empty document).");
    }
  }

  // ===========================================================================
  // R2.1 — write <ws>-<machine>.json whenever a synced workspace changes
  // ===========================================================================
  // A forced write (writeNow) that the note throttle pushed out. The re-armed
  // sweep goes through scheduleWrite, which never forces, so without this a
  // manual writeNow issued inside the throttle window would quietly do nothing.
  let forceQueued = false;
  async function writeChanged(force) {
    if (busy) return;
    let mergeFirst = null; // the active workspace, when a newer peer state must be merged first
    const forcing = force || forceQueued;
    forceQueued = false;
    let wrote = false;
    const winId = await ADAPTER.currentWindowId();
    const [{ list, activeId }, tabs] = await Promise.all([
      ADAPTER.getWorkspaces(),
      ADAPTER.tabsInWindow(winId),
    ]);
    const activeName = (list.find((x) => ADAPTER.wsKey(x.id) === ADAPTER.wsKey(activeId)) || {}).name;
    for (const ws of list) {
      if (!isSynced(ws.name)) continue;
      // R2.4: never serialize a workspace we haven't opened this session.
      if (!openedWorkspaces.has(ws.name)) continue;
      // Do not publish a snapshot taken mid-navigation: a loading tab's URL is
      // transient (pre-redirect, or still about:blank), and publishing it sends
      // peers a URL that will not exist a second later — they open it, it
      // redirects, and the two devices churn. Wait for the dust to settle; the
      // load completing fires onUpdated, which re-arms this write. The cap stops
      // one permanently-loading tab from blocking the workspace for ever.
      const wsTabs = tabs.filter(
        (t) => ADAPTER.wsKey(ADAPTER.parseTabExt(t).workspaceId) === ADAPTER.wsKey(ws.id)
      );
      if (wsTabs.some(isLoadingTab)) {
        const since = loadSince.get(ws.name) || Date.now();
        loadSince.set(ws.name, since);
        if (Date.now() - since < MAX_LOAD_HOLD_MS) {
          console.debug(LOG, "defer write of", ws.name, "— tabs still loading");
          scheduleWrite();
          continue;
        }
        console.debug(LOG, "publishing", ws.name, "despite a stuck loading tab");
      }
      loadSince.delete(ws.name);

      // ...and a tab that has finished loading can still be mid-edit. A URL
      // driven from an input box completes a navigation per intermediate value,
      // so "complete" alone would publish half-typed addresses: the peer opens
      // them, publishes them back, and the user watches their own tab reload
      // through every prefix of what they typed. Hold the workspace until
      // every URL in it has held still for SETTINGS.urlSettleMs, re-arming for exactly
      // as long as is left rather than burning the load-defer budget in 500ms
      // steps. SETTINGS.maxSettleHoldMs bounds it, so a page that rewrites its URL on
      // a timer delays the publish instead of cancelling it.
      let settleWait = 0;
      for (const t of wsTabs) {
        const left = SETTINGS.urlSettleMs - (Date.now() - (urlChangedAt.get(t.id) || 0));
        if (left > settleWait) settleWait = left;
      }
      if (settleWait > 0) {
        const since = settleSince.get(ws.name) || Date.now();
        settleSince.set(ws.name, since);
        if (Date.now() - since < SETTINGS.maxSettleHoldMs) {
          console.debug(LOG, "defer write of", ws.name, "— a URL is still settling,",
            settleWait + "ms left");
          scheduleWrite(settleWait + 50);
          continue;
        }
        console.debug(LOG, "publishing", ws.name, "despite a URL that keeps changing");
      }
      settleSince.delete(ws.name);

      const snap = buildSnapshot(tabs, ws.id, ws.name);
      const sig = signature(snap);
      if (!forcing && lastSig.get(ws.name) === sig) {
        // Nothing to publish. If a state we just adopted matched what we
        // already had on file there is nothing to acknowledge either — and an
        // acknowledgement left pending would be spent on the user's NEXT
        // change, publishing it under another device's name.
        ackPending.delete(ws.name);
        continue;
      }
      // R2.4 guard: refuse to overwrite previously-captured content with an
      // empty snapshot unless this workspace is the active one (i.e. the user
      // genuinely emptied it). Protects against tabs being unloaded/hibernated
      // while a workspace is inactive.
      if (isEmptySnap(snap) && everHadContent.has(ws.name) && ws.name !== activeName) {
        console.warn(LOG, "skip empty overwrite of", ws.name, "(inactive, had content)");
        continue;
      }
      // Onboarding guard. An empty document is an instruction to every peer to
      // close the whole workspace, and a device that has never seen a peer's
      // document and never held content itself has no business issuing it.
      // That is exactly the state a NEW device is in between "sync.config has
      // replicated" and "the peers' <ws>-<device>.json notes have replicated" —
      // notes arrive as separate entities, so that window is ordinary, not
      // freak. Publishing there wipes the workspace on every existing machine.
      // Refusing costs nothing: an empty first document conveys no information,
      // and the moment either a peer document arrives or the user opens a tab
      // this device publishes normally.
      if (isEmptySnap(snap) && !everHadContent.has(ws.name) && !sawPeerDoc.has(ws.name)) {
        console.warn(LOG, "not publishing an empty", ws.name,
          "— no peer document has been seen yet, so this device cannot tell an empty",
          "workspace from one whose document has not replicated. Check that",
          "Vivaldi Sync is on with Notes included; VivaSync.diagNotes() lists",
          "what has arrived.");
        continue;
      }
      // A note write can block for up to SETTINGS.minNoteWriteGapMs while the
      // per-note throttle waits. Every tab event re-arms this sweep, and each
      // would otherwise stack a redundant write behind it (lastSig is only
      // updated once it lands), so skip a workspace that already has a write
      // in the air.
      if (writing.has(ws.name)) continue;
      // A reconcile of this workspace is in flight: it decides what this
      // device holds, and it ends with a write of its own.
      if (reconciling.has(ws.name)) continue;
      // And never hold `snap` across that wait. The snapshot above is taken
      // now; the payload is serialized after the sleep and stamped with the
      // clock reading of THAT moment. So a write started while the throttle is
      // closed publishes a state up to 5s out of date as the newest document in
      // the folder — the peer adopts our stale tabs, we adopt them back, and the
      // two devices trade a state neither of them is in any more. Re-arm and
      // re-snapshot instead; what goes out is then always current.
      const title = `${ws.name}-${machine}.json`;
      const throttled = NOTES.writeDelay(title);
      if (throttled > 0) {
        console.debug(LOG, "throttled write of", ws.name, "—",
          throttled + "ms left on the note throttle");
        if (forcing) forceQueued = true;
        scheduleWrite(throttled + 50);
        continue;
      }
      // Never originate over a peer state this device has not merged. A peer
      // document numbered ABOVE the state we hold was made after its device
      // saw a state at least as new as ours; a fresh origination published now
      // is numbered from whatever this device last read — equal to it, or
      // below — and either loses (and on the next pull the peer's state closes
      // our change) or wins on the clock tie-break (and the peer's change is
      // lost on both machines). What decides it is provenance alone — not
      // which workspace the browser shows, nor whether a switch was handled:
      //
      //   - the ACTIVE workspace is reconciled now instead — the peer's state
      //     with our unpublished changes laid over it (withLocalNews) — and
      //     that merge is what gets published, as our next version;
      //   - one that is not showing cannot pull (invariant 5): the write is
      //     held, and the merge happens when it is opened.
      //
      // A peer state numbered no higher than ours is CONCURRENT and does not
      // count: invariant 4 applies, ours goes out under the next version.
      // An acknowledgement is not news and is never held.
      if (!ackPending.has(ws.name) && await peerAhead(ws.name)) {
        if (ws.name === activeName) {
          console.info(LOG, "not publishing", ws.name,
            "over a newer peer state — merging it first");
          mergeFirst = ws.name;
        } else {
          console.info(LOG, "holding the write of", ws.name,
            "— a newer peer state is waiting; it is merged when the workspace is opened");
        }
        continue;
      }
      writing.add(ws.name);
      try {
        // Provenance (see the block above). The first write after an apply
        // ACKNOWLEDGES the adopted state: it carries the origin's name, version
        // and timestamp unchanged, whatever the browser made of the apply.
        // Anything else is this device's own news and takes the next version.
        const ack = ackPending.get(ws.name);
        ackPending.delete(ws.name);
        const prov = ack || { origin: machine, version: nextVersion(ws.name) };
        snap.origin = prov.origin;
        if (prov.version != null) snap.version = prov.version;
        const written = await NOTES.write(title, snap, ack ? ack.timestamp : undefined);
        current.set(ws.name, {
          origin: prov.origin,
          version: prov.version == null ? null : prov.version,
          timestamp: written && typeof written.timestamp === "number" ? written.timestamp : 0,
        });
        lastSig.set(ws.name, sig);
        wrote = true;
        if (!isEmptySnap(snap)) everHadContent.add(ws.name);
        console.debug(LOG, "wrote", ws.name, ack ? "(ack of " + describeProv(prov) + ")" : "(v" + prov.version + ")");
      } catch (e) {
        console.error(LOG, "write failed for", ws.name, e);
      } finally {
        writing.delete(ws.name);
      }
    }
    // A pull that invariant 4 deferred was waiting for exactly this write. Do
    // it now rather than leaving it to the next unrelated note event, or the
    // device stays one document behind for as long as nobody touches anything.
    if (wrote && pullWanted) {
      pullWanted = false;
      await reconcileActive();
    }
    if (mergeFirst) {
      // Merge as on an open: our unpublished changes over the peer's state.
      lastActiveWsName = mergeFirst;
      await reconcile(mergeFirst, { onOpen: true });
    }
  }

  // Whether a peer's document for this workspace is numbered ABOVE the state
  // this device holds — a state made after its device saw one at least as new
  // as ours, i.e. a pull is waiting that our next origination must not be
  // published over. Echoes of our own origin never count, and neither does a
  // concurrent state (an equal version): invariant 4 lets ours win that one.
  async function peerAhead(name) {
    try {
      const own = `${name}-${machine}.json`;
      const cur = current.get(name);
      if (!cur) return false; // never reconciled: nothing held to be ahead of
      for (const f of await listDocs(name)) {
        noteVersion(name, f.data.version);
        if (f.name === own) continue;
        const prov = provenanceOf(f);
        if (prov.origin === machine) continue;
        if (prov.version > cur.version) return true; // concurrent (equal) does not count
      }
    } catch (e) {
      console.warn(LOG, "could not read the peers' documents for", name, e);
    }
    return false;
  }

  function scheduleWrite(delayMs) {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeChanged(false).catch((e) => console.error(LOG, e));
    }, delayMs != null ? delayMs : SETTINGS.writeDebounceMs);
  }

  // A note title is `<workspace>-<device>.json` and BOTH halves may contain a
  // "-", so the title alone cannot say which workspace a document belongs to:
  // "Shared-2-workshop.json" is the document of workspace "Shared-2" on device
  // "workshop" AND a perfectly well-formed name for workspace "Shared" on a
  // device called "2-workshop". A prefix match therefore hands workspace
  // "Shared" the document of workspace "Shared-2" — and reconcile is
  // newest-wins whole-document, so the peer replaces every tab in Shared with
  // Shared-2's tabs and then publishes that back over the original.
  //
  // The payload carries its own `workspace` field; that is authoritative, and
  // the prefix is only a cheap pre-filter. A note that fails to parse, or is
  // not a sync document (isSyncDoc), is dropped with one warning per title —
  // never matched by title.
  const reportedBadDocs = new Set();
  async function listDocs(workspaceName) {
    const files = await NOTES.list(`${workspaceName}-`);
    const out = [];
    for (const f of files) {
      if (isSyncDoc(f.data)) {
        if (f.data.workspace === workspaceName) out.push(f);
        continue;
      }
      if (!reportedBadDocs.has(f.name)) {
        reportedBadDocs.add(f.name);
        console.warn(LOG, `ignoring note "${f.name}" — not a sync document` +
          (f.error ? ` (${f.error})` : " (no workspace/origin/version/items)") +
          "; delete it, or update the mod on the device that writes it.");
      }
    }
    return out;
  }

  // ===========================================================================
  // R2.5 — ticking and unticking a workspace in the Settings dialog
  // ---------------------------------------------------------------------------
  // Left to R2.4 alone, enabling a workspace would do nothing at all until the
  // user happened to switch into it: R2.4 refuses to snapshot a workspace
  // Vivaldi has not materialized, and invariant 5 refuses to reconcile one that
  // is not active. Correct, and indistinguishable from a broken transport.
  // Publish on the tick instead — but never in a way that can destroy what the
  // other devices hold.
  //
  // The provenance the note is written with is the whole trick, because
  // reconcile is newest-wins whole-document:
  //
  //   FIRST device on this workspace — nobody else lists it in `peers` and no
  //   document exists — publish normally. There is nothing to overwrite, and
  //   the workspace starts syncing from this machine's content.
  //
  //   JOINING a workspace the others already share — publish as version 0,
  //   stamped 0 (1970). The document exists, names this device and can be seen in the
  //   Notes panel, but it loses every comparison, so the peers keep their
  //   content and this machine adopts it on its first pull. That deliberately
  //   discards whatever the workspace held locally, which is the only safe
  //   direction: the alternative is one machine's private copy silently
  //   replacing the shared one on every other device.
  // ===========================================================================
  async function publishOnEnable(name) {
    const winId = await ADAPTER.currentWindowId();
    const [{ list }, tabs] = await Promise.all([
      ADAPTER.getWorkspaces(),
      ADAPTER.tabsInWindow(winId),
    ]);
    const ws = list.find((x) => x.name === name);
    if (!ws) {
      console.warn(LOG, "enable:", name, "— no workspace by that name on this device");
      return null;
    }

    // Two independent kinds of evidence that this machine is not alone, and
    // either one is enough. The config says who INTENDS to sync it; the folder
    // says who already has. A device that ticked the workspace but has not
    // published yet is still a device whose content must not be overwritten.
    const others = peersOf(name).filter((d) => d !== machine);
    const ownName = `${name}-${machine}.json`;
    const docs = await listDocs(name).catch(() => []);
    for (const f of docs) noteVersion(name, f.data.version);
    const joining = others.length > 0 || docs.some((f) => f.name !== ownName);

    const snap = buildSnapshot(tabs, ws.id, name);
    // A loading tab's URL is transient, and normally the write defers until it
    // settles (see writeChanged). Not here: deferring is exactly the "I ticked
    // it and nothing happened" the tick is meant to end. Publish now — the
    // first-device path is in openedWorkspaces afterwards, so the load
    // completing re-publishes the settled URL, and the joining path is stamped
    // 0 and about to be overwritten anyway.

    if (!joining && isEmptySnap(snap)) {
      // No content to publish, and no peer to defer to. An empty document from
      // the first device is either "this workspace is empty" or "Vivaldi has not
      // materialized it yet" (R2.4) and there is no way to tell those apart —
      // and it would instruct every device that joins later to close the
      // workspace. Say so, and leave it pending.
      console.warn(LOG, "enable:", name, "— nothing published: no live tabs here and no peer",
        "document exists, so an empty snapshot cannot be told from an unmaterialized",
        "workspace. Switch into it once and it publishes.");
      reportPending();
      return null;
    }

    try {
      // Joining is version 0 at 1970: a state that loses every comparison it
      // will ever be in. The first device on a workspace originates for real.
      const prov = { origin: machine, version: joining ? 0 : nextVersion(name) };
      snap.origin = prov.origin;
      snap.version = prov.version;
      const first = await NOTES.write(ownName, snap, joining ? 0 : undefined);
      current.set(name, { ...prov, timestamp: first && typeof first.timestamp === "number" ? first.timestamp : 0 });
      // Either way this IS our published state, so record its signature: without
      // it reconcileActive sees "unpublished local changes" and defers the pull
      // for ever (invariant 4), which for a joining workspace means never
      // receiving the content it just signed up for.
      lastSig.set(name, signature(snap));
      if (joining) {
        console.info(LOG, "enable:", name, "— joined; published with a 1970 timestamp so the",
          "other devices' content wins. What is in this workspace locally will be replaced.");
      } else {
        // Proven materialized: we just serialized live tabs out of it. That is
        // the condition R2.4's gate stands for, so it is honest to open it.
        openedWorkspaces.add(name);
        everHadContent.add(name);
        console.info(LOG, "enable:", name, "— published", itemsOf(snap).length,
          "item(s) as the first device on this workspace");
      }
      return { joining, items: itemsOf(snap).length };
    } catch (e) {
      console.error(LOG, "enable: publishing", name, "failed:", e);
      return null;
    }
  }

  // Unticking removes this device's document. It is ours and it describes a
  // workspace we no longer take part in; leaving it behind would keep offering
  // a stale copy of this machine's tabs to every device that stays in the
  // workspace. The per-workspace session state goes with it, so that ticking it
  // again is a clean join rather than a resumption.
  async function unpublishOnDisable(name) {
    // A write for this workspace can be asleep inside the note throttle for up
    // to SETTINGS.minNoteWriteGapMs. Removing the note out from under it lands the
    // write afterwards and resurrects the document — the user unticks, the note
    // reappears, and this device keeps offering its tabs to a workspace it has
    // left. Wait the in-flight write out first; writeChanged will not start
    // another, since isSynced() is already false by the time we are called.
    for (let i = 0; writing.has(name) && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    lastSig.delete(name);
    ackPending.delete(name);
    current.delete(name);
    openedWorkspaces.delete(name);
    everHadContent.delete(name);
    sawPeerDoc.delete(name);
    loadSince.delete(name);
    settleSince.delete(name);
    pullDefers.delete(name);
    try {
      const gone = await NOTES.remove(`${name}-${machine}.json`);
      console.info(LOG, "disable:", name,
        gone ? "— removed this device's document" : "— no document of ours to remove");
      return gone;
    } catch (e) {
      console.error(LOG, "disable: removing this device's document for", name, "failed:", e);
      return false;
    }
  }

  // ===========================================================================
  // R2.2 — on workspace open, reconcile against the newest remote file
  // ===========================================================================
  // `opts.onOpen` marks the call made when the user switches INTO the
  // workspace (checkActiveWorkspace); it adds the invariant 4 check below.
  // A reconcile in flight owns its workspace's next write: writeChanged skips
  // the workspace until it is done (see `reconciling` there), and the write the
  // reconcile itself ends with runs once it is out of the set.
  const reconciling = new Set(); // workspace names with a reconcile in flight
  async function reconcile(workspaceName, opts) {
    if (reconciling.has(workspaceName)) return;
    reconciling.add(workspaceName);
    let write = false;
    try {
      write = await reconcileOnce(workspaceName, opts);
    } finally {
      reconciling.delete(workspaceName);
    }
    if (write) await writeChanged(false);
  }
  // Returns true when the caller is to finish with a (signature-gated) write.
  async function reconcileOnce(workspaceName, opts) {
    if (!isSynced(workspaceName)) return;

    // Only the ACTIVE workspace may be reconciled (see the precondition in
    // applyDesired). Bail BEFORE any state changes: marking a non-active
    // workspace as "opened" would let R2.4 publish it from tabs Vivaldi has not
    // materialized (i.e. an empty snapshot that wipes it on every peer), and
    // advancing `current` below would permanently skip a remote we never
    // actually applied.
    const { list: wsList, activeId } = await ADAPTER.getWorkspaces();
    const target = wsList.find((x) => x.name === workspaceName);
    if (!target || ADAPTER.wsKey(target.id) !== ADAPTER.wsKey(activeId)) {
      console.debug(LOG, "skip reconcile of", workspaceName, "— not the active workspace");
      return;
    }

    // Opening the workspace materializes its tabs and makes it writable (R2.4).
    openedWorkspaces.add(workspaceName);

    // Invariant 4 applies on a workspace switch as much as on a note event: a
    // remote is whole-document, so applying one over unpublished local changes
    // closes them — a tab opened just before switching away and back would be
    // closed on the way back in. The first
    // reconcile of a session (nothing published yet, so no lastSig entry) is
    // the deliberate exception: newest remote wins on open — with this
    // device's local news laid over it (withLocalNews, below).
    const winId = await ADAPTER.currentWindowId();
    const liveSnap = buildSnapshot(await ADAPTER.tabsInWindow(winId), target.id, workspaceName);
    const unpublished = !!(opts && opts.onOpen && lastSig.has(workspaceName) &&
      lastSig.get(workspaceName) !== signature(liveSnap));

    const files = await listDocs(workspaceName);
    const ownName = `${workspaceName}-${machine}.json`;
    if (files.some((f) => f.name !== ownName)) sawPeerDoc.add(workspaceName);
    const own = files.find((f) => f.name === ownName);
    // Every version in the folder feeds the logical clock, so the next state
    // this device originates is numbered above all of them.
    for (const f of files) noteVersion(workspaceName, f.data.version);

    // The state this device holds. Seeded from our own document on the first
    // reconcile of the session — so a remote older than what we saved last time
    // is not re-applied — then moved by every apply and every write.
    if (!current.has(workspaceName)) {
      current.set(workspaceName, own ? provenanceOf(own) : { origin: machine, version: 0, timestamp: 0 });
    }
    const cur = current.get(workspaceName);

    // Pick the newest remote state. A document whose ORIGIN is this device is
    // our own state coming back through a peer — however that peer rendered it
    // and whatever it stamped it with — and is never applied: it can only tell
    // us to undo what the user has done here since.
    let newest = null, newestProv = null, echoes = 0;
    for (const f of files) {
      if (f.name === ownName) continue;
      const prov = provenanceOf(f);
      if (prov.origin === machine) {
        echoes++;
        continue;
      }
      if (!newest || cmpProv(prov, newestProv) > 0) {
        newest = f;
        newestProv = prov;
      } else if (sameState(prov, newestProv) && f.name === `${workspaceName}-${prov.origin}.json`) {
        // The same state twice — the origin's own document and a peer's
        // acknowledgement of it. Prefer the origin's own rendering.
        newest = f;
        newestProv = prov;
      }
    }
    if (echoes) {
      console.debug(LOG, "ignoring", echoes, "echo(es) of our own state for", workspaceName);
    }
    // Unpublished local changes, and a remote waiting that this device has
    // never seen. The two cases are told apart by the VERSION, not the clock:
    //
    //   - a remote numbered no higher than what we hold is CONCURRENT with it
    //     (or older) — neither side saw the other's state. Invariant 4: defer
    //     the pull, publish ours under the next version, and the retried pull
    //     finds nothing newer.
    //   - a remote numbered HIGHER was made after its device saw a state at
    //     least as new as ours. Publishing ours over it discards that device's
    //     work, and it is not even reliable: our next version is numbered from
    //     the folder we last read, and can come out below the remote's — the
    //     retried pull then applies the remote and closes what we deferred
    //     for. It is merged instead (below): the remote, plus the tabs our
    //     user opened or moved in, less the ones they closed.
    //
    // The typical case is tabs MOVED into a synced workspace from another one
    // ("Move to workspace"): Vivaldi switches into the target, the target has
    // a peer's newer state pending, and the moved tabs are in no document, so
    // a plain whole-document apply would close them outright.
    if (unpublished && (!newest || sameState(newestProv, cur) || newestProv.version <= cur.version)) {
      console.debug(LOG, "defer pull for", workspaceName, "— unpublished local changes (on open)");
      pullWanted = true;
      scheduleWrite();
      return;
    }
    if (!newest || sameState(newestProv, cur) || cmpProv(newestProv, cur) <= 0) {
      console.debug(LOG, "reconcile:", workspaceName, "already up to date",
        "(holding " + describeProv(cur) + ")");
      // Nothing to pull — but this workspace has just been materialized, and
      // openedWorkspaces above is what makes it publishable at all (R2.4).
      // Returning without a write would leave a workspace the user had only
      // just ticked unpublished until some unrelated tab event happened to fire
      // a write: switching into it would do nothing, which reads as "sync is
      // dead".
      // The write is signature-gated, so it costs a snapshot and nothing else
      // when the state is already published (invariant 1 is untouched).
      return true;
    }
    console.info(LOG, "reconcile:", workspaceName, "<-", newest.name,
      "(" + describeProv(newestProv) + " over " + describeProv(cur) + ")");
    // Adopting a state makes it the state this device holds, and the next write
    // of this workspace — whatever the browser makes of the apply — is an
    // ACKNOWLEDGEMENT carrying the origin's provenance, never a fresh
    // origination (see the provenance block). Both are recorded BEFORE the
    // apply: applyDesired's own tab events schedule a write, and a slow apply
    // (it waits for groupings to land) lets that write fire while we are still
    // inside it.
    //
    // Unless this device has news of its own to lay over it. On the first open
    // of a session (no lastSig) or with unpublished changes (above), a tab
    // here that our last document does not list is local news — opened, or
    // moved in from another workspace, while the workspace was not showing
    // the remote. The merged state is then this device's own: it goes out as
    // a FRESH origination, numbered above the remote (noteVersion has seen
    // it), so the remote's device adopts it and neither side's work is lost.
    let desired = newest.data;
    if (own && (unpublished || !lastSig.has(workspaceName))) {
      const merged = withLocalNews(newest.data, own.data, liveSnap, unpublished);
      if (merged.changed) {
        console.info(LOG, "reconcile:", workspaceName, "keeping", merged.changed,
          "local change(s) over", newest.name, "— published as this device's next version");
        desired = merged.doc;
      }
    }
    current.set(workspaceName, newestProv);
    if (desired === newest.data) ackPending.set(workspaceName, newestProv);
    else ackPending.delete(workspaceName);
    const applied = await applyDesired(workspaceName, desired);
    if (applied && applied.skipped) {
      // Nothing was applied, so nothing was adopted: the remote stays pending.
      current.set(workspaceName, cur);
      ackPending.delete(workspaceName);
      return;
    }
    // R2.2.3 rewrite own doc — but signature-gated, NOT forced.
    //
    // A forced write here is a perpetual-motion machine once both devices pull
    // on remote change: A writes -> B applies and force-writes a NEWER doc
    // (even though nothing changed) -> A applies and force-writes -> ... The
    // two devices ping-pong for ever, each lap costing a full notes read, a
    // note write and a sync push. Gating on the signature means the write only
    // happens if our live state genuinely differs from what we just applied, so
    // the exchange terminates as soon as the devices agree.
    //
    // Unless a grouping never reached vivExtData (invariant 6). A snapshot taken
    // now would describe tabs the browser is still moving, and every peer would
    // apply that as an instruction to undo the grouping. Publish nothing this
    // round and re-arm the write with a settle-sized delay: whatever is actually
    // true a moment from now is what goes out, late rather than wrong.
    if (applied && applied.settled === false) {
      console.warn(LOG, "not publishing", workspaceName,
        "— a grouping has not landed yet; retrying the write in", SETTINGS.groupSettleRetryMs + "ms");
      scheduleWrite(SETTINGS.groupSettleRetryMs);
      return;
    }
    // The write that follows is the acknowledgement: ackPending makes it carry
    // the origin's provenance whichever path it lands through — a tab still
    // loading defers it, a grouping that has not settled re-arms it, a write
    // already asleep in the note throttle makes writeChanged skip the workspace
    // and leave it to the write the apply's own tab events scheduled. Every one
    // of those ends in a plain writeChanged(), and each would otherwise have
    // published the adopted state as this device's own news.
    return true;
  }

  // Build a structured view of one workspace's live tabs: ordered top-level
  // tabs and stacks (each with its live group id, name, and member tabs).
  function liveWorkspaceView(tabs, wsId) {
    const mine = tabs
      .filter((t) => ADAPTER.wsKey(ADAPTER.parseTabExt(t).workspaceId) === ADAPTER.wsKey(wsId))
      .sort((a, b) => a.index - b.index);
    const top = []; // { id, url, nurl, loading }
    const stacksById = new Map(); // gid -> { gid, name, tabs:[{id,url,nurl,loading}] }
    // A group of one is not a stack — see buildSnapshot. An excepted tab does
    // not count as a member either: it is invisible to sync, so a stack of one
    // synced tab and one excepted tab IS the synced tab, top-level, exactly as
    // buildSnapshot publishes it. Counting it would make a peer's document that
    // (faithfully) lists that tab as top-level pull it out of the stack here.
    // A group is an ordinary stack or a PINNED stack (groupPinStates), and a
    // tab whose own pin state disagrees with its group's is not a member of it:
    // buildSnapshot publishes that tab top-level, and this view has to agree or
    // the document we just wrote looks like a peer taking our stack apart. The
    // pin phase is what actually gets such a tab out of the group.
    const groupPin = groupPinStates(mine.filter((t) => !isExceptedUrl(tabUrl(t))));
    for (const t of mine) {
      const ext = ADAPTER.parseTabExt(t);
      const url = tabUrl(t);
      const excepted = isExceptedUrl(url);
      // `volatile` = never close this tab. Either it is mid-navigation and the
      // USER opened it (its URL is not yet a fact — a tab WE opened from a
      // document is closable while it loads, see syncBorn), or it is an empty
      // new tab (the user is typing in it), or its address is excepted from
      // sync (no document speaks for it).
      const loading = isLoadingTab(t);
      const entry = {
        id: t.id, url, nurl: normUrl(url), loading, pinned: !!t.pinned,
        volatile: (loading && !syncBorn.has(t.id)) || isBlankTabUrl(url) || excepted,
      };
      const rawGid = ADAPTER.stackIdOf(ext);
      // An excepted tab is listed top-level whatever stack it sits in: nothing
      // in a document can claim it, and top-level volatile is simply "leave it".
      // So is the odd tab out of a mixed group (see above).
      const sp = rawGid == null ? null : groupPin.get(rawGid);
      const gid = !excepted && sp != null && sp === entry.pinned ? rawGid : null;
      if (gid == null) {
        top.push(entry);
      } else {
        let s = stacksById.get(gid);
        if (!s) {
          s = {
            gid, name: ADAPTER.stackNameOf(ext), color: ADAPTER.stackColorOf(ext),
            pinned: sp, tabs: [],
          };
          stacksById.set(gid, s);
        }
        if (!s.name) s.name = ADAPTER.stackNameOf(ext);
        if (!s.color) s.color = ADAPTER.stackColorOf(ext);
        s.tabs.push(entry);
      }
    }
    return { top, stacks: [...stacksById.values()] };
  }

  // Create a tab in the active window/workspace. Created tabs auto-join the
  // active workspace at top level (reconcile only runs for the active
  // workspace, so this is always correct). Returns the new tab id.
  // A tab the document wants pinned is created PINNED and takes its workspace
  // from create-time `vivExtData` — a different call from the update-time one,
  // which is a confirmed no-op here — because a pinned newborn is not moved
  // afterwards: pinToWorkspace parks a tab at the END of its workspace's region
  // and the pinned strip is at the FRONT of the bar, so a repositioned tab may
  // lose its pin. Neither move is needed for it — PROVIDED it landed in this
  // workspace and outside any stack: Vivaldi drops a newborn into the active
  // tab's stack pinned or not (a pinned tab arriving while the user sits in a
  // stack becomes that stack's first member), and the caller verifies both.
  // Create-time `pinned` + `vivExtData.workspaceId` is a create path confirmed
  // on a real build.
  async function createTab(winId, url, pinned, wsId) {
    const props = { windowId: winId, url, active: false };
    if (pinned) {
      props.pinned = true;
      if (wsId != null) props.vivExtData = JSON.stringify({ workspaceId: wsId });
    }
    const created = await chrome.tabs.create(props);
    // This tab exists because a document asked for it — see syncBorn.
    if (created && created.id != null) syncBorn.add(created.id);
    return created;
  }

  // Match desired stacks to live stacks: by name when both are named, else by
  // member-URL overlap (Jaccard >= 0.5). Group ids are backend-assigned and
  // differ per device, so they take no part in it. Each live stack is matched
  // at most once. Returns Map(desired stack item -> live gid).
  function matchStacks(desiredStackItems, liveStacks) {
    const used = new Set();
    const out = new Map();
    for (const d of desiredStackItems) {
      const dUrls = new Set((d.tabs || []).map((x) => normUrl(x.url)));
      let best = null, bestScore = 0;
      for (const L of liveStacks) {
        if (used.has(L.gid)) continue;
        let score;
        if (d.name && L.name && d.name === L.name) {
          score = 1000;
        } else {
          let inter = 0;
          for (const u of L.tabs) if (dUrls.has(u.nurl)) inter++;
          const union = dUrls.size + L.tabs.length - inter;
          score = union ? inter / union : 0;
        }
        if (score > bestScore) { bestScore = score; best = L; }
      }
      if (best && bestScore >= 0.5) { out.set(d, best.gid); used.add(best.gid); }
    }
    return out;
  }

  // Longest strictly increasing subsequence over an array of ranks (null = not
  // ranked, never part of it); returns the Set of kept positions. The units it
  // keeps are already in the right relative order, so moving only the others is
  // the fewest moves that produce the sequence.
  function lisSet(a) {
    const n = a.length, parent = new Array(n).fill(-1), tails = [];
    for (let i = 0; i < n; i++) {
      if (a[i] == null) continue;
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[tails[mid]] < a[i]) lo = mid + 1; else hi = mid; }
      parent[i] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = i;
    }
    const s = new Set();
    let k = tails.length ? tails[tails.length - 1] : -1;
    while (k >= 0) { s.add(k); k = parent[k]; }
    return s;
  }

  // The order phase (R2.2.2b): put the workspace's UNITS — an unpinned top-level
  // tab, or a whole stack — into the document's sequence, and the MEMBERS of
  // each stack into the document's sequence inside their own run, both with the
  // fewest moves.
  //
  // It is driven by the ORDER PLAN the create phase builds: one entry per
  // desired item, in document order, naming the live tab ids that satisfy it
  // (kept, adopted or created), and for a stack the member ids in document
  // order. **Identity comes from the phase that established it, never from
  // re-matching URLs here.** Re-matching would skip every tab the apply has
  // just opened: a newborn is `loading`, a loading tab is `volatile` in
  // liveWorkspaceView, and a phase that excluded volatile units would leave a
  // tab a peer opened from a link (Vivaldi places it next to its opener) at
  // the end of the strip here. `volatile` means never CLOSE this tab, because
  // its address is not yet a fact; moving one is harmless, and the workspace
  // is not published while it loads anyway (loadSince).
  //
  // The rules (see SPEC.md R2.2.2b and "Approaches that failed"):
  //   - a stack moves as ONE run, every member in one call, never a member on
  //     its own — EXCEPT inside its own run (below), where the target is
  //     between two members of the same group and no other stack is adjacent;
  //   - a target is always a boundary between units, never inside a foreign
  //     run — a tab placed inside another stack's run is Vivaldi's add-to-stack
  //     gesture, and "do-not-reparent" is not relied on to prevent it;
  //   - the strip is re-read before every move rather than simulated, because
  //     the browser may reposition more than what was asked;
  //   - the pinned strip is left alone: the pin phase already put those tabs at
  //     the front, and their order is not compared (signature);
  //   - a tab no document speaks for (loading and unknown, blank, excepted) is
  //     never moved and simply keeps its place.
  // No timer anywhere: a unit that does not land where it was sent is logged
  // and left, and a member that leaves its stack is put back and that stack's
  // reordering abandoned for this round. The acknowledgement then publishes the
  // order this device actually has under the peer's provenance, which the peer
  // never applies (invariant 2), so an order the browser will not reproduce
  // costs one differing rendering — never a swap. Returns the number of moves.
  async function applyOrder(orderPlan, ws, winId) {
    const wsKey = ADAPTER.wsKey(ws.id);
    let strip = [], byId = new Map();
    const readStrip = async () => {
      strip = (await ADAPTER.tabsInWindow(winId)).slice().sort((a, b) => a.index - b.index);
      byId = new Map(strip.map((t) => [t.id, t]));
    };
    const mine = (t) => !!t && ADAPTER.wsKey(ADAPTER.parseTabExt(t).workspaceId) === wsKey;
    const gidOf = (t) => (t ? ADAPTER.stackIdOf(ADAPTER.parseTabExt(t)) : null);
    const runOf = (gid) => strip.filter((t) => mine(t) && gidOf(t) === gid).map((t) => t.id);
    // The group a planned stack ended up as, read from its members: phase 2 may
    // have rebuilt it under a new id, and the backend — not us — assigns those.
    const gidOfPlan = (plan) => {
      const known = [...(plan.keptIds || []), ...(plan.memberIds || [])];
      for (const id of known) {
        const t = byId.get(id);
        if (mine(t) && gidOf(t) != null) return gidOf(t);
      }
      return null;
    };
    // A planned unit's live tabs, read back from the strip every time.
    const liveIds = (u) => {
      if (u.kind === "tab") {
        const t = byId.get(u.id);
        return mine(t) && !t.pinned && gidOf(t) == null ? [t.id] : [];
      }
      const gid = gidOfPlan(u.plan);
      return gid == null ? [] : runOf(gid);
    };
    // Move `movers` so that they sit immediately after (or before) `anchorIds`,
    // with the target computed in the post-removal frame — see
    // ADAPTER.moveToIndex. Returns false when nothing needed doing.
    const moveNextTo = async (movers, anchorIds, after, what) => {
      const ids = strip.map((t) => t.id);
      const aFirst = ids.indexOf(anchorIds[0]);
      const aLast = ids.indexOf(anchorIds[anchorIds.length - 1]);
      const mFirst = ids.indexOf(movers[0]);
      const mLast = ids.indexOf(movers[movers.length - 1]);
      if (after ? mFirst === aLast + 1 : mLast === aFirst - 1) return false; // already there
      const moverSet = new Set(movers);
      const sim = ids.filter((id) => !moverSet.has(id));
      const target = after ? sim.indexOf(anchorIds[anchorIds.length - 1]) + 1 : sim.indexOf(anchorIds[0]);
      if (target < 0) return false;
      if (!(await ADAPTER.moveToIndex(movers, target, winId, ws.id))) {
        console.warn(LOG, "order:", what, "did not land at index", target,
          "(VivaSync.diagOrder() reports what this build does with an index move)");
      }
      return true;
    };

    // --- The sequence of units ------------------------------------------------
    await readStrip();
    const units = [];
    for (const u of orderPlan) {
      const ids = liveIds(u);
      if (!ids.length) continue;
      u.pos = Math.min(...ids.map((id) => byId.get(id).index));
      units.push(u);
    }
    let moves = 0;
    if (units.length >= 2) {
      const rank = new Map(units.map((u, i) => [u, i])); // orderPlan IS document order
      const current = units.slice().sort((a, b) => a.pos - b.pos);
      const keep = lisSet(current.map((u) => rank.get(u)));
      const settled = new Set(current.filter((_, i) => keep.has(i)));
      const firstKept = units.find((u) => settled.has(u));
      for (let di = 0; di < units.length; di++) {
        const unit = units[di];
        if (settled.has(unit)) continue;
        // Anchor: the predecessor in the sequence, which is already in place
        // (kept, or moved on an earlier turn of this loop) — or, for a unit that
        // heads the sequence, the first KEPT unit, which it goes in front of.
        const after = di > 0;
        const anchor = after ? units[di - 1] : firstKept;
        if (!anchor || anchor === unit) { settled.add(unit); continue; }
        await readStrip();
        const movers = liveIds(unit), anchorIds = liveIds(anchor);
        if (!movers.length || !anchorIds.length) { settled.add(unit); continue; }
        if (await moveNextTo(movers, anchorIds, after, unit.kind + " " + (unit.what || ""))) moves++;
        settled.add(unit);
      }
    }

    // --- The sequence of members inside each stack ----------------------------
    // The only move here is between two members of the SAME group, so the
    // absorption hazard the rules above are written around cannot arise: the
    // tab lands surrounded by its own run. What is not certain is that
    // "do-not-reparent" keeps it in the group on every build, so each move is
    // verified — a member that left its run is put back with addToStack and the
    // rest of that stack's reordering is abandoned for this round.
    for (const u of orderPlan) {
      if (u.kind !== "stack" || (u.plan.memberOrder || []).length < 2) continue;
      await readStrip();
      const gid = gidOfPlan(u.plan);
      if (gid == null) continue;
      let run = runOf(gid);
      if (run.length < 2) continue;
      // Document order first; a member the document does not name (the user
      // just dragged one in here) keeps its relative tail position.
      const want = u.plan.memberOrder.filter((id) => run.includes(id));
      for (const id of run) if (!want.includes(id)) want.push(id);
      const rank = new Map(want.map((id, i) => [id, i]));
      const keep = lisSet(run.map((id) => rank.get(id)));
      const settled = new Set(run.filter((_, i) => keep.has(i)));
      const firstKept = want.find((id) => settled.has(id));
      for (let wi = 0; wi < want.length; wi++) {
        const id = want[wi];
        if (settled.has(id)) continue;
        const after = wi > 0;
        const anchorId = after ? want[wi - 1] : firstKept;
        if (anchorId == null || anchorId === id) { settled.add(id); continue; }
        await readStrip();
        if (!byId.has(id) || !byId.has(anchorId)) { settled.add(id); continue; }
        if (await moveNextTo([id], [anchorId], after, "stack member " + normUrl(tabUrl(byId.get(id))))) {
          moves++;
          // Did it stay in the stack? A member moved out of its run would
          // otherwise be published as a top-level tab, and every peer would
          // take it out of the stack too.
          const back = await chrome.tabs.get(id).catch(() => null);
          if (gidOf(back) !== gid) {
            console.warn(LOG, "order: reordering", u.plan.name || gid,
              "took a member out of the stack — putting it back and leaving that stack's order alone",
              "(VivaSync.diagOrder() reports what this build does with an index move)");
            try { await ADAPTER.addToStack(id, gid); } catch (e) {
              console.warn(LOG, "could not put it back:", e && e.message);
            }
            await ADAPTER.awaitStack(run, null);
            break;
          }
        }
        settled.add(id);
      }
    }
    return moves;
  }
  // Apply desired state to the live (active) workspace: newest-wins, whole-file.
  // Tab identity = url within its container. Stack identity is matched by name
  // (if named) else by member-URL overlap, because the backend -- not us --
  // assigns stack group ids, so ids are not stable across devices.
  //
  // Ordering: items are created in tab-bar order (the desired `items` sequence)
  // and newly created tabs/stacks append in creation order, which reproduces
  // the sequence on a clean restore. Everything else — a tab already present in
  // the wrong place, a stack that moved, a tab appended here that sits next to
  // its opener there — is put right by the ORDER PHASE that runs last
  // (applyOrder): whole units moved to strip indices with tabsPrivate.move,
  // never chrome.tabs.move(id, {index:-1}), whose index spans all workspaces
  // and re-homes the tab to a neighbouring workspace.
  async function applyDesired(workspaceName, desired) {
    busy = true;
    try {
      const { list } = await ADAPTER.getWorkspaces();
      const ws = list.find((x) => x.name === workspaceName);
      if (!ws) {
        console.warn(LOG, "workspace not present, cannot reconcile:", workspaceName);
        return { settled: true, skipped: true }; // nothing applied, so nothing is half-applied
      }
      const winId = await ADAPTER.currentWindowId();

      // Hard precondition: createTab relies on a new tab auto-joining the
      // ACTIVE workspace, so reconciling a workspace that is not the active one
      // would create its tabs in whichever workspace is active while deleting
      // from this one. Refuse rather than corrupt two workspaces.
      const activeNow = await ADAPTER.activeWorkspaceId(winId);
      if (ADAPTER.wsKey(activeNow) !== ADAPTER.wsKey(ws.id)) {
        console.warn(
          LOG, "skip reconcile of", workspaceName,
          "— it is not the active workspace (active id:", ADAPTER.wsKey(activeNow) + ")"
        );
        return { settled: true, skipped: true }; // nothing applied, so nothing is half-applied
      }

      const tabs = await ADAPTER.tabsInWindow(winId);
      const live = liveWorkspaceView(tabs, ws.id);

      const desiredItems = itemsOf(desired);
      const desiredStackItems = desiredItems.filter((i) => i.type === "stack");
      // Everything below matches on the NORMALISED url (see normUrl).
      const desiredTopUrls = desiredItems.filter((i) => i.type === "tab").map((i) => normUrl(i.url));
      const urlsOf = (arr) => arr.map((x) => normUrl(x.url));

      // --- Match desired stacks to live stacks (by name, else URL overlap) ---
      const matchLiveGid = matchStacks(desiredStackItems, live.stacks); // desired stack item -> live gid
      const usedLive = new Set(matchLiveGid.values());

      // --- Plan deletes (R2.2.1) — executed AFTER the creates below ---
      // Deleting first can empty the workspace for an instant. Vivaldi reacts by
      // activating a tab from a NEIGHBOURING workspace, which flips
      // activeWorkspaceId() (it is derived from the active tab) — and then the
      // creates below, which rely on new tabs auto-joining the active workspace,
      // land in the wrong workspace. So: work out what to remove now, keep the
      // workspace populated through the create phase, and remove afterwards.
      const toRemove = [];
      // Tabs that are not wanted where they currently sit are not doomed yet:
      // the create phase below can ADOPT one — move it into the container the
      // desired document puts it in — instead of closing it and opening a
      // second copy of the same page. Whatever is still here when the create
      // phase ends is what actually gets removed.
      const spare = []; // { id, nurl, gid, loading }
      const takeSpare = (nu) => {
        // Prefer an already-ungrouped tab: adopting it costs nothing.
        let i = spare.findIndex((e) => e.nurl === nu && e.gid == null);
        if (i < 0) i = spare.findIndex((e) => e.nurl === nu);
        return i < 0 ? null : spare.splice(i, 1)[0];
      };
      const takeByUrl = (liveTabs, desiredUrls, keepInto, gid) => {
        // keep up to the desired multiplicity per url; everything else is spare
        const want = new Map();
        for (const u of desiredUrls) want.set(u, (want.get(u) || 0) + 1);
        const kept = new Map();
        for (const t of liveTabs) {
          const c = want.get(t.nurl) || 0;
          const k = kept.get(t.nurl) || 0;
          if (k < c) {
            kept.set(t.nurl, k + 1);
            if (keepInto) keepInto.push(t);
          } else {
            // The `volatile` flag rides along so the delete phase can skip it.
            // A tab that is still navigating is never closed, because its URL is
            // transient (often the pre-redirect address) and "absent from the
            // desired document" is not yet a fact about it; nor is an empty new
            // tab, which is absent from every document by design and is
            // probably being typed into. Closing tabs mid-load feeds an
            // open/close cycle between devices. Either can still be ADOPTED,
            // though — moving a tab does not care what it currently shows, and
            // refusing to move it leaves the same URL living at top level AND
            // inside a stack.
            spare.push({ id: t.id, nurl: t.nurl, gid: gid || null, volatile: t.volatile, pinned: t.pinned });
          }
        }
      };
      const keptTop = [];
      const keptByGid = new Map(); // live gid -> tabs surviving the delete phase
      takeByUrl(live.top, desiredTopUrls, keptTop, null);
      for (const L of live.stacks) {
        if (usedLive.has(L.gid)) continue; // unmatched live stack -> goes away
        for (const u of L.tabs) spare.push({ id: u.id, nurl: u.nurl, gid: L.gid, volatile: u.volatile, pinned: u.pinned });
      }
      for (const [d, gid] of matchLiveGid) {
        const L = live.stacks.find((s) => s.gid === gid);
        if (L) {
          const kept = [];
          takeByUrl(L.tabs, urlsOf(d.tabs || []), kept, gid);
          keptByGid.set(gid, kept);
        }
      }
      // VIVA-DIAG (verbose): pre-reconcile summary — uncomment to trace.
      // console.info(LOG, "reconcile", workspaceName,
      //   "desired items:", desiredItems.map((i) => i.type === "tab" ? "tab" : "stack:" + (i.name || "?")).join(","),
      //   "| live before: top=" + live.top.length, "stacks=" + live.stacks.length,
      //   "| removing=" + toRemove.length);
      // --- Creates in tab-bar order (R2.2.2), in two phases ---
      // Phase 1: satisfy every desired entry, in order, without forming any
      // stack. An entry is satisfied by a tab that is already in the right
      // container, else by ADOPTING one of the spares (the same page open in
      // the wrong container — moved, not closed and re-opened), else by opening
      // it. Phase 2: form new stacks / extend matched stacks from the explicit
      // member tab ids, so only the intended tabs are grouped.
      //
      // The split exists because Vivaldi drops a new tab into the ACTIVE TAB'S
      // stack. Deferring grouping keeps us from stacking tabs onto each other
      // by accident, but it does NOT help when the user is already sitting in a
      // stack that survives this reconcile — that one swallows every tab we
      // create — so each new top-level tab is passed through
      // ADAPTER.detachFromStack as well.
      // Counted over the tabs that SURVIVE the delete phase, not over the raw
      // live set — the doomed ones must not satisfy a desired entry. The TABS,
      // not merely how many: a desired entry that is already satisfied can
      // still differ from the live tab in its pin state, the one attribute of
      // a tab this engine changes in place (see the pin phase).
      const availTop = new Map(); // normalised url -> surviving tabs holding it, in strip order
      for (const t of keptTop) {
        if (!availTop.has(t.nurl)) availTop.set(t.nurl, []);
        availTop.get(t.nurl).push(t);
      }
      // Every tab this document speaks for, with the pin state it wants.
      // Applied LAST (pin phase), after every move is done. A stack's members
      // are in it too, carrying the stack's own pin state: a stack is pinned as
      // a whole, one member at a time, because that is the only way the API
      // offers.
      const pinPlan = new Map(); // tab id -> wanted pinned
      // The tabs the document places INSIDE a stack. The pin phase takes a
      // pinned tab out of the group it is sitting in — that is what repairs a
      // mixed group — and must not do it to the members of a stack the document
      // itself pins.
      const plannedMember = new Set(); // tab ids
      // The ORDER PLAN: one entry per desired item, in document order, naming
      // the live tabs that satisfy it. The order phase runs off this rather
      // than re-matching URLs, so a tab created by this very apply — `loading`,
      // and therefore `volatile` — is placed like any other (see applyOrder).
      const orderPlan = []; // [{kind:"tab", id, what} | {kind:"stack", plan}]
      // A pinned tab that sits inside a stack is taken out of it. The pin is
      // released first — no build has been checked for what a move does to a
      // pinned tab — then the tab is detached like any other; the pin phase
      // re-pins it afterwards, because that phase re-reads the live state.
      const unstackPinned = async (id) => {
        try {
          await chrome.tabs.update(id, { pinned: false });
        } catch (e) {
          console.debug(LOG, "unpin before detach failed", id, "—", e && e.message);
        }
        if (await ADAPTER.detachFromStack(id, ws.id, winId)) return true;
        console.warn(LOG, "pinned tab", id, "is stuck inside a stack");
        return false;
      };

      const stackPlans = []; // { item, gid, name, memberIds:[], existingTarget }
      for (const item of desiredItems) {
       try {
        if (item.type === "tab") {
          const nu = normUrl(item.url);
          const have = availTop.get(nu);
          if (have && have.length) {
            const kept = have.shift();
            pinPlan.set(kept.id, !!item.pinned);
            if (!item.pinned) orderPlan.push({ kind: "tab", id: kept.id, what: nu });
            clearOpenAttempts(nu); // it stuck — forget any past churn
            continue;
          }
          // The page may already be open in this workspace, just in the wrong
          // container — typically a stack a peer has taken apart. Move that tab
          // out instead of closing it and opening a second copy: if the close
          // does not land (a tab mid-navigation is never closed), the URL ends
          // up present twice, once per container: a leftover top-level tab plus
          // the intact stack.
          const reuse = takeSpare(nu);
          if (reuse) {
            clearOpenAttempts(nu);
            pinPlan.set(reuse.id, !!item.pinned);
            if (!item.pinned) orderPlan.push({ kind: "tab", id: reuse.id, what: nu });
            if (reuse.gid == null) continue; // already top-level: leave it be
            // Out of a PINNED stack it comes out pinned, and no build has been
            // checked for what a move does to a pinned tab — so release the pin
            // first, exactly as the pin phase does, and let that phase put back
            // whatever the document asks for.
            const out = reuse.pinned
              ? await unstackPinned(reuse.id)
              : await ADAPTER.detachFromStack(reuse.id, ws.id, winId);
            if (out) continue;
            console.warn(LOG, "could not unstack", item.url, "— recreating it instead");
            pinPlan.delete(reuse.id);
            if (!item.pinned) orderPlan.pop();
            toRemove.push(reuse.id);
          }
          if (!mayOpen(nu, item.url)) continue;
          const created = await createTab(winId, item.url, item.pinned, ws.id);
          const id = created.id;
          // A pinned newborn is left where the browser put it — see createTab.
          // Both moves below could strip the pin, so neither is run — PROVIDED
          // it landed in this workspace and outside any stack. On a build that
          // ignores create-time vivExtData it is sitting in someone else's
          // workspace, where the snapshot cannot see it and the next reconcile
          // would open another copy: place it properly and let the pin go,
          // because a tab in the right workspace unpinned beats a pinned tab in
          // a workspace we cannot see. And when the user here sits in a stack,
          // Vivaldi drops the newborn into that stack, pin and all — and left
          // there, this device's document would tell the peer to move its own
          // copy into the stack too. Take it out NOW, before phase 2 plans
          // around that stack; the pin phase restores the pin.
          let placed = false;
          if (item.pinned) {
            const back = await chrome.tabs.get(id).catch(() => null);
            placed = !!back &&
              ADAPTER.wsKey(ADAPTER.parseTabExt(back).workspaceId) === ADAPTER.wsKey(ws.id);
            if (placed) {
              pinPlan.set(id, true);
              if (ADAPTER.stackIdOf(ADAPTER.parseTabExt(back)) != null) {
                console.debug(LOG, "pinned tab", item.url, "landed in the active tab's stack — taking it out");
                await unstackPinned(id);
              }
            } else {
              console.warn(LOG, "pinned tab", item.url, "landed outside", workspaceName,
                "— placing it and dropping the pin");
            }
          }
          if (!placed) {
            try { await ADAPTER.pinToWorkspace(id, ws.id, winId); } catch (e) { console.warn(LOG, "pinToWorkspace failed", id, e); }
            // Vivaldi puts a new tab in the ACTIVE TAB'S STACK, and
            // pinToWorkspace passes "do-not-reparent", so nothing takes it back
            // out again. A tab meant for top level must not be left in a stack
            // the user never dragged it into.
            if (!(await ADAPTER.detachFromStack(id, ws.id, winId))) {
              console.warn(LOG, "new tab", item.url, "is stuck in the active tab's stack");
            }
            if (!item.pinned) pinPlan.set(id, false);
          }
          if (!item.pinned) orderPlan.push({ kind: "tab", id, what: nu });
          // VIVA-DIAG (verbose): console.debug(LOG, "created top tab", id, item.url);
        } else {
          const gid = matchLiveGid.get(item);
          // The pin state of the stack AS A WHOLE. Every member is scheduled
          // for it; the pin phase applies it once the stack exists, because
          // pinning a tab that is not in the group yet would only have to be
          // undone.
          const wantPin = !!item.pinned;
          // The colour the document asks for — or `undefined` when it does not
          // ask at all. A stack with no `color` key is NOT the same as
          // `color: null`, which is a device saying "this stack has no colour".
          // Absent means "nothing is claimed about the colour", so a document
          // from a writer that does not track colour (or a hand-edited one)
          // leaves a colour set here alone instead of wiping it; `null` clears
          // it. (The
          // pin state has no such third case: a stack is pinned or it is not,
          // and a document that says nothing means an ordinary stack.)
          const wantColor = item && "color" in item ? normStackColor(item.color) : undefined;
          const liveStack = gid ? live.stacks.find((x) => x.gid === gid) : null;
          const keptMembers = gid ? (keptByGid.get(gid) || []) : [];
          // Kept members are held as TABS, not as a count per URL: the order
          // phase needs to know which live tab satisfies which document entry.
          const present = new Map(); // nurl -> [kept tab, ...] not yet claimed
          for (const t of keptMembers) {
            if (!present.has(t.nurl)) present.set(t.nurl, []);
            present.get(t.nurl).push(t);
          }
          // A member carries the stack's pin state, whatever it holds now: an
          // ordinary stack the peer has pinned, a pinned stack the peer has
          // unpinned, and the tab hoisted out of this stack as pinned by an
          // earlier document and now listed as an ordinary member all come
          // through here.
          for (const t of keptMembers) { pinPlan.set(t.id, wantPin); plannedMember.add(t.id); }
          const memberIds = []; // newly created members to group/add in phase 2
          const memberOrder = []; // the document's member sequence, as live ids
          for (const e of (item.tabs || [])) {
            const nu = normUrl(e.url);
            const have = present.get(nu);
            if (have && have.length) {
              memberOrder.push(have.shift().id);
              clearOpenAttempts(nu);
              continue; // already in stack
            }
            // Same reasoning as the top-level branch: adopt a live tab that
            // holds this URL rather than opening a duplicate of it. Adopted
            // tabs are grouped in phase 2 exactly like freshly created ones.
            const reuse = takeSpare(nu);
            if (reuse) {
              clearOpenAttempts(nu);
              // Grouped as a plain tab, then pinned with the rest of the stack:
              // what addToStack/createStack do to a PINNED tab is not something
              // any build has been checked for, and the pin phase re-reads the
              // live state anyway.
              if (reuse.pinned) {
                try { await chrome.tabs.update(reuse.id, { pinned: false }); }
                catch (e) { console.debug(LOG, "unpin before grouping failed", reuse.id, "—", e && e.message); }
              }
              pinPlan.set(reuse.id, wantPin);
              plannedMember.add(reuse.id);
              memberIds.push(reuse.id);
              memberOrder.push(reuse.id);
              continue;
            }
            if (!mayOpen(nu, e.url)) continue;
            // Created UNPINNED even for a pinned stack: a pinned newborn is
            // not placed by pinToWorkspace (it would lose the pin) and it is
            // the grouping that has to happen first — the pin phase pins the
            // assembled stack afterwards.
            const created = await createTab(winId, e.url, false);
            const id = created.id;
            try { await ADAPTER.pinToWorkspace(id, ws.id, winId); } catch (err) { console.warn(LOG, "pinToWorkspace failed", id, err); }
            // Vivaldi drops a newborn into the ACTIVE TAB's stack, which is
            // rarely the stack this member belongs to — and two members of a
            // NEW stack both land in it, looking to phase 2 like a stack that
            // has already settled. Take it out unless it happens to have landed
            // in the very group this plan is extending, exactly as the
            // top-level branch does.
            const born = await chrome.tabs.get(id).catch(() => null);
            const bornGid = born ? ADAPTER.stackIdOf(ADAPTER.parseTabExt(born)) : null;
            if (bornGid != null && bornGid !== gid &&
                !(await ADAPTER.detachFromStack(id, ws.id, winId))) {
              console.warn(LOG, "new stack member", e.url, "is stuck in the active tab's stack");
            }
            pinPlan.set(id, wantPin);
            plannedMember.add(id);
            memberIds.push(id);
            memberOrder.push(id);
          }
          // Anchor on a SURVIVING member; if none survive, the matched stack is
          // effectively gone, so fall through to creating a fresh one.
          const anchor = keptMembers.length ? keptMembers[0].id : null;
          const plan = {
            item, gid: anchor != null ? gid : null, name: item.name, memberIds,
            existingTarget: anchor,
            keptIds: keptMembers.map((t) => t.id),
            memberOrder,
            pinned: wantPin,
            // What the colour should be when phase 2 is done. A document that
            // says nothing about it means the stack keeps the colour it has —
            // which still has to be RE-ASSERTED if the group is rebuilt below,
            // because a rebuilt group is a new group and carries no colour.
            color: wantColor !== undefined ? wantColor : (liveStack ? liveStack.color : null),
            // Is there anything to say about the colour at all? Only then is
            // the live state worth reading back: a document that claims no
            // colour for a stack that has none is the ordinary case, and it
            // must not cost a read per member on every reconcile.
            colorClaimed: wantColor !== undefined || !!(liveStack && liveStack.color),
          };
          stackPlans.push(plan);
          // A pinned stack is not ordered: it lives in the pinned strip, whose
          // order nothing here reproduces and the signature does not compare.
          if (!wantPin) orderPlan.push({ kind: "stack", plan });
        }
       } catch (e) {
        console.error(LOG, "reconcile create-phase item failed", item && item.type, item && (item.name || item.url), e);
       }
      }

      // Whatever the create phase did not adopt really is unwanted — except a
      // volatile tab, which is never closed (see takeByUrl).
      for (const e of spare) if (!e.volatile) toRemove.push(e.id);

      // Deletes happen HERE, once the workspace is already populated with the
      // desired tabs, so it is never momentarily empty (see the planning note).
      //
      // The bulk call is rejected outright if ANY id in it is stale ("No such
      // tab - N"), and a tab can go stale between planning and here on its own:
      // closing a stack's second-to-last member dissolves the stack, and
      // Vivaldi does that bookkeeping asynchronously. One such id must not
      // abandon the entire delete list — that would leave every tab a peer
      // asked us to close still open, which is indistinguishable from "deletes
      // do not propagate". So: bulk first (one call in the normal case), then
      // retry one at a time, tolerating the ids that really are gone.
      if (toRemove.length) {
        try {
          await chrome.tabs.remove(toRemove);
        } catch (e) {
          console.warn(LOG, "bulk delete rejected (", e && e.message, ") — retrying individually");
          let closed = 0, gone = 0;
          for (const id of toRemove) {
            try {
              await chrome.tabs.remove(id);
              closed++;
            } catch (err) {
              // Already gone is the expected case, and a success for us.
              gone++;
              console.debug(LOG, "could not close tab", id, "—", err && err.message);
            }
          }
          console.warn(LOG, "delete phase: closed", closed, "of", toRemove.length,
            "(" + gone, "already gone or refused)");
        }
      }

      // Phase 2: group now that all tabs exist as plain tabs.
      //
      // `settled` is the answer to "did everything we asked for actually reach
      // vivExtData?". reconcile() publishes the moment we return, and a
      // snapshot of a half-applied grouping is a document that tells every peer
      // to undo what we just did — so a false here suppresses that publish
      // rather than broadcasting a state the browser is still mid-way through.
      let settled = true;
      for (const p of stackPlans) {
       try {
        const members = [...(p.keptIds || []), ...p.memberIds];
        let gid = p.gid;
        if (gid) {
          // Existing stack: add the newly created/adopted members to it.
          if (p.memberIds.length && p.existingTarget != null) {
            // addToStack must not be able to abandon the whole plan: if it
            // throws (a tweak name this build rejects, say), the rebuild below
            // must still run. Whatever it does, we go on to verify the result.
            try {
              for (const id of p.memberIds) await ADAPTER.addToStack(id, gid);
            } catch (e) {
              console.warn(LOG, "addToStack threw for", p.name || gid, "—", e && e.message);
            }
            // Verify, and rebuild with createStack if the join did not land.
            // Without this the new member stays a plain tab, we publish it as
            // one, and the peer that just added it to its own stack faithfully
            // takes it back out again: "a tab opened inside a stack arrives
            // top-level, then leaves the stack on the machine it was created
            // on".
            let landed = await ADAPTER.awaitStack(members, null, 2000, gid);
            if (!landed) {
              console.warn(LOG, "addToStack did not land for", p.name || gid,
                "— rebuilding the stack from all", members.length, "members");
              const rebuilt = await ADAPTER.createStack(members);
              landed = (await ADAPTER.awaitStack(members, null, 2000, rebuilt)) || rebuilt;
            }
            if (landed) gid = landed; else settled = false;
          }
          // VIVA-DIAG (verbose): console.debug(LOG, "extended stack", p.name || p.gid, "+", p.memberIds.length);
        } else if (members.length >= 2) {
          await new Promise((r) => setTimeout(r, 300));
          const newGid = await ADAPTER.createStack(members);
          // `newGid` is the group the backend just answered with: wait for THAT
          // one, or a set of members that are still together in the group they
          // came from reads as "settled" and the name below lands on it.
          gid = (await ADAPTER.awaitStack(members, null, 2000, newGid)) || newGid;
          if (!gid) settled = false;
          // VIVA-DIAG (verbose): console.debug(LOG, "created stack", p.name || newGid, "members", p.memberIds.length);
        }
        // Name it only when it is actually wrong. setGroupProperties is a real
        // browser mutation; re-asserting a name that is already correct on
        // every reconcile is pure churn, and it costs another settle wait.
        if (gid && p.name && members.length >= 2 && !(await ADAPTER.stackNamed(members, p.name))) {
          await ADAPTER.setStackName(gid, p.name);
          if (!(await ADAPTER.awaitStack(members, p.name))) settled = false;
        }
        // The colour, on the same terms and for the same reasons: only when it
        // is actually wrong (a re-assertion per reconcile is churn and costs a
        // settle wait), and waited out, because the snapshot carries it and
        // publishing early tells every peer the colour reverted. It goes after
        // the name because the two are separate setGroupProperties calls, each
        // carrying one property — VivaSync.diagMakeStack() reports whether this
        // build really leaves the other alone (nameKeptOnColor).
        if (gid && p.colorClaimed && members.length >= 2 &&
            !(await ADAPTER.stackColored(members, p.color))) {
          await ADAPTER.setStackColor(gid, p.color);
          if (!(await ADAPTER.awaitStackColor(members, p.color))) settled = false;
        }
       } catch (e) {
        settled = false;
        console.error(LOG, "reconcile group-phase failed", p.name, e);
       }
      }

      // --- Pin phase: the one attribute changed in place, not by identity ---
      //
      // Tab identity is (container, normUrl), so a tab whose only difference
      // from the desired document is its pin state is ALREADY here: no create
      // runs for it and no delete either. Without this phase the flag would be
      // honoured only by createTab — pinning a tab on one device would do
      // nothing on the other unless that tab happened to be new there.
      //
      // Last, after the create, delete and group phases, because pinning moves
      // a tab to the front of the strip (doing it inline would reshuffle
      // indices under phases still planning on them) and because a move may
      // strip a pin (see createTab) — so the live state is re-read HERE rather
      // than predicted through the moves above, and only a real difference is
      // acted on. Nothing here depends on order; a failure is per tab and never
      // abandons the rest. A refusal is logged, not acted on: invariant 2 makes
      // it harmless to the protocol (the acknowledgement goes out under the
      // peer's origin, unpinned, and the peer never applies its own origin), but
      // it is the difference between "the pin does not sync" and "the pin syncs
      // and this build will not set it" — VivaSync.diagPin() tells which.
      //
      // A tab that is to be pinned and that the document does NOT put inside a
      // stack must not stay in one. The views above already treat such a tab as
      // top-level whatever group it reports (buildSnapshot publishes it that
      // way), so nothing else in this function differs from the document while
      // the browser state does — the group would outlive every reconcile. This
      // is what repairs a workspace left with a pinned tab as the first member
      // of an ordinary stack. A member of a stack the document
      // itself pins is exempt (plannedMember): that group is meant to be
      // pinned, as a whole.
      if (pinPlan.size) {
        const live2 = new Map((await ADAPTER.tabsInWindow(winId)).map((t) => [t.id, t]));
        // Raw group sizes in this workspace, pinned members included — the one
        // place that still sees the stack a pinned tab is sitting in.
        const rawCount = new Map();
        for (const t of live2.values()) {
          const ext = ADAPTER.parseTabExt(t);
          if (ADAPTER.wsKey(ext.workspaceId) !== ADAPTER.wsKey(ws.id)) continue;
          const g = ADAPTER.stackIdOf(ext);
          if (g) rawCount.set(g, (rawCount.get(g) || 0) + 1);
        }
        const fixes = [];
        for (const [id, want] of pinPlan) {
          let t = live2.get(id);
          if (!t) continue; // gone
          const g = want && !plannedMember.has(id) ? ADAPTER.stackIdOf(ADAPTER.parseTabExt(t)) : null;
          if (g && (rawCount.get(g) || 0) >= 2) {
            console.debug(LOG, "pinned tab", id, "sits inside a stack — taking it out first");
            if (await unstackPinned(id)) rawCount.set(g, rawCount.get(g) - 1);
            t = await chrome.tabs.get(id).catch(() => null);
            if (!t) continue;
          }
          if (!!t.pinned === want) continue; // already as wanted
          fixes.push({ id, want, nurl: normUrl(tabUrl(t)) });
          try {
            await chrome.tabs.update(id, { pinned: want });
          } catch (e) {
            console.warn(LOG, "could not", want ? "pin" : "unpin", "tab", id, "—", e && e.message);
          }
        }
        if (fixes.length) {
          const after = new Map((await ADAPTER.tabsInWindow(winId)).map((t) => [t.id, t]));
          for (const f of fixes) {
            const t = after.get(f.id);
            if (!t) continue; // closed under us; not ours to worry about
            if (!!t.pinned !== f.want) {
              console.warn(LOG, "tab", f.id, "refused to", f.want ? "pin" : "unpin", "—", f.nurl,
                "(VivaSync.diagPin() reports what this build honours)");
            } else if (ADAPTER.wsKey(ADAPTER.parseTabExt(t).workspaceId) !== ADAPTER.wsKey(ws.id)) {
              console.warn(LOG, "tab", f.id, "left workspace", workspaceName, "when", f.want ? "pinned" : "unpinned");
            }
          }
          console.debug(LOG, "reconcile", workspaceName, "—", fixes.length, "pin change(s)");
        }

        // Pinning a STACK is pinning each of its members, one chrome.tabs.update
        // at a time, because that is the only way the API offers — the user's
        // own gesture pins the stack as a unit. Whether the group survives it is
        // not something this context can know (VivaSync.diagPin() reports it as
        // memberPinKeptGroup / stackPinKeptGroup), so the group is read back and
        // rebuilt when it came apart, exactly as phase 2 does for a join that
        // did not land. A rebuild that does not settle leaves settled=false, and
        // reconcile publishes nothing this round: a document describing a stack
        // that is half pinned and half not is an instruction to every peer to
        // take it apart. Only stacks a pin change actually touched are checked.
        const touched = new Set(fixes.map((f) => f.id));
        for (const p of stackPlans) {
          const planned = [...new Set([...(p.keptIds || []), ...p.memberIds, ...(p.memberOrder || [])])];
          if (planned.length < 2 || !planned.some((id) => touched.has(id))) continue;
          const alive = [];
          for (const id of planned) {
            const t = await chrome.tabs.get(id).catch(() => null);
            if (t) alive.push({ id, gid: ADAPTER.stackIdOf(ADAPTER.parseTabExt(t)) });
          }
          if (alive.length < 2) continue;
          const g0 = alive[0].gid;
          if (g0 != null && alive.every((x) => x.gid === g0)) continue; // still one stack
          console.warn(LOG, p.pinned ? "pinning" : "unpinning", p.name || "a stack",
            "took it apart — rebuilding it from all", alive.length, "members",
            "(VivaSync.diagPin() reports what this build does to a member's group)");
          const ids = alive.map((x) => x.id);
          let rebuilt = null;
          try { rebuilt = await ADAPTER.createStack(ids); } catch (e) {
            console.warn(LOG, "could not rebuild", p.name || "the stack", "—", e && e.message);
          }
          // The name is re-asserted separately: a rebuilt group is a NEW group
          // as far as the backend is concerned, and it carries no title.
          const landed = await ADAPTER.awaitStack(ids, null, 2000, rebuilt);
          if (!landed) { settled = false; continue; }
          if (p.name && !(await ADAPTER.stackNamed(ids, p.name))) {
            await ADAPTER.setStackName(landed, p.name);
            if (!(await ADAPTER.awaitStack(ids, p.name))) settled = false;
          }
          // ...and the colour, which a rebuilt group has lost along with it.
          if (p.color && !(await ADAPTER.stackColored(ids, p.color))) {
            await ADAPTER.setStackColor(landed, p.color);
            if (!(await ADAPTER.awaitStackColor(ids, p.color))) settled = false;
          }
        }
      }

      // --- Order phase (R2.2.2b): the tab-bar sequence, last of all ---
      // After the pin phase, because pinning moves a tab to the front of the
      // strip and the indices below have to be final. See applyOrder.
      try {
        const moves = await applyOrder(orderPlan, ws, winId);
        if (moves) console.debug(LOG, "reconcile", workspaceName, "—", moves, "order move(s)");
      } catch (e) {
        console.error(LOG, "reconcile order-phase failed", workspaceName, e);
      }

      // VIVA-DIAG (verbose): post-reconcile final state — uncomment to trace.
      // const finalLive = liveWorkspaceView(await ADAPTER.tabsInWindow(winId), ws.id);
      // console.info(LOG, "reconcile", workspaceName, "done. live after: top=" + finalLive.top.length,
      //   "stacks=" + finalLive.stacks.length);
      return { settled };
    } finally {
      busy = false;
    }
  }

  // ===========================================================================
  // Workspace-switch detection — event-driven (see wireEvents). Cheap enough to
  // call on every tab activation: two chrome.tabs.query calls and a cached pref
  // read, and it does nothing unless the active workspace NAME actually changed.
  // ===========================================================================
  async function checkActiveWorkspace() {
    try {
      const { list, activeId } = await ADAPTER.getWorkspaces();
      const active = activeId == null ? null
        : list.find((x) => ADAPTER.wsKey(x.id) === ADAPTER.wsKey(activeId));
      const name = active ? active.name : null;
      // Tabs outside every workspace are a place too: leaving a workspace for
      // them and coming back is a switch back INTO it, and has to be seen as
      // one.
      if (!name) lastActiveWsName = null;
      if (name && name !== lastActiveWsName) {
        lastActiveWsName = name;
        // A workspace we think is not synced may have been ticked on a peer
        // while this device was down, so the config note is the only place that
        // knows. One note read per switch into an unsynced workspace, at human
        // pace, and it is the difference between "I enabled it over there and
        // this machine ignores it" and sync just working.
        if (!isSynced(name)) await reloadConfig();
        if (isSynced(name)) {
          await reconcile(name, { onOpen: true }); // R2.2 on "workspace opened"
        }
      }
    } catch (e) {
      console.error(LOG, "active-workspace check failed", e);
    }
  }

  // ===========================================================================
  // Event wiring
  // ===========================================================================
  function wireEvents() {
    const onChange = () => scheduleWrite();
    chrome.tabs.onCreated.addListener(onChange);
    chrome.tabs.onRemoved.addListener(onChange);
    chrome.tabs.onRemoved.addListener((id) => { urlChangedAt.delete(id); syncBorn.delete(id); });
    chrome.tabs.onMoved.addListener(onChange);
    chrome.tabs.onAttached.addListener(onChange);
    chrome.tabs.onDetached.addListener(onChange);
    chrome.tabs.onUpdated.addListener((id, info) => {
      // Start this tab's quiet period over. The write that `onChange` arms
      // below will keep re-arming itself until it expires — see SETTINGS.urlSettleMs.
      if (info.url != null) urlChangedAt.set(id, Date.now());
      // It has committed the address a document asked for: an ordinary tab now,
      // and protected while loading like any other (see syncBorn).
      if (info.status === "complete") syncBorn.delete(id);
      // React to url/title/pinned and Vivaldi's vivExtData changes (stack
      // membership / rename surface here in most builds).
      if (
        info.url != null ||
        info.title != null ||
        info.pinned != null ||
        info.vivExtData != null
      ) {
        onChange();
      }
    });

    // Inbound: Vivaldi Sync delivering a peer's note fires these, so a remote
    // change lands while the user stays put (R2.2.4).
    try {
      if (globalThis.vivaldi && vivaldi.notes) {
        vivaldi.notes.onChanged.addListener((id) => onRemoteNote(id));
        vivaldi.notes.onCreated.addListener((id) => onRemoteNote(id));
      }
    } catch (e) {
      console.warn(LOG, "notes events unavailable:", e.message);
    }

    // Workspace switches are detected from tab activation / window focus, not a
    // timer. Switching workspace always changes which tab is active, and the
    // active tab's vivExtData is what defines the active workspace — so these
    // three events cover every switch. There is NO periodic work: with the
    // browser idle the mod costs nothing.
    const onMaybeSwitch = () => {
      if (switchTimer) return;
      switchTimer = setTimeout(() => {
        switchTimer = null;
        checkActiveWorkspace().catch((e) => console.error(LOG, e));
      }, SETTINGS.switchDebounceMs);
    };
    chrome.tabs.onActivated.addListener(onMaybeSwitch);
    chrome.windows.onFocusChanged.addListener(onMaybeSwitch);
    chrome.tabs.onRemoved.addListener(onMaybeSwitch); // closing the last tab can switch workspace
  }

  // A note we did not write changed. Reconcile the active workspace (reconcile
  // is idempotent and gated by provenance, so a spurious call is a no-op) or,
  // for the config note, re-read the selection.
  let remoteTimer = null;
  const remotePending = new Set();
  function onRemoteNote(id) {
    if (id == null || NOTES.isOwn(id)) return; // our own write echoing back
    remotePending.add(String(id));
    if (remoteTimer) return;
    remoteTimer = setTimeout(async () => {
      remoteTimer = null;
      const ids = [...remotePending];
      remotePending.clear();
      // Re-check ownership now rather than only at entry. Creating a note
      // fires onCreated before create() returns its id, so at entry time our
      // own brand-new note is not yet in ownIds — by now it is, and this stops
      // a device reconciling against its own first write.
      const foreign = ids.filter((i) => !NOTES.isOwn(i));
      if (!foreign.length) return;
      try {
        // These events fire for EVERY note in the tree, including the user's
        // own unrelated notes. Resolve each id to its parent (one cheap
        // single-node get) and drop anything outside the VivaSync folder, so
        // editing a shopping list never costs a workspace reconcile.
        const relevant = [];
        for (const i of foreign) {
          const t = await NOTES.classify(i);
          if (t) relevant.push(t);
        }
        if (!relevant.length) return;

        if (relevant.some((t) => t === CONFIG_TITLE)) {
          await reloadConfig();
        }
        if (!autoPull) return;
        await reconcileActive();
      } catch (e) {
        console.error(LOG, "remote note handling failed:", e);
      }
    }, SETTINGS.remoteDebounceMs);
  }

  // Reconcile whichever synced workspace is active right now, regardless of
  // whether it just changed (checkActiveWorkspace only fires on a transition).
  async function reconcileActive() {
    if (busy) return;
    const winId = await ADAPTER.currentWindowId();
    const { list, activeId } = await ADAPTER.getWorkspaces();
    const active = list.find((x) => ADAPTER.wsKey(x.id) === ADAPTER.wsKey(activeId));
    if (!active || !isSynced(active.name)) return;

    // Never apply a remote on top of local work we have not published yet.
    // Reconcile is newest-wins whole-document: anything not in the remote doc
    // gets closed. A tab the user just opened is by definition not in any peer's
    // doc, so pulling before our own write goes out would delete it under their
    // cursor. If we are behind, skip the pull — the pending write is already
    // scheduled, and the peer will converge to us instead.
    const tabs = await ADAPTER.tabsInWindow(winId);
    const sig = signature(buildSnapshot(tabs, active.id, active.name));
    if (lastSig.get(active.name) !== sig) {
      const n = (pullDefers.get(active.name) || 0) + 1;
      pullDefers.set(active.name, n);
      console.debug(LOG, "defer pull for", active.name, "— unpublished local changes (", n, ")");
      // Deferring for ever is indistinguishable from "sync is broken", so say so
      // once it stops looking like ordinary debouncing.
      if (n === 5 || n % 25 === 0) {
        console.warn(
          LOG, "pull for", active.name, "deferred", n, "times in a row — our own",
          "state is not reaching the note, so nothing from other devices is being",
          "applied. Check for write failures above, and VivaSync.diagChurn()."
        );
      }
      pullWanted = true;
      scheduleWrite();
      return;
    }
    pullDefers.delete(active.name);
    await reconcile(active.name);
  }

  // ===========================================================================
  // UI
  // ---------------------------------------------------------------------------
  // Rendered into the VISIBLE window document (window.html), NOT this headless
  // core — main.html is 0x0 and paints nothing. main.html reaches the window
  // document(s) via chrome.extension.getViews() and builds the button/panels
  // with that document's createElement.
  //
  // The status-bar button opens a small popup MENU; the menu opens one of five
  // dialogs, all sharing the same overlay id so only one can be up at a time:
  //
  //   Workspaces — pick the workspaces to sync; persisted to the sync.config note
  //   Exceptions — address prefixes never synchronized; same note, "exceptions"
  //   Settings   — the tunables; same note, "settings"
  //   Debug      — live status rows, diagnostics buttons and the log tail
  //                (listed only when SETTINGS.showDebug)
  //   About      — mod name and version
  //
  // Reachable from the console as VivaSync.menu() / settings() / exceptions() /
  // tuning() / debug() / about().
  // ===========================================================================
  const BTN_ID = "vivasync-toggle-btn";
  const MENU_ID = "vivasync-menu";
  // One id for all the dialogs: opening any of them replaces whichever was up.
  const OVERLAY_ID = "vivasync-settings-overlay";
  // The Debug window's collapsed report block and the line that toggles it.
  const REPORT_ID = "vivasync-debug-report";
  const REPORT_TOGGLE_ID = "vivasync-debug-report-toggle";

  // Live Window objects for the visible per-window UI documents (window.html).
  function visibleViews() {
    try {
      const views = (chrome.extension && chrome.extension.getViews) ? chrome.extension.getViews() : [];
      return (views || []).filter((w) => {
        try { return /window\.html/.test(w.location.href) && w.innerWidth > 0; } catch (_e) { return false; }
      });
    } catch (_e) {
      return [];
    }
  }

  // The document to render a panel into: prefer the focused window, else the first.
  function uiDoc() {
    const vs = visibleViews();
    if (!vs.length) return null;
    const w = vs.find((v) => { try { return v.document.hasFocus(); } catch (_e) { return false; } }) || vs[0];
    return w.document;
  }

  // Preferred mount container within a window document: status bar first, then
  // toolbars, else null (caller falls back to a floating button).
  function findBar(doc) {
    const sels = [".statusbar", ".toolbar-statusbar", "#footer",
      ".toolbar-mainbar", ".toolbar-addressbar", ".toolbar-tabbar-after"];
    for (const s of sels) {
      const el = doc.querySelector(s);
      if (el && el.getBoundingClientRect().height > 4) return el;
    }
    return null;
  }

  // A button styled to sit on either dialog footers or the Debug toolbar.
  // kind: "primary" (accent fill) | "ghost" (outlined, default).
  function mkBtn(doc, label, kind) {
    const b = doc.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      padding: "6px 14px", borderRadius: "6px", cursor: "pointer",
      font: "inherit", border: "1px solid rgba(255,255,255,0.3)",
      background: "transparent", color: "inherit",
    });
    if (kind === "primary") {
      Object.assign(b.style, { background: "var(--colorHighlightBg, #3b82f6)", color: "#fff", border: "0" });
    }
    return b;
  }

  // A tick box — self-drawn, NOT a native <input type=checkbox>. Vivaldi's
  // window.html styles native checkboxes with appearance:none and drives them
  // from its own React handlers, so an injected raw one shows no check state at
  // all (it renders as an empty square whatever its `checked` says) and does not
  // toggle. Every tick box in these dialogs therefore paints itself from state
  // the caller keeps: `isOn()` is read on each render(), and `box.checked`
  // mirrors it so the state can be read straight off the element.
  function mkToggle(doc, isOn) {
    const box = doc.createElement("span");
    const render = () => {
      const on = !!isOn();
      Object.assign(box.style, {
        width: "16px", height: "16px", flex: "0 0 16px", boxSizing: "border-box",
        borderRadius: "3px", display: "inline-flex", alignItems: "center",
        justifyContent: "center", font: "12px system-ui, sans-serif", lineHeight: "1",
        color: "#fff",
        border: "2px solid " + (on ? "var(--colorHighlightBg, #3b82f6)" : "rgba(140,140,140,0.8)"),
        background: on ? "var(--colorHighlightBg, #3b82f6)" : "transparent",
      });
      box.textContent = on ? "✓" : "";
      box.checked = on;
      box.setAttribute("aria-checked", on ? "true" : "false");
    };
    box.setAttribute("role", "checkbox");
    render();
    return { box, render };
  }

  // Shared modal chrome for all the dialogs. Returns the empty content
  // area to fill plus a footer to append buttons to; the caller shows it with
  // show(). Dismissal (backdrop click, Escape, close()) always runs onClose, so
  // the Debug window can stop its refresh timer exactly once.
  function mkDialog(doc, title, subtitle, opts) {
    opts = opts || {};
    const prev = doc.getElementById(OVERLAY_ID);
    if (prev && prev.__vivasyncClose) prev.__vivasyncClose();
    else if (prev) prev.remove();

    const back = doc.createElement("div");
    back.id = OVERLAY_ID;
    Object.assign(back.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.45)",
      zIndex: "2147483647", display: "flex", alignItems: "center",
      justifyContent: "center", font: "13px system-ui, sans-serif",
    });

    const panel = doc.createElement("div");
    Object.assign(panel.style, {
      background: "var(--colorBg, #2b2b2b)", color: "var(--colorFg, #eee)",
      minWidth: "280px", maxWidth: opts.maxWidth || "420px",
      maxHeight: "80vh", overflow: "auto",
      borderRadius: "8px", padding: "16px 18px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      // Vivaldi's UI disables text selection globally; the Debug window's
      // report and log are there to be selected and copied.
      userSelect: "text", WebkitUserSelect: "text", cursor: "auto",
    });

    const h = doc.createElement("div");
    h.textContent = title;
    Object.assign(h.style, { fontWeight: "600", fontSize: "14px", marginBottom: "4px" });
    panel.appendChild(h);

    const sub = doc.createElement("div");
    sub.textContent = subtitle || "";
    Object.assign(sub.style, { opacity: "0.6", fontSize: "12px", marginBottom: "12px" });
    panel.appendChild(sub);

    const content = doc.createElement("div");
    panel.appendChild(content);

    const footer = doc.createElement("div");
    Object.assign(footer.style, { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" });
    panel.appendChild(footer);

    let closed = false;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const close = () => {
      if (closed) return;
      closed = true;
      doc.removeEventListener("keydown", onKey, true);
      back.remove();
      if (opts.onClose) { try { opts.onClose(); } catch (e) { console.error(LOG, e); } }
    };
    back.__vivasyncClose = close;
    back.onclick = (e) => { if (e.target === back) close(); };
    back.appendChild(panel);

    return {
      back, panel, content, footer, close, sub,
      show() {
        doc.addEventListener("keydown", onKey, true);
        doc.body.appendChild(back);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Popup menu — what the status-bar button opens now. Anchored to the button,
  // flipping above it when the button sits in the lower half of the window
  // (the status bar), below it when mounted on a top toolbar.
  // ---------------------------------------------------------------------------
  // Set when init() could not bring the notes transport up. The Debug menu item
  // ignores showDebug in that state — see openMenu.
  let transportDown = false;

  function closeMenu(doc) {
    const ex = doc.getElementById(MENU_ID);
    if (!ex) return false;
    if (ex.__vivasyncTeardown) ex.__vivasyncTeardown();
    ex.remove();
    return true;
  }

  function openMenu(doc, anchor) {
    closeMenu(doc);
    const win = doc.defaultView || window;
    const menu = doc.createElement("div");
    menu.id = MENU_ID;
    Object.assign(menu.style, {
      position: "fixed", zIndex: "2147483647", minWidth: "150px",
      background: "var(--colorBg, #2b2b2b)", color: "var(--colorFg, #eee)",
      border: "1px solid rgba(127,127,127,0.35)", borderRadius: "6px",
      padding: "4px", boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
      font: "13px system-ui, sans-serif", userSelect: "none",
    });

    const items = [
      ["Workspaces", "Choose which workspaces synchronize", () => openSettings(doc)],
      ["Exceptions", "Addresses that are never synchronized", () => openExceptions(doc)],
      ["Settings", "Timings, and whether the Debug window is offered", () => openTuning(doc)],
      ["About", NAME + " " + VERSION, () => openAbout(doc)],
    ];
    // Debug is a diagnostic the ordinary user never needs, so it is offered only
    // once they have asked for it in Settings. The entry point itself is never
    // gated: VivaSync.debug() works either way, and the menu is rebuilt on every
    // open, so ticking the box shows the item immediately.
    //
    // ...except when the transport never came up, which is precisely when the
    // Debug window is wanted and precisely when the note that would carry
    // showDebug cannot be read. A degraded mod always offers it.
    if (SETTINGS.showDebug || transportDown) {
      items.splice(3, 0, ["Debug", "Status, diagnostics and log", () => openDebug(doc)]);
    }
    for (const [label, tip, run] of items) {
      const it = doc.createElement("div");
      it.textContent = label;
      it.title = tip;
      Object.assign(it.style, { padding: "6px 12px", borderRadius: "4px", cursor: "pointer" });
      it.onmouseenter = () => { it.style.background = "rgba(127,127,127,0.2)"; };
      it.onmouseleave = () => { it.style.background = "transparent"; };
      it.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(doc);
        Promise.resolve().then(run).catch((err) => console.error(LOG, "menu:", label, err));
      });
      menu.appendChild(it);
    }

    doc.body.appendChild(menu); // append first: offsetWidth/Height must be real
    const r = anchor ? anchor.getBoundingClientRect() : { left: 8, top: win.innerHeight - 8, bottom: win.innerHeight - 8 };
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const clamp = (v, max) => Math.min(Math.max(4, v), Math.max(4, max));
    menu.style.left = clamp(r.left, win.innerWidth - mw - 4) + "px";
    menu.style.top = clamp(
      r.top > win.innerHeight / 2 ? r.top - mh - 6 : r.bottom + 6,
      win.innerHeight - mh - 4
    ) + "px";

    // Dismiss on any click outside and on Escape. Registered on the next tick so
    // the click that opened the menu doesn't immediately close it again.
    //
    // The anchor is excluded deliberately: this listener is in the CAPTURE
    // phase, so it runs before the button's own handler. Without the exclusion a
    // second click on the button would close the menu here and then have the
    // button's toggle reopen it — the menu would never close by clicking it.
    const onDocClick = (e) => {
      if (menu.contains(e.target)) return;
      if (anchor && anchor.contains && anchor.contains(e.target)) return;
      closeMenu(doc);
    };
    const onKey = (e) => { if (e.key === "Escape") closeMenu(doc); };
    const t = setTimeout(() => {
      doc.addEventListener("click", onDocClick, true);
      doc.addEventListener("keydown", onKey, true);
    }, 0);
    menu.__vivasyncTeardown = () => {
      clearTimeout(t);
      doc.removeEventListener("click", onDocClick, true);
      doc.removeEventListener("keydown", onKey, true);
    };
  }

  function toggleMenu(doc, anchor) {
    doc = doc || uiDoc();
    if (!doc) { console.warn(LOG, "toggleMenu: no visible window document"); return; }
    if (closeMenu(doc)) return;
    openMenu(doc, anchor || doc.getElementById(BTN_ID));
  }

  async function openSettings(doc) {
    doc = doc || uiDoc();
    if (!doc) { console.warn(LOG, "openSettings: no visible window document"); return; }

    const list = await ADAPTER.workspaceList(true);
    // Fold in any workspace that has live tabs but isn't in the prefs list yet
    // (e.g. just created) — see ADAPTER.liveWorkspaceIds. Shown with a
    // placeholder; it picks up the real name next time the dialog is opened.
    const knownIds = new Set(list.map((w) => ADAPTER.wsKey(w.id)));
    for (const [k, rawId] of await ADAPTER.liveWorkspaceIds()) {
      if (!knownIds.has(k)) list.push({ id: rawId, name: "" });
    }
    // Re-read the note rather than trusting the in-memory copy. A peer's edit
    // to sync.config reaches us as a notes change event, and that event is
    // missed whenever the change is delivered while this device is not running
    // (initial sync at startup is the common case) — leaving the dialog showing
    // a workspace as un-synced that every other machine considers synced, and
    // this device silently not publishing it.
    await reloadConfig().catch((e) => console.warn(LOG, "config reload failed:", e && e.message));
    const selected = new Set(syncedWorkspaces);

    const d = mkDialog(doc, `${NAME} — workspaces to synchronize`, `this device: ${machine}`);
    const panel = d.content;

    // Only the workspaces this dialog can actually SHOW are up for editing.
    // A synced workspace missing from the list (it lives on another machine, or
    // Vivaldi has not populated vivaldi.workspaces.list yet) must not be
    // untickable-by-absence — writeConfig's `scope` is what keeps this device
    // in it, and seeding `chosen` from the rows is what makes that guard real
    // rather than incidentally unreachable.
    const shown = list.map((w) => w.name).filter(Boolean);
    const chosen = new Set(shown.filter((n) => selected.has(n)));
    if (!list.length) {
      const empty = doc.createElement("div");
      empty.textContent = "No workspaces found.";
      empty.style.opacity = "0.7";
      panel.appendChild(empty);
    }
    for (const ws of list) {
      const name = ws.name;
      const row = doc.createElement("div");
      row.className = "vivasync-ws-row";
      if (name) row.setAttribute("data-ws", name);
      Object.assign(row.style, {
        display: "flex", alignItems: "center", gap: "10px",
        padding: "6px 6px", borderRadius: "4px", userSelect: "none",
      });

      // Live-tab-only entry (ADAPTER.liveWorkspaceIds fallback): the workspace
      // exists but Vivaldi hasn't written its name to vivaldi.workspaces.list
      // yet. Selections are stored/matched by NAME, so an empty name can never
      // resolve to a real workspace — show it, but non-interactive, rather than
      // let a click silently no-op.
      if (!name) {
        Object.assign(row.style, { opacity: "0.65", fontStyle: "italic" });
        const span = doc.createElement("span");
        span.textContent = "New workspace — reopen this dialog once it's named to sync it";
        row.appendChild(span);
        panel.appendChild(row);
        continue;
      }

      row.style.cursor = "pointer";
      row.onmouseenter = () => { row.style.background = "rgba(127,127,127,0.15)"; };
      row.onmouseleave = () => { row.style.background = "transparent"; };

      // Self-drawn, like every tick box here — see mkToggle.
      const { box, render } = mkToggle(doc, () => chosen.has(name));

      // Name, and under it the devices this workspace is shared with. The
      // checkbox is this device's membership of that list and nothing else —
      // the config note is shared, so the row has to show what the OTHER
      // machines decided or ticking it looks like a purely local switch.
      const label = doc.createElement("div");
      Object.assign(label.style, { display: "flex", flexDirection: "column", gap: "1px", minWidth: "0" });
      const span = doc.createElement("span");
      span.textContent = name;
      const peersLine = doc.createElement("span");
      Object.assign(peersLine.style, { fontSize: "11px", opacity: "0.65" });
      const basePeers = peersOf(name);
      const renderPeers = () => {
        const on = chosen.has(name)
          ? (basePeers.includes(machine) ? basePeers : basePeers.concat(machine))
          : basePeers.filter((d) => d !== machine);
        peersLine.textContent = on.length ? "Synced on: " + on.join(", ") : "";
        peersLine.style.display = on.length ? "" : "none";
      };
      renderPeers();
      label.appendChild(span);
      label.appendChild(peersLine);

      row.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (chosen.has(name)) chosen.delete(name); else chosen.add(name);
        render();
        renderPeers();
      });

      row.appendChild(box);
      row.appendChild(label);
      panel.appendChild(row);
    }

    const cancel = mkBtn(doc, "Cancel");
    const save = mkBtn(doc, "Save", "primary");

    cancel.onclick = () => d.close();
    save.onclick = async () => {
      const names = [...chosen];
      // What actually changed on THIS device, which is what R2.5 acts on — a
      // workspace that was already ticked before the dialog opened must not be
      // re-published (it would re-stamp a document the peers are using).
      const added = names.filter((n) => !selected.has(n));
      const dropped = shown.filter((n) => selected.has(n) && !chosen.has(n));
      d.close();
      try {
        await writeConfig(names, shown);
        console.info(LOG, "synced on this device:", names.length ? names.join(", ") : "(none)",
          "— config:", JSON.stringify(serializeEntries(configWorkspaces)));
        // R2.5: publish/withdraw immediately, so ticking a workspace does
        // something visible without waiting for the user to switch into it.
        for (const n of dropped) await unpublishOnDisable(n);
        for (const n of added) await publishOnEnable(n);
        // Pull immediately if the active workspace was just enabled.
        await reconcileActive();
      } catch (e) {
        console.error(LOG, "saving config failed:", e);
      }
    };
    d.footer.appendChild(cancel);
    d.footer.appendChild(save);
    d.show();
  }

  // ---------------------------------------------------------------------------
  // Exceptions — the "exceptions" list of sync.config: one address prefix per
  // row, editable in place, removable, with an empty row appended by "Add".
  // Save replaces the list (writeExceptions).
  // ---------------------------------------------------------------------------
  async function openExceptions(doc) {
    doc = doc || uiDoc();
    if (!doc) { console.warn(LOG, "openExceptions: no visible window document"); return; }
    // Same reason as openSettings: the note is shared and a peer's edit may
    // have been delivered while this device was not running.
    await reloadConfig().catch((e) => console.warn(LOG, "config reload failed:", e && e.message));

    const d = mkDialog(doc, `${NAME} — addresses excluded from sync`,
      "A tab whose address begins with one of these is never synchronized. " +
      "Scheme, \"www.\" and letter case do not matter: www.google.com/maps covers " +
      "https://google.com/maps/@40.08,-75.09,…", { maxWidth: "520px" });
    const panel = d.content;

    const rows = doc.createElement("div");
    Object.assign(rows.style, { display: "flex", flexDirection: "column", gap: "6px" });
    panel.appendChild(rows);

    const empty = doc.createElement("div");
    empty.textContent = "No exceptions — every tab in a synced workspace is synchronized.";
    empty.style.opacity = "0.7";
    empty.style.padding = "4px 0";
    panel.appendChild(empty);

    const inputs = [];
    const renderEmpty = () => { empty.style.display = inputs.length ? "none" : ""; };

    // Vivaldi's window.html listens for keyboard shortcuts on the document —
    // single-key ones included — so a keystroke in an injected input must not
    // bubble out of it, or typing "1" in the address field switches tabs.
    const swallow = (e) => e.stopPropagation();

    const addRow = (value, focus) => {
      const row = doc.createElement("div");
      row.className = "vivasync-exc-row";
      Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px" });
      const inp = doc.createElement("input");
      inp.type = "text";
      inp.value = value || "";
      inp.placeholder = "www.example.com/path";
      inp.spellcheck = false;
      Object.assign(inp.style, {
        flex: "1 1 auto", minWidth: "0", font: "inherit", padding: "5px 8px",
        borderRadius: "4px", border: "1px solid rgba(127,127,127,0.5)",
        background: "rgba(127,127,127,0.12)", color: "inherit",
      });
      for (const t of ["keydown", "keyup", "keypress"]) inp.addEventListener(t, swallow);
      const rm = mkBtn(doc, "✕");
      rm.title = "Remove";
      Object.assign(rm.style, { padding: "4px 9px", flex: "0 0 auto" });
      rm.onclick = (e) => {
        e.preventDefault();
        const i = inputs.indexOf(inp);
        if (i >= 0) inputs.splice(i, 1);
        row.remove();
        renderEmpty();
      };
      row.appendChild(inp);
      row.appendChild(rm);
      rows.appendChild(row);
      inputs.push(inp);
      renderEmpty();
      if (focus && typeof inp.focus === "function") inp.focus();
      return inp;
    };
    for (const v of exceptionsRaw) addRow(v, false);

    const add = mkBtn(doc, "Add");
    add.style.marginTop = "10px";
    add.onclick = (e) => { e.preventDefault(); addRow("", true); };
    panel.appendChild(add);

    const cancel = mkBtn(doc, "Cancel");
    const save = mkBtn(doc, "Save", "primary");
    cancel.onclick = () => d.close();
    save.onclick = async () => {
      const list = normalizeExceptions(inputs.map((i) => i.value));
      d.close();
      try {
        await writeExceptions(list);
      } catch (e) {
        console.error(LOG, "saving exceptions failed:", e);
      }
    };
    d.footer.appendChild(cancel);
    d.footer.appendChild(save);
    d.show();
  }

  // ---------------------------------------------------------------------------
  // Settings — the tunables, one field each, saved into the "settings" object of
  // sync.config (writeSettings). Only what differs from the code's default is
  // written, so the note keeps reading as "what this install changed".
  //
  // logMax/logLineMax are deliberately absent: they size the log the Debug
  // window shows and change nothing a user can observe in their tabs, which is
  // the only thing the rest of this dialog talks about. They stay editable by
  // hand in the note, and a Save here carries them through untouched.
  //
  // The tips are written for someone watching their own browser, not someone
  // reading this file: each one says what the number does and, in the terms of
  // something they might actually be seeing, which way to move it.
  // ---------------------------------------------------------------------------
  const TUNABLE_FIELDS = [
    {
      key: "urlSettleMs",
      label: "Address settle time",
      tip: "How long a tab's address has to stop changing before this device tells the " +
        "others about it. Some sites rewrite their address as you type in them (a search " +
        "box, Google Translate), and every half-typed value looks like a real page. " +
        "INCREASE it if half-finished addresses keep appearing on your other machine, or " +
        "a tab there reloads through everything you typed here. DECREASE it if a page you " +
        "open takes noticeably long to show up on the other device.",
    },
    {
      key: "maxSettleHoldMs",
      label: "Longest wait for a restless tab",
      tip: "The point at which a tab whose address will not settle is published anyway. " +
        "Some pages rewrite their address on a timer for ever, and without this limit the " +
        "whole workspace would stop syncing while one of them is open. INCREASE it if such " +
        "a page keeps arriving on your other devices in a state it was only passing " +
        "through. DECREASE it if one restless tab holds up everything else you change.",
    },
    {
      key: "writeDebounceMs",
      label: "Delay before publishing your changes",
      tip: "How long this device waits after you open, close, move or restack a tab before " +
        "it publishes what the workspace now looks like. INCREASE it if you often make a " +
        "burst of changes (closing ten tabs, rearranging a stack) and would rather they " +
        "travelled as one. DECREASE it to have each change reach your other devices sooner.",
    },
    {
      key: "switchDebounceMs",
      label: "Delay after switching workspace",
      tip: "How long to wait, after you switch workspace or window, before checking what is " +
        "now in front of you and syncing it. INCREASE it if switching feels sluggish, or if " +
        "flicking through several workspaces sets off work you did not need. DECREASE it if " +
        "a workspace you switch into takes too long to pick up what another device changed.",
    },
    {
      key: "minNoteWriteGapMs",
      label: "Least time between two updates of one workspace",
      tip: "Each update rewrites Vivaldi's Notes store and sends one sync entity, so this is " +
        "the main cost of running VivaSync. INCREASE it on a slow machine, a metered " +
        "connection, or if Vivaldi hesitates while you work — changes then arrive a few " +
        "seconds later than they could. DECREASE it for a livelier sync, at the price of " +
        "more sync traffic and more work for the browser.",
    },
    {
      key: "remoteDebounceMs",
      label: "Delay before applying other devices' changes",
      tip: "How long incoming changes are collected before this device acts on them. " +
        "INCREASE it if tabs from another machine arrive in a stuttering trickle (typically " +
        "when it has been offline and everything lands at once). DECREASE it to see what " +
        "your other devices do a little sooner.",
    },
    {
      key: "groupSettleRetryMs",
      label: "Retry delay for tab stacks",
      tip: "When Vivaldi has not finished forming a tab stack, nothing is published until it " +
        "has — a half-built stack would tell your other devices to take the stack apart. " +
        "This is how long to wait before looking again. INCREASE it if stacks arrive on the " +
        "other machine incomplete, or come apart shortly after syncing. DECREASE it if a " +
        "stack you make takes too long to appear there.",
    },
  ];

  const SHOW_DEBUG_TIP =
    "Turns on an optional Debug UI to allow detailed issues analysis and diagnostics";

  async function openTuning(doc) {
    doc = doc || uiDoc();
    if (!doc) { console.warn(LOG, "openTuning: no visible window document"); return; }
    // Same reason as the other dialogs: the note is shared, and a peer may have
    // changed a value while this device was not running to hear about it.
    await reloadConfig().catch((e) => console.warn(LOG, "config reload failed:", e && e.message));

    const d = mkDialog(doc, `${NAME} — settings`,
      "Timings the synchronizer runs on. The defaults suit an ordinary install; " +
      "hover a name to see what changing it does. Values are in milliseconds, " +
      "and are shared with every device through the sync.config note.",
      { maxWidth: "560px" });

    // Vivaldi's window.html listens for keyboard shortcuts on the document —
    // single-key ones included — so a keystroke in an injected input must not
    // bubble out of it (see the Exceptions dialog).
    const swallow = (e) => e.stopPropagation();

    const rows = doc.createElement("div");
    Object.assign(rows.style, { display: "flex", flexDirection: "column", gap: "8px" });
    d.content.appendChild(rows);

    const fields = [];
    for (const f of TUNABLE_FIELDS) {
      const row = doc.createElement("div");
      row.className = "vivasync-set-row";
      row.title = f.tip;
      Object.assign(row.style, { display: "flex", alignItems: "center", gap: "10px" });

      const label = doc.createElement("label");
      label.textContent = f.label;
      label.title = f.tip;
      Object.assign(label.style, { flex: "1 1 auto", cursor: "help" });

      const hint = doc.createElement("span");
      hint.textContent = `default ${SETTINGS_DEFAULTS[f.key]}`;
      Object.assign(hint.style, { opacity: "0.55", fontSize: "11px", flex: "0 0 auto" });

      const inp = doc.createElement("input");
      inp.type = "text";
      inp.title = f.tip;
      inp.setAttribute("data-setting", f.key); // what the tests find the field by
      inp.value = String(SETTINGS[f.key]);
      inp.placeholder = String(SETTINGS_DEFAULTS[f.key]);
      inp.spellcheck = false;
      Object.assign(inp.style, {
        flex: "0 0 90px", font: "inherit", padding: "5px 8px", textAlign: "right",
        borderRadius: "4px", border: "1px solid rgba(127,127,127,0.5)",
        background: "rgba(127,127,127,0.12)", color: "inherit",
      });
      for (const t of ["keydown", "keyup", "keypress"]) inp.addEventListener(t, swallow);

      row.appendChild(label);
      row.appendChild(hint);
      row.appendChild(inp);
      rows.appendChild(row);
      fields.push({ ...f, input: inp });
    }

    // showDebug — a switch, not a timing, so it sits below the numbers.
    const dbgRow = doc.createElement("div");
    dbgRow.className = "vivasync-set-row";
    dbgRow.title = SHOW_DEBUG_TIP;
    Object.assign(dbgRow.style, {
      display: "flex", alignItems: "center", gap: "8px", marginTop: "12px",
      paddingTop: "10px", borderTop: "1px solid rgba(127,127,127,0.25)",
    });
    dbgRow.setAttribute("data-setting", "showDebug");
    let showDebug = !!SETTINGS.showDebug;
    const dbg = mkToggle(doc, () => showDebug);
    const dbgLabel = doc.createElement("span");
    dbgLabel.textContent = "Show the Debug window in the menu";
    // ONE listener, on the row — a click on the box or the label reaches it by
    // bubbling, exactly as in the workspace picker. Binding the box and the
    // label as well would fire twice for a click on them and leave the switch
    // where it was; the offline DOM double does not bubble, so that bug would
    // not show up in the suite.
    dbgRow.style.cursor = "pointer";
    dbgRow.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showDebug = !showDebug;
      dbg.render();
    });
    dbgRow.appendChild(dbg.box);
    dbgRow.appendChild(dbgLabel);
    d.content.appendChild(dbgRow);

    // A refused value keeps the dialog open and says which field it was: closing
    // on a typo would silently save everything except the one thing being edited.
    const err = doc.createElement("div");
    Object.assign(err.style, { color: "#ef5350", marginTop: "10px", display: "none" });
    d.content.appendChild(err);

    const cancel = mkBtn(doc, "Cancel");
    const save = mkBtn(doc, "Save", "primary");
    cancel.onclick = () => d.close();
    save.onclick = async () => {
      const values = {};
      for (const f of fields) {
        const raw = String(f.input.value == null ? "" : f.input.value).trim();
        // An empty field means "whatever the mod ships with", which is also how
        // the value leaves the note again.
        const value = raw === "" ? SETTINGS_DEFAULTS[f.key] : Number(raw);
        const min = SETTINGS_MIN[f.key] != null ? SETTINGS_MIN[f.key] : 0;
        if (!isFinite(value) || value < min) {
          err.textContent = `${f.label}: enter a number of milliseconds (${min} or more), ` +
            `or leave it empty for the default of ${SETTINGS_DEFAULTS[f.key]}.`;
          err.style.display = "";
          if (typeof f.input.focus === "function") f.input.focus();
          return;
        }
        values[f.key] = value;
      }
      values.showDebug = showDebug;
      d.close();
      try {
        await writeSettings(values);
      } catch (e) {
        console.error(LOG, "saving settings failed:", e);
      }
    };
    d.footer.appendChild(cancel);
    d.footer.appendChild(save);
    d.show();
  }

  // ---------------------------------------------------------------------------
  // About
  // ---------------------------------------------------------------------------
  function openAbout(doc) {
    doc = doc || uiDoc();
    if (!doc) { console.warn(LOG, "openAbout: no visible window document"); return; }

    const d = mkDialog(doc, NAME, "Version " + VERSION, { maxWidth: "380px" });

    const blurb = doc.createElement("div");
    blurb.textContent =
      "Synchronizes selected Vivaldi workspaces — tabs and tab stacks — across " +
      "devices. Every sync document is a note in the " + FOLDER + " folder, so " +
      "Vivaldi Sync (with notes enabled) is the transport.";
    Object.assign(blurb.style, { lineHeight: "1.5", marginBottom: "12px", opacity: "0.9" });
    d.content.appendChild(blurb);

    const facts = [
      ["Device", machine],
      ["Notes folder", FOLDER],
      ["Config", configSource || "(not loaded)"],
      ["Synced workspaces", syncedWorkspaces.length ? syncedWorkspaces.join(", ") : "(none)"],
    ];
    const table = doc.createElement("div");
    Object.assign(table.style, {
      display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "12px",
    });
    for (const [k, v] of facts) {
      const kEl = doc.createElement("div");
      kEl.textContent = k;
      kEl.style.opacity = "0.6";
      const vEl = doc.createElement("div");
      vEl.textContent = v;
      vEl.style.wordBreak = "break-word";
      table.appendChild(kEl);
      table.appendChild(vEl);
    }
    d.content.appendChild(table);

    const close = mkBtn(doc, "Close", "primary");
    close.onclick = () => d.close();
    d.footer.appendChild(close);
    d.show();
  }

  // ---------------------------------------------------------------------------
  // Debug window
  // ---------------------------------------------------------------------------
  // The console equivalent of VivaSync.introspect()/diag*, rendered where the
  // user can actually see it — vivaldi://inspect is not something to ask for in a bug
  // report. Status rows are recomputed on open and on Refresh (they hit the
  // notes API); the log tail is cheap and follows the ring buffer on a timer
  // that only runs while the window is open.
  // ---------------------------------------------------------------------------
  const STATUS_COLORS = { PASS: "#4caf50", FAIL: "#ef5350", WARN: "#ffa726", INFO: "#64b5f6" };

  function fmtAge(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s";
    return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
  }

  // The rows the Debug window shows. Every section is independently guarded:
  // this has to render something useful precisely when part of the mod is broken.
  async function collectStatus() {
    const rows = [];
    const add = (key, status, detail) => rows.push({ key, status, detail: String(detail) });

    // The tunables are reported as "what is not stock": a bug report needs to
    // say whether the engine is running on the timings the code documents.
    const tuned = tunedSettings();
    add("A. engine", "INFO",
      `${NAME} v${VERSION} — device "${machine}", up ${fmtAge(Date.now() - STARTED_AT)}, ` +
      `kv=${KV.backend}, autoPull=${autoPull}, urlSettle=${SETTINGS.urlSettleMs}ms | ` +
      `settings: ${tuned.length ? tuned.join(", ") + " (rest default)" : "all default"}`);

    let notes = null;
    try {
      if (NOTES.folderId == null) await NOTES.init();
      notes = await NOTES.list("");
      const own = notes.filter((n) => NOTES.isOwn(n.id)).length;
      const bad = notes.filter((n) => n.error);
      add("B. transport", bad.length ? "WARN" : "PASS",
        `folder "${FOLDER}" id=${NOTES.folderId} — ${notes.length} note(s), ${own} written here` +
        (bad.length ? `; unreadable: ${bad.map((n) => n.name).join(", ")}` : ""));
    } catch (e) {
      add("B. transport", "FAIL",
        `notes transport unavailable: ${e.message || e} — nothing can sync. Is Vivaldi Sync on with notes included?`);
    }

    // Who syncs what, not just what this device syncs: a workspace ticked here
    // and nowhere else has no peer to sync WITH, and that is invisible from the
    // local list alone.
    const shares = configWorkspaces.map((e) => `${e.name} -> ${e.peers.join(", ") || "nobody"}`);
    const lonely = configWorkspaces.filter((e) => e.peers.length === 1 && syncsHere(e));
    add("C. config", syncedWorkspaces.length ? (lonely.length ? "WARN" : "PASS") : "WARN",
      (syncedWorkspaces.length
        ? `${syncedWorkspaces.length} workspace(s) synced: ${syncedWorkspaces.join(", ")} (from "${configSource}")`
        : `no workspaces selected — nothing will sync. Pick some under Workspaces.`) +
      (shares.length ? ` | peers: ${shares.join("; ")}` : "") +
      (exceptionsRaw.length ? ` | ${exceptionsRaw.length} exception(s): ${exceptionsRaw.join(", ")}` : "") +
      (lonely.length
        ? ` | ${lonely.map((e) => `"${e.name}"`).join(", ")}: this is the only device listed — ` +
          `tick it under Workspaces on the other machine too`
        : ""));

    try {
      const { list, activeId } = await ADAPTER.getWorkspaces();
      const active = list.find((w) => ADAPTER.wsKey(w.id) === ADAPTER.wsKey(activeId));
      const name = active ? active.name : null;
      add("D. active workspace", "INFO",
        name
          ? `"${name}" — ${isSynced(name) ? "synced" : "not synced"}` +
            (lastSig.has(name) ? "; published this session" : "; nothing published yet this session") +
            (current.has(name) ? `; holding ${describeProv(current.get(name))}` : "")
          : `none resolved (active tab has no workspaceId) — id=${activeId}`);
    } catch (e) {
      add("D. active workspace", "FAIL", "could not resolve: " + (e.message || e));
    }

    // R2.4: a workspace is only ever written after it has been opened here.
    const waiting = pendingSynced();
    add("E. materialized", waiting.length ? "WARN" : "INFO",
      `opened: ${[...openedWorkspaces].join(", ") || "(none)"} | ever had content: ` +
      `${[...everHadContent].join(", ") || "(none)"}` +
      (waiting.length
        ? ` | NOT YET PUBLISHED: ${waiting.join(", ")} — switch to each one once. A `
          + `workspace Vivaldi has not materialized cannot be snapshotted without `
          + `publishing an empty document, which would close it on every peer.`
        : ""));

    const attempts = Object.entries(openAttempts).sort((a, b) => b[1].n - a[1].n);
    add("F. churn", churnBlocked.size ? "WARN" : "PASS",
      churnBlocked.size
        ? `${churnBlocked.size} URL(s) blocked after ${OPEN_ATTEMPT_CAP} failed attempts: ` +
          [...churnBlocked.values()].join(", ")
        : attempts.length
          ? `no URL blocked; ${attempts.length} tracked, worst ${attempts[0][1].n}/${OPEN_ATTEMPT_CAP} (${attempts[0][0]})`
          : "no URL churn recorded");

    try {
      const views = diagUI();
      const missing = views.filter((v) => !v.hasButton).length;
      add("G. windows", views.length && !missing ? "PASS" : views.length ? "WARN" : "FAIL",
        views.length
          ? views.map((v) => `${v.size} bar=${v.bar || "(floating)"} button=${v.hasButton ? "yes" : "NO"}`).join(" | ")
          : "no visible window document reachable — the toolbar button cannot mount");
    } catch (e) {
      add("G. windows", "FAIL", String(e.message || e));
    }

    for (const n of (notes || []).slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const ts = n.data && n.data.timestamp;
      add("  note " + n.name, n.error ? "FAIL" : "INFO",
        n.error
          ? "unparseable: " + n.error
          : `${n.data && Array.isArray(n.data.items) ? n.data.items.length : "?"} item(s), ` +
            `${ts ? fmtAge(Date.now() - ts * 1000) + " old" : "no timestamp"}` +
            `${NOTES.isOwn(n.id) ? ", written here" : ""}`);
    }

    return rows;
  }

  function openDebug(doc) {
    doc = doc || uiDoc();
    if (!doc) { console.warn(LOG, "openDebug: no visible window document"); return; }

    let timer = null;
    const d = mkDialog(doc, `${NAME} — debug`, `v${VERSION} · device ${machine}`, {
      maxWidth: "640px",
      onClose: () => { if (timer) clearInterval(timer); },
    });

    // The report is a disclosure: the counts line is always visible and is the
    // toggle, the rows themselves start collapsed. They are long, and most of
    // what a reader wants at a glance ("anything FAIL?") is in the counts; the
    // buttons and the log tail stay above the fold, where a bug report needs
    // them. Copy report copies the rows whether or not they are shown.
    const summary = doc.createElement("div");
    Object.assign(summary.style, {
      opacity: "0.8", marginBottom: "8px", cursor: "pointer",
      userSelect: "none", WebkitUserSelect: "none",
    });
    summary.id = REPORT_TOGGLE_ID;
    summary.setAttribute("role", "button");
    summary.setAttribute("tabindex", "0");
    summary.textContent = "▸ collecting…";
    d.content.appendChild(summary);

    const results = doc.createElement("div");
    results.id = REPORT_ID;
    Object.assign(results.style, {
      font: "11px ui-monospace, monospace", lineHeight: "1.45",
      borderTop: "1px solid rgba(127,127,127,0.25)", paddingTop: "8px",
      display: "none",
    });
    d.content.appendChild(results);

    const tools = doc.createElement("div");
    Object.assign(tools.style, { display: "flex", flexWrap: "wrap", gap: "6px", margin: "12px 0 8px" });
    d.content.appendChild(tools);

    const logEl = doc.createElement("pre");
    Object.assign(logEl.style, {
      background: "rgba(0,0,0,0.35)", padding: "6px 8px", borderRadius: "4px",
      whiteSpace: "pre-wrap", wordBreak: "break-word", font: "10px ui-monospace, monospace",
      maxHeight: "180px", overflow: "auto", margin: "0",
      userSelect: "text", WebkitUserSelect: "text", cursor: "text",
    });
    d.content.appendChild(logEl);

    let rows = [];
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

    let reportOpen = false;
    let summaryLine = "collecting…";
    const paintSummary = () => {
      summary.textContent = `${reportOpen ? "▾" : "▸"} ${summaryLine}`;
    };
    const setReportOpen = (open) => {
      reportOpen = open;
      results.style.display = open ? "" : "none";
      paintSummary();
    };
    summary.onclick = () => setReportOpen(!reportOpen);
    // Space and Enter are Vivaldi shortcuts on window.html's document, so the
    // two keys this line handles are stopped here (Escape is not: the dialog
    // listens for it in the capture phase, before this runs).
    summary.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      setReportOpen(!reportOpen);
    };

    const renderRows = () => {
      const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 };
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      summaryLine =
        `${rows.length} report row(s): ` +
        `${counts.PASS} pass, ${counts.FAIL} fail, ${counts.WARN} warn, ${counts.INFO} info` +
        ` — ${new Date().toLocaleTimeString()}`;
      paintSummary();
      results.innerHTML = rows
        .map((r) =>
          `<div style="margin:3px 0"><span style="color:${STATUS_COLORS[r.status] || "#aaa"};font-weight:600">` +
          `${r.status}</span> <b>${esc(r.key)}</b><br><span style="opacity:.75">${esc(r.detail)}</span></div>`)
        .join("");
    };

    let shownSeq = -1;
    const renderLog = () => {
      if (shownSeq === logSeq) return;
      shownSeq = logSeq;
      const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
      logEl.textContent = logBuf.slice(-60).join("\n") || "(no log lines yet)";
      if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    };

    const refresh = async () => {
      try {
        rows = await collectStatus();
      } catch (e) {
        rows = [{ key: "debug", status: "FAIL", detail: "collectStatus threw: " + (e.message || e) }];
      }
      renderRows();
      renderLog();
    };

    const reportText = () =>
      `${NAME} v${VERSION} report ${new Date().toISOString()}\n` +
      rows.map((r) => `${r.status.padEnd(4)}  ${r.key}  ${r.detail}`).join("\n") +
      "\n\n--- log tail ---\n" + logBuf.join("\n");

    // Buttons flash their result in place: the clipboard can fail silently and
    // an async action gives no other feedback inside the dialog.
    const addTool = (label, run) => {
      const b = mkBtn(doc, label);
      Object.assign(b.style, { padding: "4px 10px", fontSize: "12px" });
      b.onclick = async () => {
        const orig = b.textContent;
        b.disabled = true;
        try {
          const msg = await run();
          b.textContent = msg || "done";
        } catch (e) {
          console.error(LOG, "debug:", label, e);
          b.textContent = "failed";
        }
        setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1200);
      };
      tools.appendChild(b);
    };

    const copy = async (text) => {
      const nav = (doc.defaultView || window).navigator;
      if (!nav.clipboard) throw new Error("clipboard unavailable");
      await nav.clipboard.writeText(text);
      return "copied";
    };

    addTool("Refresh", async () => { await refresh(); return "ok"; });
    addTool("Write now", async () => { await writeChanged(true); await refresh(); return "written"; });
    addTool("Reconcile active", async () => { await reconcileActive(); await refresh(); return "done"; });
    addTool("Reload config", async () => { await reloadConfig(); await refresh(); return "reloaded"; });
    addTool("Clear churn", async () => {
      openAttempts = {};
      churnBlocked.clear();
      KV.set("openAttempts", openAttempts);
      console.info(LOG, "churn counters cleared");
      await refresh();
      return "cleared";
    });
    addTool("Copy report", () => copy(reportText()));
    addTool("Copy log", () => copy(logBuf.join("\n")));

    const close = mkBtn(doc, "Close", "primary");
    close.onclick = () => d.close();
    d.footer.appendChild(close);

    d.show();
    // Log tail only — status rows hit the notes API and are refreshed on demand.
    timer = setInterval(renderLog, 500);
    refresh().catch((e) => console.error(LOG, "openDebug:", e));
  }

  // ===========================================================================
  // Status-bar entry point — a "⇄" button in each visible window's status bar
  // (falls back to a floating button in that window if no bar is found). It
  // opens the popup menu (Workspaces / Exceptions / Debug / About). A self-heal timer re-adds
  // it if a React re-render removes it, and covers newly opened windows. Run
  // VivaSync.diagUI() to see where it mounted.
  // ===========================================================================
  function mountButtonIn(doc) {
    if (doc.getElementById(BTN_ID)) return;
    const btn = doc.createElement("button");
    btn.id = BTN_ID;
    btn.title = NAME + " " + VERSION;
    btn.setAttribute("aria-label", "Workspace Sync menu");
    btn.textContent = "⇄";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMenu(doc, btn);
    });

    const bar = findBar(doc);
    if (bar) {
      Object.assign(btn.style, {
        background: "transparent", border: "0", cursor: "pointer",
        font: "inherit", padding: "0 8px", color: "inherit",
        height: "100%", lineHeight: "1", opacity: "0.85",
      });
      bar.appendChild(btn);
    } else {
      Object.assign(btn.style, {
        position: "fixed", right: "12px", bottom: "10px", zIndex: "2147483646",
        width: "30px", height: "30px", borderRadius: "50%", border: "0",
        cursor: "pointer", background: "var(--colorHighlightBg, #3b82f6)",
        color: "#fff", boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        font: "15px system-ui, sans-serif",
      });
      doc.body.appendChild(btn);
    }
  }

  function ensureToggleButton() {
    try {
      for (const w of visibleViews()) mountButtonIn(w.document);
    } catch (e) {
      console.error(LOG, "ensureToggleButton failed", e);
    }
  }

  // ===========================================================================
  // Introspection helper — run VivaSync.introspect() in the UI devtools console
  // to confirm/adjust the version-sensitive field names in ADAPTER.
  // ===========================================================================
  async function introspect() {
    const winId = await ADAPTER.currentWindowId();
    let win = null;
    try {
      win = await chrome.windows.get(winId);
    } catch (_e) {}
    const tabs = await ADAPTER.tabsInWindow(winId);
    const sample = tabs.slice(0, 5).map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      vivExtData: t.vivExtData,
      parsed: ADAPTER.parseTabExt(t),
    }));
    const ws = await ADAPTER.getWorkspaces();
    const notes = await NOTES.list("").catch((e) => `FAIL:${e.message}`);
    const out = {
      version: VERSION,
      device: machine,
      notesFolderId: NOTES.folderId,
      noteTitles: Array.isArray(notes) ? notes.map((n) => n.name) : notes,
      configSource,
      windowId: winId,
      windowExtRaw: win && (win.vivExtData ?? win.extData),
      windowExtParsed: ADAPTER.parseWinExt(win),
      workspaces: ws,
      sampleTabs: sample,
      config: { syncedWorkspaces, workspaces: serializeEntries(configWorkspaces) },
    };
    console.log(LOG, "introspect:", out);
    return out;
  }

  // ===========================================================================
  // VIVA-DIAG: standalone diagnostics (also reachable on the degraded VivaSync
  // when the notes transport failed to come up, which is exactly when they
  // matter).
  // ===========================================================================

  // VIVA-DIAG: enumerate the Vivaldi/chrome API surfaces this mod depends on.
  function diagApis() {
    const dump = (obj, name) => {
      if (typeof obj === "undefined" || obj === null) {
        console.log(LOG, name, "=> not available");
        return;
      }
      const keys = [];
      for (const k in obj) {
        let kind = "?";
        try { kind = typeof obj[k]; } catch (_e) {}
        keys.push(k + ":" + kind);
      }
      console.log(LOG, name, "=>", keys.sort().join(", "));
    };
    const v = typeof vivaldi !== "undefined" ? vivaldi : undefined;
    dump(v, "vivaldi");
    dump(v && v.tabsPrivate, "vivaldi.tabsPrivate");
    dump(v && v.windowPrivate, "vivaldi.windowPrivate");
    dump(v && v.utilities, "vivaldi.utilities");
    dump(v && v.prefs, "vivaldi.prefs");
    dump(v && v.notes, "vivaldi.notes"); // the transport
    dump(v && v.sync, "vivaldi.sync"); // device name
    dump(chrome.tabs, "chrome.tabs");
    // Webpack registry: Vivaldi's createTabStack/updateExtData live in
    // webpack modules. If a chunk push hook is reachable we can pull the
    // module factory cache and find them.
    const wpKeys = Object.keys(window).filter((k) => /webpack/i.test(k));
    console.log(LOG, "webpack globals:", wpKeys.join(", ") || "(none)");
    for (const k of wpKeys) {
      try {
        const v2 = window[k];
        console.log(LOG, "  ", k, "=>", Array.isArray(v2) ? ("array[" + v2.length + "]") : typeof v2);
      } catch (_e) {}
    }
    console.log(LOG, "other globals:", Object.keys(window).filter((k) =>
      /viv|workspace|tabstack|require|__|store|app/i.test(k)).join(", "));
  }

  // VIVA-DIAG: inventory of the transport — the notes analogue of the old
  // "which dir am I writing to / what files are there" diagnostics.
  async function diagNotes() {
    const out = { device: machine, folder: FOLDER, folderId: NOTES.folderId, configSource, notes: [] };
    try {
      if (NOTES.folderId == null) out.folderId = await NOTES.init();
      const list = await NOTES.list("");
      out.notes = list.map((n) => ({
        title: n.name,
        id: n.id,
        origin: n.data && n.data.origin,
        version: n.data && n.data.version,
        timestamp: n.data && n.data.timestamp,
        age: n.data && n.data.timestamp ? Math.round(Date.now() / 1000 - n.data.timestamp) + "s" : null,
        items: n.data && Array.isArray(n.data.items) ? n.data.items.length : null,
        own: NOTES.isOwn(n.id),
        error: n.error,
      }));
    } catch (e) {
      out.error = String(e.message || e);
    }
    console.log(LOG, "diagNotes:", out);
    return out;
  }

  // VIVA-DIAG: which URLs are failing to stay put. A tab blinking open/closed on
  // two devices shows up here as a rising attempt count; once it reaches the cap
  // the URL is listed as blocked and the blinking stops.
  function diagChurn() {
    const out = {
      cap: OPEN_ATTEMPT_CAP,
      ttlMinutes: OPEN_ATTEMPT_TTL_MS / 60000,
      blocked: [...churnBlocked.entries()].map(([nurl, raw]) => ({ url: raw, normalised: nurl })),
      attempts: Object.entries(openAttempts)
        .map(([nurl, a]) => ({ url: nurl, attempts: a.n, agoSeconds: Math.round((Date.now() - a.at) / 1000) }))
        .sort((a, b) => b.attempts - a.attempts),
    };
    console.log(LOG, "diagChurn:", out);
    return out;
  }

  // VIVA-DIAG: report which visible window documents the settings UI can reach,
  // and whether a mount point for the toolbar button was found in each.
  function diagUI() {
    const views = visibleViews();
    const out = views.map((w) => {
      let bar = null;
      try {
        const el = findBar(w.document);
        bar = el ? el.className || el.id || el.tagName : null;
      } catch (_e) {}
      return {
        href: (() => { try { return w.location.href; } catch (_e) { return "?"; } })(),
        size: (() => { try { return w.innerWidth + "x" + w.innerHeight; } catch (_e) { return "?"; } })(),
        bar,
        hasButton: (() => { try { return !!w.document.getElementById(BTN_ID); } catch (_e) { return false; } })(),
      };
    });
    console.log(LOG, "diagUI:", out);
    return out;
  }

  // ===========================================================================
  // Init
  // ===========================================================================
  async function init() {
    await KV.init();
    const savedAttempts = KV.get("openAttempts");
    if (savedAttempts && typeof savedAttempts === "object") {
      openAttempts = savedAttempts;
      // Drop expired entries so a URL that misbehaved last week gets a fresh try.
      for (const [k, v] of Object.entries(openAttempts)) {
        if (!v || Date.now() - (v.at || 0) > OPEN_ATTEMPT_TTL_MS) delete openAttempts[k];
      }
    }
    try {
      machine = await resolveDevice();
      await NOTES.init();
    } catch (e) {
      console.error(LOG, "notes transport unavailable:", e.message);
      transportDown = true;
      // Still expose VivaSync so the user can debug from the console — and
      // mount the button anyway: a dead transport is exactly when the Debug window is
      // wanted, and it renders the failure as its "B. transport" row.
      window.VivaSync = {
        version: VERSION, NOTES, introspect, ADAPTER,
        diagApis, diagNotes, diagUI,
        menu: toggleMenu, settings: openSettings, exceptions: openExceptions,
        tuning: openTuning, debug: openDebug, about: openAbout,
      };
      ensureToggleButton();
      setInterval(ensureToggleButton, 3000);
      return;
    }
    try {
      await reloadConfig();
    } catch (e) {
      console.error(LOG, "config read failed:", e.message);
      syncedWorkspaces = [];
    }
    console.info(LOG, `${NAME} v${VERSION} — device:`, machine, "synced workspaces:", syncedWorkspaces);
    // Only when an install has tuned something: on stock timings this line
    // would be noise in a log the Debug window shows 60 lines of.
    const tunedAtStart = tunedSettings();
    if (tunedAtStart.length) console.info(LOG, "settings from", configSource + ":", tunedAtStart.join(", "));

    window.VivaSync = {
      version: VERSION,
      NOTES,
      ADAPTER,
      reloadConfig,
      introspect,
      reconcile,
      writeNow: () => writeChanged(true),
      snapshot: async (name) => {
        const winId = await ADAPTER.currentWindowId();
        const { list } = await ADAPTER.getWorkspaces();
        const ws = list.find((x) => x.name === name);
        const tabs = await ADAPTER.tabsInWindow(winId);
        return ws ? buildSnapshot(tabs, ws.id, name) : null;
      },
      config: () => ({
        syncedWorkspaces,
        workspaces: serializeEntries(configWorkspaces),
        pending: pendingSynced(),
        configSource,
        device: machine,
        autoPull,
        // The tunables in force, and the subset an install has changed.
        settings: { ...SETTINGS },
        tuned: tunedSettings(),
        urlSettleMs: SETTINGS.urlSettleMs, // the one knob with its own helper
        exceptions: exceptionsRaw.slice(),
        opened: [...openedWorkspaces],
        everHadContent: [...everHadContent],
        sawPeerDoc: [...sawPeerDoc],
        // Provenance of the state held per workspace: {origin, version, timestamp}.
        holding: Object.fromEntries([...current].map(([k, v]) => [k, { ...v }])),
      }),
      settings: openSettings, // the Workspaces dialog
      exceptions: openExceptions,
      tuning: openTuning, // the Settings dialog (the tunables)
      debug: openDebug, // always available here, menu item or not
      about: openAbout,
      menu: toggleMenu,
      // The Debug window's rows as data — for cdp.js and for a headless check.
      status: collectStatus,
      log: (n) => logBuf.slice(-(n || 60)),
      // Turn off pulling on a peer's note change (session-only). Workspace-switch
      // reconcile still works. Persist it with "autoPull": false in the config note.
      autoPull: (on) => {
        autoPull = on !== false;
        console.info(LOG, "autoPull:", autoPull);
        return autoPull;
      },
      // How long a tab's URL must hold still before it is published, in ms
      // (session-only; persist it as "settings": {"urlSettleMs": N} in the
      // config note, and note that any reload of that note takes the session
      // value back to what the note says). Raise it if half-typed addresses
      // still reach the peers on a site that drives its URL from an input box;
      // lower it for snappier ordinary syncing. 0 disables the quiet period.
      urlSettle: (ms) => {
        if (typeof ms === "number" && isFinite(ms) && ms >= 0) SETTINGS.urlSettleMs = ms;
        console.info(LOG, "urlSettleMs:", SETTINGS.urlSettleMs);
        return SETTINGS.urlSettleMs;
      },
      // Every tunable at once — same session-only terms as urlSettle(). Pass an
      // object to set some, nothing to just read them back.
      tunables: (obj) => {
        if (obj && typeof obj === "object") applySettings({ ...SETTINGS, ...obj });
        return { ...SETTINGS };
      },

      // ===================================================================
      // VIVA-DIAG: diagnostic console commands. Every diagnostic command is
      // tagged with the marker "VIVA-DIAG" so they can be grep'd/found as a
      // group. They are kept (not removed) for re-confirming Vivaldi internals
      // after a browser update. Run them from the core (main.html) devtools
      // console, e.g. VivaSync.diagMakeStack(). Add the same VIVA-DIAG marker to
      // any future diagnostic command.
      // ===================================================================

      // VIVA-DIAG: create a throwaway tab, try to assign it a fake group by
      // writing vivExtData (merging to preserve ext_id), read back, report
      // whether it applied. Proves chrome.tabs.update({vivExtData}) is a no-op
      // in the UI context. Close the tab manually after.
      diagGroupSet: async () => {
        const winId = await ADAPTER.currentWindowId();
        const t = await chrome.tabs.create({ windowId: winId, url: "about:blank", active: false });
        await new Promise((r) => setTimeout(r, 400));
        const t2 = await chrome.tabs.get(t.id);
        console.log(LOG, "diagGroupSet: vivExtData after Vivaldi init:", t2.vivExtData);
        const existing = ADAPTER.parseTabExt(t2);
        const merged = Object.assign({}, existing, { group: 9999999999, fixedGroupTitle: "DIAGTEST" });
        console.log(LOG, "diagGroupSet: writing merged vivExtData:", JSON.stringify(merged));
        await chrome.tabs.update(t.id, { vivExtData: JSON.stringify(merged) });
        await new Promise((r) => setTimeout(r, 100));
        const t3 = await chrome.tabs.get(t.id);
        const parsed = ADAPTER.parseTabExt(t3);
        console.log(LOG, "diagGroupSet: after update:", t3.vivExtData);
        console.log(LOG, "diagGroupSet: group applied?", parsed.group === 9999999999 ? "YES" : ("NO — got " + parsed.group));
        return { tabId: t.id, applied: parsed.group === 9999999999, raw: t3.vivExtData };
      },
      // VIVA-DIAG: enumerate the API surface (vivaldi.*, chrome.tabs, webpack
      // globals) to locate the real methods for mutating tab extData / stacks.
      diagApis,
      diagNotes,
      diagUI,
      diagChurn,
      clearChurn: () => {
        openAttempts = {};
        churnBlocked.clear();
        KV.set("openAttempts", openAttempts);
        console.info(LOG, "churn counters cleared");
      },
      // VIVA-DIAG: write group via chrome.tabs.update, then read back at
      // increasing delays to see whether the write takes at all / is clobbered.
      diagClobber: async () => {
        const winId = await ADAPTER.currentWindowId();
        const t = await chrome.tabs.create({ windowId: winId, url: "about:blank", active: false });
        await new Promise((r) => setTimeout(r, 400));
        const base = ADAPTER.parseTabExt(await chrome.tabs.get(t.id));
        const merged = Object.assign({}, base, { group: "DIAG-" + crypto.randomUUID(), fixedGroupTitle: "DIAGTEST" });
        await chrome.tabs.update(t.id, { vivExtData: JSON.stringify(merged) });
        for (const ms of [0, 50, 200, 1000, 3000]) {
          await new Promise((r) => setTimeout(r, ms));
          const now = ADAPTER.parseTabExt(await chrome.tabs.get(t.id));
          console.log(LOG, "diagClobber +" + ms + "ms group=", now.group, "title=", now.fixedGroupTitle);
        }
        console.log(LOG, "diagClobber: if group is present at +0 then gone later => store clobber confirmed");
        return t.id;
      },
      // VIVA-DIAG: reach into Vivaldi's webpack registry, locate internal
      // extData/stack functions, and live-test updateExtData on a throwaway tab.
      diagWebpack: async () => {
        VIV.diagRequireShape();
        const found = VIV.find();
        console.log(LOG, "diagWebpack: modules scanned:", VIV.lastScanCount);
        for (const k of ["updateExtData", "createTabStack", "getNewGroupId", "setGroupProperties"]) {
          console.log(LOG, "  ", k, ":", typeof found[k] === "function" ? "FOUND" : "missing");
        }
        if (typeof found.updateExtData !== "function") {
          console.warn(LOG, "diagWebpack: updateExtData not found — cannot proceed via webpack");
          return found;
        }
        const winId = await ADAPTER.currentWindowId();
        const t = await chrome.tabs.create({ windowId: winId, url: "about:blank", active: false });
        await new Promise((r) => setTimeout(r, 400));
        const gid = crypto.randomUUID();
        console.log(LOG, "diagWebpack: calling updateExtData(", t.id, ", {group, fixedGroupTitle})");
        try {
          await found.updateExtData(t.id, { group: gid, fixedGroupTitle: "WPTEST" });
        } catch (e) {
          console.error(LOG, "diagWebpack: updateExtData threw:", e);
        }
        await new Promise((r) => setTimeout(r, 300));
        const after = ADAPTER.parseTabExt(await chrome.tabs.get(t.id));
        console.log(LOG, "diagWebpack: after updateExtData group=", after.group, "title=", after.fixedGroupTitle);
        console.log(LOG, "diagWebpack: stuck?", after.group === gid ? "YES — webpack path works" : "NO");
        return { found: Object.keys(found), applied: after.group === gid, tabId: t.id };
      },
      // VIVA-DIAG: create two throwaway tabs and stack them via the real
      // primitive (vivaldi.tabsPrivate.move + create-new-group), then name via
      // setGroupProperties. Confirms the stack path applyDesired uses.
      diagMakeStack: async () => {
        const winId = await ADAPTER.currentWindowId();
        const a = await chrome.tabs.create({ windowId: winId, url: "https://example.com/", active: false });
        const b = await chrome.tabs.create({ windowId: winId, url: "https://example.org/", active: false });
        await new Promise((r) => setTimeout(r, 500));
        console.log(LOG, "diagMakeStack: stacking tabs", a.id, b.id);
        let res;
        try {
          res = await vivaldi.tabsPrivate.move({
            tabIds: [a.id, b.id],
            target: a.id,
            tweaks: ["do-not-reparent", "create-new-group", "target-is-tab"],
            debug: "vivasync.diagMakeStack",
          });
        } catch (e) {
          console.error(LOG, "diagMakeStack: move threw:", e);
          return { error: String(e) };
        }
        console.log(LOG, "diagMakeStack: move result:", JSON.stringify(res));
        await new Promise((r) => setTimeout(r, 400));
        const ea = ADAPTER.parseTabExt(await chrome.tabs.get(a.id));
        const eb = ADAPTER.parseTabExt(await chrome.tabs.get(b.id));
        console.log(LOG, "diagMakeStack: a.group=", ea.group, "b.group=", eb.group,
          "stacked?", ea.group && ea.group === eb.group ? "YES" : "NO");
        const gid = ea.group || (res && res.group);
        const out = { moveResult: res, group: gid, stacked: !!(ea.group && ea.group === eb.group) };
        if (gid) {
          try {
            await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: gid, groupTitle: "DIAGSTACK" });
            await new Promise((r) => setTimeout(r, 300));
            const named = ADAPTER.parseTabExt(await chrome.tabs.get(a.id));
            console.log(LOG, "diagMakeStack: name now=", named.fixedGroupTitle);
            out.nameSet = named.fixedGroupTitle === "DIAGSTACK";
          } catch (e) {
            console.error(LOG, "diagMakeStack: setGroupProperties threw:", e);
          }
          // The COLOUR, through the same call with the other property. Vivaldi's
          // picker produces "color1".."color9" and "" for none; the two calls
          // are separate in bundle.js (setFixedStackTitle / setStackColor), so
          // this also answers whether setting one erases the other — which is
          // what the engine's "name, then colour" order in phase 2 assumes.
          try {
            await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: gid, groupColor: "color5" });
            await new Promise((r) => setTimeout(r, 300));
            const c1 = ADAPTER.parseTabExt(await chrome.tabs.get(a.id));
            const c2 = ADAPTER.parseTabExt(await chrome.tabs.get(b.id));
            out.colorSet = c1.groupColor === "color5";
            out.colorOnEveryMember = c1.groupColor === "color5" && c2.groupColor === "color5";
            out.nameKeptOnColor = c1.fixedGroupTitle === "DIAGSTACK";
            console.log(LOG, "diagMakeStack: colour now=", c1.groupColor,
              "(other member:", c2.groupColor + ")", "name still=", c1.fixedGroupTitle);
            await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: gid, groupColor: "" });
            await new Promise((r) => setTimeout(r, 300));
            const c3 = ADAPTER.parseTabExt(await chrome.tabs.get(a.id));
            out.colorCleared = !c3.groupColor;
            out.colorKeptGroup = c3.group === gid;
            console.log(LOG, "diagMakeStack: after clearing, colour=", c3.groupColor,
              "group=", c3.group);
          } catch (e) {
            console.error(LOG, "diagMakeStack: setGroupProperties(groupColor) threw:", e);
            out.colorError = String(e);
          }
        }
        return out;
      },
      // VIVA-DIAG: the inverse of diagMakeStack — confirm a tab can be taken OUT
      // of a stack. Vivaldi documents no "ungroup" primitive, so
      // ADAPTER.detachFromStack tries a reparenting move and then a group of
      // its own, verifying vivExtData after each. Run this after a Vivaldi
      // update: if it reports NO, top-level tabs will be swallowed by whatever
      // stack the active tab is in. Cleans up its throwaway tabs.
      diagDetach: async () => {
        const winId = await ADAPTER.currentWindowId();
        const wsId = await ADAPTER.activeWorkspaceId(winId);
        const a = await chrome.tabs.create({ windowId: winId, url: "https://example.com/", active: false });
        const b = await chrome.tabs.create({ windowId: winId, url: "https://example.org/", active: false });
        await new Promise((r) => setTimeout(r, 500));
        const gid = await ADAPTER.createStack([a.id, b.id]);
        await new Promise((r) => setTimeout(r, 400));
        const before = ADAPTER.parseTabExt(await chrome.tabs.get(b.id)).group;
        console.log(LOG, "diagDetach: stacked into", gid, "— b.group=", before);
        let out = false;
        try {
          out = await ADAPTER.detachFromStack(b.id, wsId, winId);
        } catch (e) {
          console.error(LOG, "diagDetach: threw:", e);
        }
        await new Promise((r) => setTimeout(r, 400));
        const after = ADAPTER.parseTabExt(await chrome.tabs.get(b.id)).group;
        console.log(LOG, "diagDetach: b.group before=", before, "after=", after,
          "detached?", out ? "YES" : "NO — new top-level tabs will be swallowed by stacks");
        try { await chrome.tabs.remove([a.id, b.id]); } catch (_e) {}
        return { group: gid, before, after, detached: !!out };
      },
      // VIVA-DIAG: what does this build honour about `pinned`? Four answers the
      // pin rails rest on, each read back through chrome.tabs.get:
      //   createPinned  — does chrome.tabs.create({pinned:true, vivExtData}) pin,
      //                   and does the tab land in the intended workspace?
      //   keptWorkspace — does a pinned tab keep its workspaceId at all? (If
      //                   pinned tabs are workspace-less, buildSnapshot cannot
      //                   see them.)
      //   updateUnpin / updatePin — does chrome.tabs.update({pinned}) change an
      //                   existing, unmoved tab? This is the call the pin phase
      //                   makes.
      //   lostByMove    — does pinToWorkspace strip a pin? (Why a pinned newborn
      //                   is never moved.)
      // Then the PINNED STACK questions, asked on a throwaway two-tab
      // stack, because the engine has to pin a stack one member at a time while
      // the user's own gesture pins it as a unit:
      //   memberPinKeptGroup — pin ONE member: is it still in the group?
      //   stackPinKeptGroup  — pin the other one too: still one stack?
      //   stackUnpinKeptGroup— unpin both again: still one stack?
      // A false in any of them is survivable — the pin phase reads the group
      // back and rebuilds it — but it is the difference between one update per
      // member and a full rebuild of the stack on every pin.
      // Anchors on a tab that belongs to a workspace rather than on
      // ADAPTER.currentWindowId(), which falls back to the last FOCUSED window
      // — the DevTools window while the console has focus, where nothing has a
      // workspace and every answer is about the wrong strip. Cleans up after
      // itself.
      diagPin: async () => {
        const everyTab = await chrome.tabs.query({});
        const inWs = everyTab.filter((t) => ADAPTER.parseTabExt(t).workspaceId != null);
        const anchor = inWs.find((t) => t.active) || inWs[0] || null;
        if (!anchor) {
          console.warn(LOG, "diagPin: no tab anywhere belongs to a workspace — open a workspace first.");
          return { error: "no workspace tab found" };
        }
        const winId = anchor.windowId;
        const wsId = ADAPTER.parseTabExt(anchor).workspaceId;
        const wsKey = ADAPTER.wsKey(wsId);
        const settle = () => new Promise((r) => setTimeout(r, 400));
        const read = async (id) => {
          const t = await chrome.tabs.get(id).catch(() => null);
          return t ? { pinned: !!t.pinned, ws: ADAPTER.wsKey(ADAPTER.parseTabExt(t).workspaceId), index: t.index } : null;
        };
        const out = { window: winId, workspace: wsKey };
        const a = await createTab(winId, "https://example.com/?vivasync-diagpin", true, wsId);
        await settle();
        let r = await read(a.id);
        out.createPinned = !!(r && r.pinned);
        out.keptWorkspace = !!(r && r.ws === wsKey);
        out.landed = r;
        // Whether a PINNED newborn is dropped into the anchor's stack the way an
        // unpinned one is. Only meaningful when the anchor sits in a stack
        // (activeInStack) — run it from a stack member to learn anything. It
        // has been seen to, which is why applyDesired detaches it.
        out.activeInStack = ADAPTER.stackIdOf(ADAPTER.parseTabExt(anchor)) != null;
        out.joinedStack = ADAPTER.stackIdOf(ADAPTER.parseTabExt(await chrome.tabs.get(a.id).catch(() => null))) != null;
        await chrome.tabs.update(a.id, { pinned: false }).catch((e) => { out.updateUnpinError = e && e.message; });
        await settle();
        r = await read(a.id);
        out.updateUnpin = !!(r && !r.pinned);
        await chrome.tabs.update(a.id, { pinned: true }).catch((e) => { out.updatePinError = e && e.message; });
        await settle();
        r = await read(a.id);
        out.updatePin = !!(r && r.pinned);
        out.stillInWorkspace = !!(r && r.ws === wsKey);
        try { await ADAPTER.pinToWorkspace(a.id, wsId, winId); } catch (e) { out.moveError = e && e.message; }
        await settle();
        r = await read(a.id);
        out.lostByMove = !!(r && !r.pinned);
        // --- a stack, pinned one member at a time -----------------------------
        const mk = async (u) => {
          const t = await createTab(winId, u, false);
          try { await ADAPTER.pinToWorkspace(t.id, wsId, winId); } catch (_e) {}
          await ADAPTER.detachFromStack(t.id, wsId, winId);
          return t.id;
        };
        const b = await mk("https://example.org/?vivasync-diagpin-b");
        const c = await mk("https://example.net/?vivasync-diagpin-c");
        await settle();
        const gid = await ADAPTER.createStack([b, c]);
        out.stack = !!(await ADAPTER.awaitStack([b, c], null));
        const gidOf = async (id) =>
          ADAPTER.stackIdOf(ADAPTER.parseTabExt(await chrome.tabs.get(id).catch(() => null)));
        const same = async () => {
          const gb = await gidOf(b), gc = await gidOf(c);
          return gb != null && gb === gc && (gid ? gb === gid : true);
        };
        await chrome.tabs.update(b, { pinned: true }).catch((e) => { out.memberPinError = e && e.message; });
        await settle();
        const rb = await read(b);
        out.memberPinned = !!(rb && rb.pinned);
        out.memberPinKeptGroup = await same();
        await chrome.tabs.update(c, { pinned: true }).catch((e) => { out.memberPinError = e && e.message; });
        await settle();
        out.stackPinKeptGroup = await same();
        await chrome.tabs.update(b, { pinned: false }).catch(() => {});
        await chrome.tabs.update(c, { pinned: false }).catch(() => {});
        await settle();
        out.stackUnpinKeptGroup = await same();
        try { await chrome.tabs.remove([a.id, b, c]); } catch (_e) {}
        console.log(LOG, "diagPin:", JSON.stringify(out));
        return out;
      },
      // VIVA-DIAG: what this build does with an INDEX move — the order phase's
      // one primitive (ADAPTER.moveToIndex). Three throwaway tabs a, b, c go
      // into the anchor's workspace, b+c become a stack, then: a is moved to sit
      // right AFTER the stack, then right BEFORE it, then the whole stack is
      // moved in front of a. Reports where each landed (an index move that is
      // ignored, or that parks at the end of the workspace, shows up here as
      // `landed:false`), whether a top-level tab at a stack's EDGE was absorbed
      // into it — a hazard the order phase is designed never to trigger but
      // cannot rule out offline — and whether a run
      // moved as one call kept its group and its contiguity. Anchors on a tab
      // that belongs to a workspace, like diagPin.
      diagOrder: async () => {
        const everyTab = await chrome.tabs.query({});
        const inWs = everyTab.filter((t) => ADAPTER.parseTabExt(t).workspaceId != null);
        const anchor = inWs.find((t) => t.active) || inWs[0] || null;
        if (!anchor) {
          console.warn(LOG, "diagOrder: no tab anywhere belongs to a workspace — open a workspace first.");
          return { error: "no workspace tab found" };
        }
        const winId = anchor.windowId;
        const wsId = ADAPTER.parseTabExt(anchor).workspaceId;
        const wsKey = ADAPTER.wsKey(wsId);
        const settle = () => new Promise((r) => setTimeout(r, 400));
        const strip = async () => (await chrome.tabs.query({ windowId: winId })).sort((x, y) => x.index - y.index);
        const gidOf = async (id) => ADAPTER.stackIdOf(ADAPTER.parseTabExt(await chrome.tabs.get(id).catch(() => null)));
        const wsOf = async (id) => ADAPTER.wsKey(ADAPTER.parseTabExt(await chrome.tabs.get(id).catch(() => null)).workspaceId);
        const out = { window: winId, workspace: wsKey };
        const mk = async (u) => {
          const t = await createTab(winId, u, false);
          try { await ADAPTER.pinToWorkspace(t.id, wsId, winId); } catch (_e) {}
          await ADAPTER.detachFromStack(t.id, wsId, winId);
          return t.id;
        };
        const a = await mk("https://example.com/?vivasync-diagorder-a");
        const b = await mk("https://example.org/?vivasync-diagorder-b");
        const c = await mk("https://example.net/?vivasync-diagorder-c");
        await settle();
        const gid = await ADAPTER.createStack([b, c]);
        out.stack = !!(await ADAPTER.awaitStack([b, c], null));
        // Target in the post-removal frame, exactly as applyOrder computes it.
        const targetFor = async (movers, anchorId, after) => {
          const ids = (await strip()).map((t) => t.id).filter((id) => !movers.includes(id));
          return ids.indexOf(anchorId) + (after ? 1 : 0);
        };
        let target = await targetFor([a], c, true);
        out.afterLanded = await ADAPTER.moveToIndex([a], target, winId, wsId);
        await settle();
        out.afterAbsorbed = (await gidOf(a)) != null && (await gidOf(a)) === (await gidOf(b));
        target = await targetFor([a], b, false);
        out.beforeLanded = await ADAPTER.moveToIndex([a], target, winId, wsId);
        await settle();
        out.beforeAbsorbed = (await gidOf(a)) != null && (await gidOf(a)) === (await gidOf(b));
        out.keptWorkspace = (await wsOf(a)) === wsKey;
        // The whole run in front of a: b and c in their current strip order.
        const run = (await strip()).filter((t) => t.id === b || t.id === c).map((t) => t.id);
        target = await targetFor(run, a, false);
        out.runLanded = await ADAPTER.moveToIndex(run, target, winId, wsId);
        await settle();
        const gb = await gidOf(b), gc = await gidOf(c);
        out.runKeptGroup = gb != null && gb === gc && (gid ? gb === gid : true);
        const s = (await strip()).map((t) => t.id);
        out.runContiguous = Math.abs(s.indexOf(b) - s.indexOf(c)) === 1;
        out.runBeforeA = Math.max(s.indexOf(b), s.indexOf(c)) < s.indexOf(a);
        // Reorder one member INSIDE its own run: the in-stack order phase's one
        // move. The target lies between two members of the same group, so
        // nothing else can claim it — what is being measured is whether
        // "do-not-reparent" keeps it in the group at all.
        const runNow = (await strip()).filter((t) => t.id === b || t.id === c).map((t) => t.id);
        const firstAt = (await strip()).findIndex((t) => t.id === runNow[0]);
        out.memberReorderLanded = await ADAPTER.moveToIndex([runNow[1]], firstAt, winId, wsId);
        await settle();
        out.memberReorderKeptGroup = (await gidOf(runNow[1])) === (await gidOf(runNow[0])) &&
          (await gidOf(runNow[1])) != null;
        const s2 = (await strip()).map((t) => t.id);
        out.memberReorderSwapped = s2.indexOf(runNow[1]) < s2.indexOf(runNow[0]);
        try { await chrome.tabs.remove([a, b, c]); } catch (_e) {}
        console.log(LOG, "diagOrder:", JSON.stringify(out));
        return out;
      },
      // VIVA-DIAG: confirm a tab can be added to an EXISTING stack. This is the
      // primitive behind "a peer opened a tab inside a stack": when it fails,
      // the new member is published as a plain tab, which makes every peer
      // un-stack it. Re-run it after a Vivaldi update. Reports whether the join landed on its own AND, if not, whether
      // the createStack rebuild that applyDesired falls back to would have.
      diagAddToStack: async () => {
        const winId = await ADAPTER.currentWindowId();
        const wsId = await ADAPTER.activeWorkspaceId(winId);
        const mk = (u) => chrome.tabs.create({ windowId: winId, url: u, active: false });
        const a = await mk("https://example.com/");
        const b = await mk("https://example.org/");
        const c = await mk("https://example.net/");
        await new Promise((r) => setTimeout(r, 500));
        const gid = await ADAPTER.createStack([a.id, b.id]);
        await ADAPTER.awaitStack([a.id, b.id], null);
        try {
          await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: gid, groupTitle: "DIAGADD" });
        } catch (e) {
          console.error(LOG, "diagAddToStack: setGroupProperties threw:", e);
        }
        // Run this from a stack and all three throwaways are swallowed by it —
        // c would then "already be in the stack" and the test would report a
        // success it never performed. Put c outside first.
        await ADAPTER.detachFromStack(c.id, wsId, winId);
        const before = ADAPTER.parseTabExt(await chrome.tabs.get(c.id)).group || null;
        if (before && before === gid) {
          console.warn(LOG, "diagAddToStack: could not get the third tab out of the stack —",
            "the result below proves nothing. Run it from a top-level tab.");
        }
        let added = false;
        try {
          await ADAPTER.addToStack(c.id, gid);
          added = !!(await ADAPTER.awaitStack([a.id, b.id, c.id], null));
        } catch (e) {
          console.error(LOG, "diagAddToStack: addToStack threw:", e);
        }
        const afterAdd = ADAPTER.parseTabExt(await chrome.tabs.get(c.id)).group || null;
        // Whether the fallback would have saved us, measured only if needed.
        let rebuilt = null;
        if (!added) {
          try {
            await ADAPTER.createStack([a.id, b.id, c.id]);
            rebuilt = !!(await ADAPTER.awaitStack([a.id, b.id, c.id], null));
          } catch (e) {
            console.error(LOG, "diagAddToStack: rebuild threw:", e);
          }
        }
        const nameKept = ADAPTER.parseTabExt(await chrome.tabs.get(a.id)).fixedGroupTitle || null;
        console.log(LOG, "diagAddToStack: stack", gid, "| c.group before=", before,
          "after=", afterAdd, "| addToStack landed?", added ? "YES" : "NO",
          added ? "" : "— fallback rebuild " + (rebuilt ? "WORKED" : "ALSO FAILED"),
          "| stack name after=", nameKept);
        // One at a time: a bulk remove is rejected whole when one id is stale,
        // which would leave all three throwaway tabs behind.
        for (const t of [a, b, c]) {
          try { await chrome.tabs.remove(t.id); } catch (e) {
            console.warn(LOG, "diagAddToStack: could not close throwaway tab", t.id, e && e.message);
          }
        }
        return { group: gid, before, after: afterAdd, added, rebuilt, name: nameKept };
      },
    };

    if (syncedWorkspaces.length === 0) {
      console.warn(
        LOG,
        `no workspaces configured; nothing will sync. Use the ⇄ button, or edit the ` +
          `"${FOLDER}/${CONFIG_TITLE}" note (each entry is {"name":..,"peers":[..]}) ` +
          `and run VivaSync.reloadConfig().`
      );
    }

    // The button lives in window.html, which React re-renders and which new
    // windows create from scratch — so re-assert it on a timer.
    ensureToggleButton();
    setInterval(ensureToggleButton, 3000);

    wireEvents();

    // Initial pass: only reconcile + write the currently ACTIVE workspace. Other
    // synced workspaces are not yet materialized (Vivaldi lazy-loads them), so
    // we must not write them until the user opens them — see R2.4 / writeChanged.
    await checkActiveWorkspace();
  }

  // The UI bundle may finish wiring chrome.* a touch after our script runs.
  if (document.readyState === "complete") {
    setTimeout(init, 1500);
  } else {
    window.addEventListener("load", () => setTimeout(init, 1500));
  }
})();
