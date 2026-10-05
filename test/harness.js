// Test harness: fake the Vivaldi/Chromium UI context so mod/vivasync-mod.js can be
// loaded and driven in plain Node.
//
// The mod only ever touches a small, well-defined surface — chrome.tabs,
// chrome.windows, chrome.extension, chrome.storage, vivaldi.notes,
// vivaldi.prefs, vivaldi.sync, vivaldi.tabsPrivate — so the whole browser can
// be replaced with the in-memory doubles below.
//
// IMPORTANT: these doubles are only as trustworthy as our model of Vivaldi. A
// stub that quietly diverges makes tests pass while the real path is broken
// (this happened: tabs.remove ignored array arguments, so every delete in the
// reconcile engine silently did nothing while the suite stayed green).
// 00-harness-selftest.js exists to catch exactly that class of drift — extend it
// whenever you extend a stub.

const fs = require("fs");
const nodePath = require("path");

const MOD_PATH = nodePath.join(__dirname, "..", "mod", "vivasync-mod.js");

// Vivaldi workspace ids are timestamp-valued floats.
const WS = { WORK: 1717425015828.0, PERSONAL: 1783536779848.0, LOCAL: 1782868462499.0 };

// The tweak vocabulary tabsPrivate.move accepts, verbatim from the TypeError a
// real Vivaldi 8.1 throws when handed anything else. Anything not on this list
// makes the call fail outright — see the validation in tabsPrivate.move below.
const VALID_TWEAKS = [
  "above", "below", "collapsed-above", "create-group", "create-new-group",
  "detached", "do-not-reparent", "expand-related", "into", "on",
  "strip-accordion", "strip-down", "strip-no-stacks", "strip-up",
  "target-is-tab", "ungroup", "untile",
];

function createEnv(opts = {}) {
  const deviceName = opts.deviceName || "boxA";
  const workspaces = opts.workspaces || [
    { id: WS.WORK, name: "Work" },
    { id: WS.PERSONAL, name: "Personal" },
  ];
  // Set by the caller to place a pre-existing tree (e.g. a trashed folder).
  const extraRootChildren = opts.rootChildren || [];
  // How long the browser takes to write a grouping change back into the tabs'
  // vivExtData. Non-zero by default: a zero here quietly hides a whole class of
  // publish-before-it-landed bug (see tabsPrivate.move below).
  const groupLatencyMs = opts.groupLatencyMs != null ? opts.groupLatencyMs : 120;
  // Which grouping primitives this build actually honours. Both default to
  // working; a test flips one off with env.breakAddToStack()/env.breakGrouping()
  // to model a build where the tweak is silently ignored. That is not a
  // hypothetical: ADAPTER.addToStack ("on"+"create-group") was broken outright
  // for a whole release — see VivaSync.diagAddToStack and
  // test/fixtures/vivaldi-api.json.
  let canAddToStack = opts.brokenAddToStack ? false : true;
  let canCreateStack = true;
  // Whether this modelled build honours `pinned` at all. Off models a build
  // where neither chrome.tabs.create({pinned}) nor chrome.tabs.update({pinned})
  // does anything: the engine must then leave the flag alone AND must not turn
  // the refusal into news of its own (invariant 2 — the write after an apply is
  // an acknowledgement under the peer's origin). env.setPinSupport() flips it.
  let canPin = opts.brokenPinning ? false : true;
  // Whether pinning a tab through chrome.tabs.update knocks it out of its
  // stack. False here (a pinned stack stays a stack) is the assumption; the
  // engine verifies it at run time, and env.breakGroupOnPin() runs the other
  // build so the rebuild path is not merely asserted about.
  let breakGroupOnPin = false;
  // How long a CREATED tab stays `status: "loading"`. Non-zero by default,
  // because a newborn really is loading, and a zero here hides a whole class of
  // bug: an order phase that matched units by URL and skipped every `volatile`
  // one would never place a tab the apply had just opened, and the suite would
  // stay green. env.setLoadLatency() holds a newborn
  // loading for longer (or, with 0, makes it complete at once).
  let loadLatencyMs = opts.loadLatencyMs != null ? opts.loadLatencyMs : 60;

  let nextId = 100;
  const newId = () => String(nextId++);

  // ---- notes tree ----------------------------------------------------------
  // Mirrors the real on-disk shape: a single root folder whose children include
  // a node of type "trash". API field names are title/content (the on-disk file
  // calls them subject/content).
  const root = { id: "1", title: "Notes", type: "folder", parentId: null, children: [] };
  root.children.push({ id: "2", title: "Trash", type: "trash", parentId: "1", children: [] });
  for (const c of extraRootChildren) root.children.push(c);
  const tree = [root];

  const findNode = (id, n = { children: tree }) => {
    for (const c of n.children || []) {
      if (String(c.id) === String(id)) return c;
      const r = findNode(id, c);
      if (r) return r;
    }
    return null;
  };

  // onChanged/onCreated/onMoved/onRemoved are the NOTES events; tabActivated is
  // chrome.tabs.onActivated, which drives workspace-switch detection — the mod
  // has no other way to learn the user changed workspace, so a test that wants
  // to model a switch fires it (see env.switchWorkspace).
  const listeners = {
    onChanged: [], onCreated: [], onMoved: [], onRemoved: [], tabActivated: [], tabUpdated: [], tabMoved: [],
  };
  const fire = (which, ...args) => (listeners[which] || []).forEach((f) => f(...args));

  // Real getTree() does not reliably populate `content` — absent on some
  // builds, "" on others — while get() always does. Ids listed here come back
  // from getTree with content "" so a test can prove the mod falls back.
  const hiddenContent = new Set();
  const notes = {
    getTree: (cb) => {
      const copy = JSON.parse(JSON.stringify(tree));
      const walk = (n) => {
        if (hiddenContent.has(String(n.id))) n.content = "";
        (n.children || []).forEach(walk);
      };
      copy.forEach(walk);
      cb(copy);
    },
    get: (id, cb) => {
      const n = findNode(id);
      cb(n ? [n] : []);
    },
    create: (props, cb) => {
      const parentId = props.parentId || root.id;
      const n = { id: newId(), children: [], content: "", url: "", ...props, parentId };
      const parent = findNode(parentId) || root;
      (parent.children = parent.children || []).push(n);
      // Real Vivaldi fires onCreated around the same time the callback runs; the
      // mod must tolerate the event arriving BEFORE it learns the new note's id.
      fire("onCreated", n.id, n);
      cb(n);
    },
    update: (id, changes, cb) => {
      const n = findNode(id);
      if (!n) {
        // Like Chrome: lastError is set only for the duration of the callback.
        // Leaving it set made the NEXT, unrelated call fail too.
        global.chrome.runtime.lastError = { message: "no such note" };
        try { return cb(null); } finally { global.chrome.runtime.lastError = null; }
      }
      Object.assign(n, changes);
      fire("onChanged", id, changes);
      cb(n);
    },
    remove: (id, cb) => {
      const strip = (n) => {
        n.children = (n.children || []).filter((c) => String(c.id) !== String(id));
        n.children.forEach(strip);
      };
      strip({ children: tree });
      fire("onRemoved", id, {});
      cb(true);
    },
    onChanged: { addListener: (f) => listeners.onChanged.push(f) },
    onCreated: { addListener: (f) => listeners.onCreated.push(f) },
    onMoved: { addListener: (f) => listeners.onMoved.push(f) },
    onRemoved: { addListener: (f) => listeners.onRemoved.push(f) },
  };

  // ---- tabs ----------------------------------------------------------------
  const ext = (o) => JSON.stringify(o);
  let TABS = (opts.tabs || [
    { id: 11, url: "https://a.example/", title: "A", ws: WS.WORK, active: true },
    { id: 12, url: "https://b.example/", title: "B", ws: WS.WORK },
  ]).map((t, i) => ({
    id: t.id,
    windowId: 1,
    index: t.index != null ? t.index : i,
    active: !!t.active,
    pinned: !!t.pinned,
    url: t.url,
    title: t.title || t.url,
    // chrome.tabs.Tab.status: "unloaded" | "loading" | "complete". Hibernated
    // and lazily-restored tabs report "unloaded" — see isLoadingTab.
    status: t.status || "complete",
    vivExtData: ext(
      Object.assign({ workspaceId: t.ws }, t.group
        ? { group: t.group, fixedGroupTitle: t.stackName, groupColor: t.stackColor }
        : {})
    ),
  }));

  // ---- tab stack model -----------------------------------------------------
  // A tab's stack membership lives in vivExtData.group, its display name in
  // fixedGroupTitle and its colour in groupColor (both set through
  // setGroupProperties, one property per call). The mod cannot write those
  // fields itself (chrome.tabs.update({vivExtData}) is a no-op there), so every
  // grouping op goes through vivaldi.tabsPrivate and the BROWSER assigns the
  // group id. The doubles reproduce that, plus the two emergent behaviours the
  // reconcile engine has to survive:
  //   * a new tab joins the ACTIVE tab's stack, not just the active workspace
  //     (the whole phase-1 / phase-2 split in applyDesired exists for this)
  //   * a stack that drops below two members is DISSOLVED and the survivor
  //     becomes an ordinary top-level tab
  // Both are marked `unverified` in fixtures/vivaldi-api.json: they are the
  // behaviour the mod's own comments assert, not something captured from a
  // running build.
  const extOf = (t) => {
    try { return JSON.parse(t.vivExtData || "{}"); } catch (_e) { return {}; }
  };
  const setExt = (t, patch) => {
    const e = extOf(t);
    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined || patch[k] === null) delete e[k];
      else e[k] = patch[k];
    }
    t.vivExtData = ext(e);
  };
  const groupOf = (t) => {
    const g = extOf(t).group;
    return g == null ? null : String(g);
  };
  const reindex = () => TABS.forEach((t, i) => { t.index = i; });
  // Stack members are contiguous in the strip: park `t` after the last member.
  const parkWithGroup = (t, gid) => {
    const i = TABS.indexOf(t);
    if (i >= 0) TABS.splice(i, 1);
    let last = -1;
    TABS.forEach((o, j) => { if (groupOf(o) === gid) last = j; });
    TABS.splice(last >= 0 ? last + 1 : TABS.length, 0, t);
    reindex();
  };
  // ...and an ungrouped tab sits at the end of its own workspace's region, not
  // at the window end (which is a different workspace's territory).
  const parkInWorkspace = (t, wsId) => {
    const i = TABS.indexOf(t);
    if (i >= 0) TABS.splice(i, 1);
    let last = -1;
    TABS.forEach((o, j) => {
      if (String(Number(extOf(o).workspaceId)) === String(Number(wsId))) last = j;
    });
    TABS.splice(last >= 0 ? last + 1 : TABS.length, 0, t);
    reindex();
  };
  // A POSITIONAL move, chrome.tabs.move semantics (what bundle.js's moveToIndex
  // passes): the movers are taken out of the strip, `index` is where the first
  // of them goes back in, they keep their relative order, and every moved tab
  // announces itself on chrome.tabs.onMoved. Membership is left alone — the
  // engine only ever moves whole runs or tabs that are top-level, to
  // boundaries between units. Whether a real build absorbs a top-level tab
  // that lands at a stack's EDGE is not modelled (unverified; VivaSync.diagOrder()).
  const placeAt = (moving, index, wsId) => {
    const set = new Set(moving);
    const rest = TABS.filter((t) => !set.has(t));
    const at = Math.max(0, Math.min(index, rest.length));
    const from = moving.map((t) => t.index);
    TABS.length = 0;
    TABS.push(...rest.slice(0, at), ...moving, ...rest.slice(at));
    if (wsId != null) for (const t of moving) setExt(t, { workspaceId: wsId });
    reindex();
    moving.forEach((t, i) => fire("tabMoved", t.id, { windowId: 1, fromIndex: from[i], toIndex: t.index }));
  };
  const dissolveSingletons = () => {
    const count = new Map();
    for (const t of TABS) {
      const g = groupOf(t);
      if (g) count.set(g, (count.get(g) || 0) + 1);
    }
    for (const t of TABS) {
      const g = groupOf(t);
      if (g && count.get(g) < 2) setExt(t, { group: null, fixedGroupTitle: null, groupColor: null });
    }
  };

  // Ordered log of tab mutations, so a test can assert create/delete ORDERING
  // (the reconcile engine must create before it deletes).
  const OPS = [];

  const tabsApi = {
    query: (q, cb) => {
      let r = TABS.slice();
      if (q.active) r = r.filter((t) => t.active);
      if (q.windowId != null) r = r.filter((t) => t.windowId === q.windowId);
      cb(r);
    },
    get: (id, cb) => cb(TABS.find((t) => t.id === id)),
    create: (p, cb) => {
      // Real behaviour: a new tab joins the ACTIVE workspace -- and the ACTIVE
      // TAB'S STACK when that tab is in one. The second half is why the engine
      // creates every tab plain first and only groups in a second phase.
      // Create-time `vivExtData.workspaceId` IS honoured (the update-time
      // write is the no-op — see update below); the engine relies on it for a
      // pinned newborn. A PINNED newborn joins the active tab's stack exactly
      // like an unpinned one (a pinned tab arriving while the user sits in a
      // stack becomes that stack's first member) — a double that kept pinned
      // newborns out of stacks would pass the suite over that bug.
      const activeTab = TABS.find((t) => t.active);
      let wantWs = null;
      try { wantWs = p.vivExtData ? JSON.parse(p.vivExtData).workspaceId : null; } catch (_e) { wantWs = null; }
      const activeWs = wantWs != null ? wantWs : (activeTab ? extOf(activeTab).workspaceId : null);
      const pinned = canPin && !!p.pinned;
      const joinGid = activeTab ? groupOf(activeTab) : null;
      const t = {
        id: nextId++, windowId: 1, index: TABS.length, active: false, pinned,
        // A NEWBORN IS LOADING. `isLoadingTab` is true for it, so it is
        // `volatile` in the engine's live view — never closed, never published
        // until it settles, but it must still be MOVED into place by the order
        // phase. Modelling it complete would let an order phase that silently
        // skipped every tab it had just created pass the suite.
        url: p.url, title: p.url, status: loadLatencyMs > 0 ? "loading" : "complete",
        vivExtData: ext(
          Object.assign({ workspaceId: activeWs }, joinGid
            ? { group: joinGid, fixedGroupTitle: extOf(activeTab).fixedGroupTitle,
                groupColor: extOf(activeTab).groupColor }
            : {})
        ),
      };
      TABS.push(t);
      if (joinGid) parkWithGroup(t, joinGid); else reindex();
      OPS.push({ op: "create", url: p.url, ws: activeWs, group: joinGid, pinned });
      if (loadLatencyMs > 0) {
        setTimeout(() => {
          if (!TABS.includes(t)) return; // closed while loading
          t.status = "complete";
          // status only: the engine's onUpdated starts a URL quiet period from
          // `info.url`, and a load completing is not a new address.
          fire("tabUpdated", t.id, { status: "complete" }, t);
        }, loadLatencyMs);
      }
      cb(t);
    },
    // NOTE: the real API accepts a single id OR an array. Honouring the array
    // form matters — the engine always removes in bulk.
    //
    // It also REJECTS the call when an id is not a live tab ("No such tab - N")
    // rather than skipping it, and a bulk call takes the whole list down with
    // it. A tab can go stale between being planned for deletion and being
    // closed — dissolving a stack is asynchronous — so the engine has to
    // survive that or a peer's deletions silently stop propagating. Modelled
    // pessimistically (validate everything first, remove nothing on failure):
    // a double should make the engine prove it is robust, not assume the
    // friendliest possible browser.
    remove: (id, cb) => {
      const ids = (Array.isArray(id) ? id : [id]).map(Number);
      const missing = ids.find((i) => !TABS.some((t) => t.id === i));
      if (missing != null) throw new Error("No such tab - " + missing);
      const wasActive = TABS.find((t) => t.active && ids.includes(t.id));
      const activeWs = wasActive ? extOf(wasActive).workspaceId : null;
      const idx = wasActive ? TABS.indexOf(wasActive) : -1;
      OPS.push({ op: "remove", ids });
      TABS = TABS.filter((t) => !ids.includes(t.id));
      dissolveSingletons(); // closing the second-to-last member unstacks the rest
      reindex();
      // Closing the ACTIVE tab activates another one — the browser is never
      // left with no active tab. Vivaldi prefers a tab in the same workspace;
      // only once that workspace is empty does it fall back to a neighbouring
      // workspace's tab, and since the mod derives the active workspace FROM the
      // active tab, that is the exact hazard reconcile invariant 6 guards.
      if (wasActive && TABS.length) {
        const key = String(Number(activeWs));
        const sameWs = TABS.filter((t) => String(Number(extOf(t).workspaceId)) === key);
        const pool = sameWs.length ? sameWs : TABS;
        const next = pool.find((t) => t.index >= idx) || pool[pool.length - 1];
        for (const t of TABS) t.active = false;
        next.active = true;
      }
      cb && cb();
    },
    // Real: applies the given properties to the tab. Two of them reach this
    // double and they behave differently, which is the point of modelling it
    // rather than stubbing it out:
    //   - `pinned` is plain chrome.tabs and IS honoured (unless canPin is off).
    //     It is the only attribute the engine changes on a tab in place (its
    //     pin phase); while this was a no-op stub, a pin arriving from a peer
    //     could be "applied" in a green test and do nothing in a browser.
    //   - `vivExtData` is a NO-OP from the UI context — confirmed against a
    //     real build, and the whole reason ADAPTER groups through
    //     tabsPrivate.move. Ignored here so no test can pass by leaning on it.
    // A stale id is REJECTED, as it is for remove(). NOT modelled: the real
    // browser moves a pinned tab to the front of the strip; the engine never
    // moves a tab by index, so the difference is invisible to it.
    // Pinning a tab leaves its GROUP alone here, which is what makes a pinned
    // stack expressible at all (Vivaldi pins a stack as a unit and it stays a
    // stack in the pinned strip). Whether a real build keeps the group when the
    // members are pinned ONE AT A TIME — the only way the API offers — is
    // unverified: VivaSync.diagPin() reports it as memberPinKeptGroup, and the
    // engine reads the group back and rebuilds it if it came apart, which is
    // the path test/15-pinned.js exercises with env.breakGroupOnPin().
    update: (id, p, cb) => {
      const t = TABS.find((x) => x.id === id);
      if (!t) throw new Error("No such tab - " + id);
      if (p && p.pinned != null && canPin && !!t.pinned !== !!p.pinned) {
        t.pinned = !!p.pinned;
        OPS.push({ op: "pin", id: t.id, pinned: t.pinned });
        // Model a build on which pinning a member drops it out of the group.
        if (breakGroupOnPin && groupOf(t)) {
          setExt(t, { group: null, fixedGroupTitle: null, groupColor: null });
          reindex();
        }
        fire("tabUpdated", t.id, { pinned: t.pinned }, t);
      }
      return cb && cb(t);
    },
    onCreated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    // Real: fires (tabId, {windowId, fromIndex, toIndex}) for every tab that
    // changes index. The mod's write path hangs off it — a user dragging a tab
    // is a change worth publishing — so a double that never fired
    // would leave the order tests asserting on nothing. Driven by positional
    // tabsPrivate.move calls and by env.moveTab / env.moveTabs.
    onMoved: { addListener: (f) => listeners.tabMoved.push(f) },
    onAttached: { addListener: () => {} },
    onDetached: { addListener: () => {} },
    onActivated: { addListener: (f) => listeners.tabActivated.push(f) },
    // Real: fires (tabId, changeInfo, tab) whenever a tab's url/title/status/
    // pinned state changes. The mod starts a tab's URL quiet period from the
    // `url` key here (URL_SETTLE_MS), so a double that never fires would make
    // every settle-window test vacuously green. Driven by env.navigate().
    onUpdated: { addListener: (f) => listeners.tabUpdated.push(f) },
  };

  const activeWorkspaceId = () => {
    const a = TABS.find((t) => t.active);
    return a ? JSON.parse(a.vivExtData).workspaceId : null;
  };

  // ---- globals -------------------------------------------------------------
  global.crypto = require("crypto").webcrypto;
  global.localStorage = (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  })();

  global.chrome = {
    runtime: { lastError: null },
    extension: { getViews: () => [] },
    storage: { local: { get: (k, cb) => cb({}), set: () => {} } },
    windows: {
      onFocusChanged: { addListener: () => {} },
      getCurrent: (cb) => cb({ id: 1 }),
      getLastFocused: (cb) => cb({ id: 1 }),
      get: (id, cb) => cb({ id }),
    },
    tabs: tabsApi,
  };
  // Vivaldi's extension bindings return a promise when no callback is passed.
  for (const ns of ["tabs", "windows"]) {
    for (const k of Object.keys(global.chrome[ns])) {
      const orig = global.chrome[ns][k];
      if (typeof orig !== "function") continue;
      global.chrome[ns][k] = (...args) =>
        typeof args[args.length - 1] === "function"
          ? orig(...args)
          : new Promise((res) => orig(...args, res));
    }
  }

  global.vivaldi = {
    notes,
    prefs: {
      get: (path, cb) => {
        if (path === "vivaldi.workspaces.list") return cb(workspaces);
        // The wrapper-object trap: on some builds prefs.get returns a descriptor
        // rather than the value. String()-ing it yields an "[object Object]"
        // device name, so the default here is the hostile shape.
        if (path === "vivaldi.sync.session_name") {
          return cb(opts.sessionName !== undefined ? opts.sessionName : { defaultValue: "" });
        }
        cb(null);
      },
    },
    sync: { getDefaultSessionName: (cb) => cb(deviceName) },
    tabsPrivate: {
      // ADAPTER.createStack / addToStack / pinToWorkspace all funnel through
      // move(); the tweak list is what distinguishes them (see ADAPTER).
      move: (o, cb) => {
        const ids = (o.tabIds || []).map(Number);
        const moving = ids.map((i) => TABS.find((t) => t.id === i)).filter(Boolean);
        const tweaks = o.tweaks || [];
        // The real API VALIDATES the tweak vocabulary and throws on anything
        // outside it. A double that accepted whatever it was handed would let
        // an invented tweak name through — every call throwing in the browser
        // while the suite stays green. Model the rejection, not just the
        // accepted ops.
        const bad = tweaks.filter((t) => !VALID_TWEAKS.includes(t));
        if (bad.length) {
          throw new TypeError(
            "Error in invocation of tabsPrivate.move(object moveProperties, optional " +
            "function callback): Error at parameter 'moveProperties': Error at property " +
            "'tweaks': Error at index " + tweaks.indexOf(bad[0]) + ": Value must be one of " +
            VALID_TWEAKS.join(", ") + "."
          );
        }
        // The real API tells a TAB target from an INDEX by the "target-is-tab"
        // tweak (bundle.js createTabStack passes it; its moveToIndex does not),
        // a GROUP target is the group's ext id (Vivaldi's "drop a tab onto a
        // stack"), and any other non-negative number is a strip index. A
        // double that took every numeric target for a tab id would stack an
        // index move onto whichever tab happened to have that id.
        const target = tweaks.includes("target-is-tab") ? TABS.find((t) => t.id === Number(o.target)) : null;
        const targetGroup = TABS.some((t) => groupOf(t) === String(o.target))
          ? String(o.target) : null;
        const targetIndex = !target && !targetGroup && typeof o.target === "number" && o.target >= 0
          ? o.target : null;
        let group = null;
        const wantsNew = tweaks.includes("create-new-group") && canCreateStack;
        const wantsJoin =
          tweaks.includes("create-group") && tweaks.includes("on") && canAddToStack;
        if (wantsNew) group = "grp-" + newId();
        else if (wantsJoin) group = targetGroup || (target ? groupOf(target) : null);
        // GROUPING IS NOT VISIBLE IMMEDIATELY. The backend answers with the new
        // group id straight away, but the tabs' vivExtData catches up a moment
        // later — which is why diagMakeStack/diagDetach sleep before reading it
        // back. Anything that snapshots the workspace inside that window sees
        // plain tabs, publishes "no stack", and the peer dutifully takes the
        // stack apart. Model the delay so the engine has to wait it out.
        const applyGrouping = () => {
          if (wantsNew) {
            for (const t of moving) { setExt(t, { group }); parkWithGroup(t, group); }
          } else if (wantsJoin && group) {
            const member = TABS.find((t) => groupOf(t) === group);
            const title = member ? extOf(member).fixedGroupTitle : null;
            const color = member ? extOf(member).groupColor : null;
            for (const t of moving) {
              setExt(t, { group, fixedGroupTitle: title || null, groupColor: color || null });
              parkWithGroup(t, group);
            }
          } else if (tweaks.includes("ungroup")) {
            // Vivaldi's own "remove from tab stack" (bundle.js
            // removeFromTabStack -> moveToIndex(..., ["untile","ungroup"])).
            for (const t of moving) setExt(t, { group: null, fixedGroupTitle: null, groupColor: null });
          } else if (!group && !tweaks.includes("do-not-reparent") &&
                     !tweaks.includes("create-new-group") && !tweaks.includes("create-group")) {
            // A move NOT told "do-not-reparent" and asking for no grouping takes
            // the tab out of its stack — what ADAPTER.detachFromStack relies on.
            for (const t of moving) setExt(t, { group: null, fixedGroupTitle: null, groupColor: null });
          }
          dissolveSingletons();
          reindex();
        };
        if (groupLatencyMs > 0) setTimeout(applyGrouping, groupLatencyMs);
        else applyGrouping();
        // pinToWorkspace: assign the workspace and place at the end of ITS
        // region. "do-not-reparent" means stack membership is left alone.
        if (targetIndex != null) {
          // An INDEX move (bundle.js moveToIndex; the engine's order phase).
          placeAt(moving, targetIndex, o.workspaceId != null ? o.workspaceId : null);
          OPS.push({ op: "move", ids: moving.map((t) => t.id), target: targetIndex });
        } else if (o.workspaceId != null) {
          for (const t of moving) {
            setExt(t, { workspaceId: o.workspaceId });
            if (groupOf(t)) parkWithGroup(t, groupOf(t));
            else parkInWorkspace(t, o.workspaceId);
            // A REPOSITIONED TAB LOSES ITS PIN. The pinned strip sits at the
            // front of the tab bar and this call puts the tab at the end of a
            // workspace's region, which is not in it. Modelled pessimistically
            // (listed under `unverified` in fixtures/vivaldi-api.json;
            // VivaSync.diagPin() settles it against a real build): the engine
            // must pin AFTER it has finished moving a tab, or not at all.
            if (t.pinned) {
              t.pinned = false;
              OPS.push({ op: "unpin-by-move", id: t.id });
            }
          }
        }
        reindex();
        const res = group ? { group } : true;
        return cb ? cb(res) : Promise.resolve(res);
      },
      // Vivaldi's own UI calls this with ONE property at a time (bundle.js
      // setFixedStackTitle passes groupTitle, setStackColor passes groupColor),
      // so a key that is not in the call leaves that property alone. A double
      // that overwrote both would hide the engine erasing a stack's colour
      // every time it re-asserted the name.
      setGroupProperties: (o, cb) => {
        const patch = {};
        if (o.groupTitle !== undefined) patch.fixedGroupTitle = o.groupTitle || null;
        if (o.groupColor !== undefined) patch.groupColor = o.groupColor || null;
        const apply = () => {
          for (const t of TABS) {
            if (groupOf(t) === String(o.groupExtId)) setExt(t, patch);
          }
        };
        if (groupLatencyMs > 0) setTimeout(apply, groupLatencyMs);
        else apply();
        if (o.groupColor !== undefined) {
          OPS.push({ op: "stack-color", gid: String(o.groupExtId), color: o.groupColor || null });
        }
        if (o.groupTitle !== undefined) {
          OPS.push({ op: "stack-name", gid: String(o.groupExtId), name: o.groupTitle || null });
        }
        return cb ? cb(true) : Promise.resolve(true);
      },
    },
  };

  global.window = global;
  global.document = {
    readyState: "complete",
    addEventListener: () => {},
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, setAttribute() {} }),
    querySelector: () => null,
    getElementById: () => null,
    body: { appendChild() {} },
  };
  global.navigator = { userAgent: "node" };

  // ---- visible-window DOM double (opts.ui) ---------------------------------
  // The toolbar button, its menu and the three dialogs are built with the
  // VISIBLE window document's createElement — main.html is 0x0 and paints
  // nothing — reached through chrome.extension.getViews(). Driving that code
  // offline needs a document that actually retains a tree, so opts.ui swaps the
  // inert stub above for the model below and makes getViews() return it.
  //
  // The warning at the top of this file applies double here: this is a MODEL of
  // the DOM and a wrong model gives green tests over broken UI.
  // 00-harness-selftest.js checks the double itself.
  let ui = null;
  if (opts.ui) {
    const mkEl = (tag) => {
      const e = {
        tagName: String(tag).toUpperCase(),
        style: {}, dataset: {}, children: [], parentNode: null,
        id: "", className: "", disabled: false,
        _text: "", _html: "", _handlers: {},
        // Layout is not simulated; these are the values the mod reads.
        _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        offsetWidth: 150, offsetHeight: 90,
        scrollTop: 0, clientHeight: 0, scrollHeight: 0,
        get textContent() {
          return this._text + this._html.replace(/<[^>]*>/g, " ") +
            this.children.map((c) => c.textContent).join(" ");
        },
        set textContent(v) { this._text = String(v); this.children.length = 0; },
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); this.children.length = 0; },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        remove() {
          const p = this.parentNode;
          if (!p) return;
          const i = p.children.indexOf(this);
          if (i >= 0) p.children.splice(i, 1);
          this.parentNode = null;
        },
        setAttribute(k, v) { this[k] = v; },
        addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
        removeEventListener(type, fn) {
          const a = this._handlers[type];
          if (!a) return;
          const i = a.indexOf(fn);
          if (i >= 0) a.splice(i, 1);
        },
        getBoundingClientRect() { return this._rect; },
        // Text inputs (the Exceptions dialog) — layout-free no-ops.
        focus() {}, select() {},
        contains(o) {
          if (o === this) return true;
          return this.children.some((c) => c.contains(o));
        },
        querySelector(sel) {
          for (const c of this.children) {
            const cls = String(c.className || "").split(/\s+/);
            if ((sel[0] === "." && cls.includes(sel.slice(1))) ||
                (sel[0] === "#" && c.id === sel.slice(1)) ||
                (/^[a-z]/i.test(sel) && c.tagName === sel.toUpperCase())) return c;
            const r = c.querySelector(sel);
            if (r) return r;
          }
          return null;
        },
        _find(pred) {
          for (const c of this.children) {
            if (pred(c)) return c;
            const r = c._find(pred);
            if (r) return r;
          }
          return null;
        },
        _all(pred, out = []) {
          for (const c of this.children) {
            if (pred(c)) out.push(c);
            c._all(pred, out);
          }
          return out;
        },
      };
      return e;
    };

    const body = mkEl("div");
    body.className = "body";
    // A status bar for findBar() to land on, sized so its height check passes.
    const bar = mkEl("div");
    bar.className = "statusbar";
    bar._rect = { left: 0, top: 776, right: 1280, bottom: 800, width: 1280, height: 24 };
    body.appendChild(bar);

    const clipboard = { text: null, writeText: (t) => { clipboard.text = t; return Promise.resolve(); } };
    const win = {
      innerWidth: 1280, innerHeight: 800,
      location: { href: "chrome-extension://abc/window.html" },
      navigator: { clipboard },
    };
    const doc = {
      readyState: "complete", body, defaultView: win, _handlers: {},
      createElement: (t) => mkEl(t),
      getElementById: (id) => (body.id === id ? body : body._find((e) => e.id === id)),
      querySelector: (sel) => body.querySelector(sel),
      hasFocus: () => true,
      addEventListener: (type, fn) => { (doc._handlers[type] = doc._handlers[type] || []).push(fn); },
      removeEventListener: (type, fn) => {
        const a = doc._handlers[type];
        if (!a) return;
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      },
    };
    win.document = doc;
    global.chrome.extension.getViews = () => [win];

    // Document-level listeners are registered in the capture phase (that is how
    // the menu dismisses itself), so they run before the target's own handlers.
    const dispatch = (target, type, ev) => {
      // NB: no native-checkbox behaviour is modelled, deliberately. Vivaldi's
      // window.html styles <input type=checkbox> into invisibility, so the mod
      // never uses one — every tick box is self-drawn and flips in its own click
      // handler (see mkToggle). A double that flipped `checked` for free would
      // make a raw checkbox look like it worked here and nowhere else.
      const e = Object.assign({ type, target, preventDefault() {}, stopPropagation() {} }, ev || {});
      for (const fn of (doc._handlers[type] || []).slice()) fn(e);
      if (target) {
        const inline = target["on" + type];
        if (typeof inline === "function") inline(e);
        for (const fn of (target._handlers[type] || []).slice()) fn(e);
      }
      return e;
    };

    ui = {
      win, doc, body, bar, clipboard, dispatch,
      click: (el) => dispatch(el, "click"),
      key: (key) => dispatch(null, "keydown", { key }),
      button: () => doc.getElementById("vivasync-toggle-btn"),
      menu: () => doc.getElementById("vivasync-menu"),
      overlay: () => doc.getElementById("vivasync-settings-overlay"),
      // Menu entries and dialog buttons are found by their visible label.
      byText: (root, text) => root && root._find((e) => e._text === text),
      buttons: (root) => (root ? root._all((e) => e.tagName === "BUTTON") : []),
    };
  }

  const consoleErrors = [];
  const realError = console.error;
  console.error = (...a) => {
    consoleErrors.push(a.map(String).join(" "));
    realError(...a);
  };

  const env = {
    WS,
    notes,
    tree,
    root,
    OPS,
    ui, // null unless opts.ui — see the DOM double above
    consoleErrors,
    fire,
    get TABS() { return TABS; },
    get VivaSync() { return global.VivaSync; },
    activeWorkspaceId,
    folder: () => root.children.find((c) => c.title === "VivaSync" && c.type === "folder"),
    noteTitles: () => (env.folder()?.children || []).map((n) => n.title),
    noteByTitle: (t) => (env.folder()?.children || []).find((n) => n.title === t),
    // URLs of the tabs belonging to one workspace, in tab-strip order.
    urls: (wsId) =>
      TABS.filter((t) => String(Number(JSON.parse(t.vivExtData).workspaceId)) === String(Number(wsId)))
        .sort((a, b) => a.index - b.index)
        .map((t) => t.url),
    addTab: (t) => {
      const tab = {
        id: t.id || nextId++, windowId: 1, index: t.index != null ? t.index : TABS.length,
        active: !!t.active, pinned: !!t.pinned, url: t.url, title: t.title || t.url,
        status: t.status || "complete",
        vivExtData: ext(
          Object.assign({ workspaceId: t.ws }, t.group
            ? { group: t.group, fixedGroupTitle: t.stackName, groupColor: t.stackColor }
            : {})
        ),
      };
      TABS.push(tab);
      reindex();
      return tab;
    },
    // Model a tab navigating to a new URL: the address changes and
    // chrome.tabs.onUpdated fires with it, exactly as a site rewriting its own
    // URL from an input box does on every intermediate value. `status` lets a
    // test hold the tab mid-navigation ("loading") instead.
    navigate: (id, url, status = "complete") => {
      const t = TABS.find((x) => x.id === id);
      if (!t) throw new Error("navigate: no tab with id " + id);
      t.url = url;
      t.title = url;
      t.status = status;
      fire("tabUpdated", t.id, { url, status }, t);
      return t;
    },
    // Close a tab the way the user does (and let the stack model react).
    closeTab: (id) => global.chrome.tabs.remove(id),
    // Pin/unpin a tab the way the USER does: the flag flips and onUpdated
    // announces it, exactly as tabs.update does — the engine cannot tell them
    // apart, and must not need to.
    pin: (id, pinned = true) => {
      const t = TABS.find((x) => x.id === id);
      if (!t) throw new Error("pin: no tab with id " + id);
      t.pinned = !!pinned;
      fire("tabUpdated", t.id, { pinned: t.pinned }, t);
      return t;
    },
    // Which tabs of one workspace are pinned, in strip order.
    pinnedUrls: (wsId) =>
      TABS.filter((t) => String(Number(JSON.parse(t.vivExtData).workspaceId)) === String(Number(wsId)))
        .sort((a, b) => a.index - b.index)
        .filter((t) => t.pinned)
        .map((t) => t.url),
    // Model a build that ignores `pinned` in both create and update.
    setPinSupport: (on) => { canPin = !!on; },
    // Model a build on which pinning a MEMBER takes it out of its stack.
    breakGroupOnPin: (on = true) => { breakGroupOnPin = !!on; },
    // The user pins (or unpins) a whole tab stack — Vivaldi's own gesture,
    // which acts on the stack as a unit and keeps it a stack.
    pinGroup: (gid, pinned = true) => {
      const members = TABS.filter((t) => groupOf(t) === String(gid));
      if (!members.length) throw new Error("pinGroup: no stack " + gid);
      for (const t of members) {
        t.pinned = !!pinned;
        fire("tabUpdated", t.id, { pinned: t.pinned }, t);
      }
      return members.map((t) => t.id);
    },
    // The user gives a whole tab stack a colour (or clears it with null) —
    // Vivaldi's own Tab Stack > Color menu, which acts on the stack as a unit.
    // The members' vivExtData changes and onUpdated announces it, exactly as
    // setGroupProperties does; the engine cannot tell the two apart.
    setStackColor: (gid, color = "color2") => {
      const members = TABS.filter((t) => groupOf(t) === String(gid));
      if (!members.length) throw new Error("setStackColor: no stack " + gid);
      for (const t of members) {
        setExt(t, { groupColor: color || null });
        // A stack property changing surfaces as a vivExtData update — the same
        // event the engine already relies on for a RENAME (see its onUpdated
        // listener). Listed under `unverified` in fixtures/vivaldi-api.json.
        fire("tabUpdated", t.id, { vivExtData: t.vivExtData }, t);
      }
      return members.map((t) => t.id);
    },
    // The user moves tabs (a whole stack, or loose tabs) to another workspace
    // — Vivaldi's "Move to workspace". Only the workspace changes: a stack
    // stays a stack, with its name and colour, and the tabs keep their strip
    // positions. onUpdated announces the new vivExtData, as it does for every
    // other stack property. Switching INTO the target (which Vivaldi does
    // too) is left to the test, env.switchWorkspace.
    moveToWorkspace: (ids, wsId) => {
      const moving = ids.map((i) => TABS.find((t) => t.id === i));
      if (moving.some((t) => !t)) throw new Error("moveToWorkspace: no such tab in " + JSON.stringify(ids));
      for (const t of moving) {
        setExt(t, { workspaceId: wsId });
        fire("tabUpdated", t.id, { vivExtData: t.vivExtData }, t);
      }
      return moving.map((t) => t.id);
    },
    // How long a created tab stays "loading" (0 = complete immediately).
    setLoadLatency: (ms) => { loadLatencyMs = Math.max(0, ms | 0); },
    // The user drags a tab (or a whole selection) to a strip index — post-
    // removal frame, like chrome.tabs.move — firing chrome.tabs.onMoved.
    // Membership is untouched, so moving a stack member by itself here is a
    // reorder WITHIN the stack (the real browser keeps runs contiguous; a test
    // that moves a member out of its run is modelling something unverified).
    moveTab: (id, index) => env.moveTabs([id], index),
    moveTabs: (ids, index) => {
      const moving = ids.map((i) => TABS.find((t) => t.id === i)).filter(Boolean);
      if (moving.length !== ids.length) throw new Error("moveTabs: no such tab in " + JSON.stringify(ids));
      placeAt(moving, index, null);
      return moving.map((t) => t.index);
    },
    // The live stacks of one workspace, in strip order:
    // [{gid, name, color, pinned, urls}].
    stacks: (wsId) => {
      const out = new Map();
      for (const t of TABS.slice().sort((a, b) => a.index - b.index)) {
        if (String(Number(extOf(t).workspaceId)) !== String(Number(wsId))) continue;
        const g = groupOf(t);
        if (!g) continue;
        if (!out.has(g)) {
          out.set(g, {
            gid: g, name: extOf(t).fixedGroupTitle || null,
            color: extOf(t).groupColor || null, urls: [], pinned: true,
          });
        }
        out.get(g).urls.push(t.url);
        if (!t.pinned) out.get(g).pinned = false; // pinned only if EVERY member is
      }
      return [...out.values()];
    },
    // One-line rendering of a workspace, for assertion messages:
    //   "https://c/ | [AUR: https://a/, https://b/]"
    layout: (wsId) => {
      const parts = [];
      const seen = new Set();
      for (const t of TABS.slice().sort((a, b) => a.index - b.index)) {
        if (String(Number(extOf(t).workspaceId)) !== String(Number(wsId))) continue;
        const g = groupOf(t);
        if (!g) { parts.push(t.url); continue; }
        if (seen.has(g)) continue;
        seen.add(g);
        const st = env.stacks(wsId).find((s2) => s2.gid === g);
        parts.push(`[${st.pinned ? "*" : ""}${st.name || "?"}${st.color ? "#" + st.color : ""}: ${st.urls.join(", ")}]`);
      }
      return parts.join(" | ");
    },
    // Make getTree() report this note's content as "" (get() still has it).
    hideTreeContent: (id, hide = true) => {
      if (hide) hiddenContent.add(String(id)); else hiddenContent.delete(String(id));
    },
    // Put a peer's document in the folder (as Vivaldi Sync would).
    putPeerDoc: (title, doc) =>
      new Promise((res) =>
        notes.create({ parentId: env.folder().id, title, type: "note", content: JSON.stringify(doc, null, 2) }, res)
      ),
    updateNote: (title, content) =>
      new Promise((res) => notes.update(env.noteByTitle(title).id, { content: JSON.stringify(content, null, 2) }, res)),
    // Seed the config note as the settings dialog would, then reload it.
    //
    // A bare name is shorthand for "this device syncs it" and is expanded to
    // the real entry shape, {name, peers:[<device>]} — the note itself has no
    // bare-name form. Pass an object to say something else, e.g. a workspace
    // only other devices sync.
    setConfig: async (cfg) => {
      const out = {
        ...cfg,
        workspaces: (cfg.workspaces || []).map((w) =>
          typeof w === "string" ? { name: w, peers: [deviceName] } : w
        ),
      };
      const n = env.noteByTitle("sync.config");
      await new Promise((res) => notes.update(n.id, { content: JSON.stringify(out) }, res));
      return global.VivaSync.reloadConfig();
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Which grouping primitives this modelled build honours. Turning
    // addToStack off models a build that ignores "on"+"create-group" — the case
    // the engine's createStack rebuild exists for. Turning both off models one
    // where no stack can be formed at all, where the engine must decline to
    // publish rather than describe the half-applied state it is sitting in.
    setGroupingSupport: ({ addToStack, createStack } = {}) => {
      if (addToStack != null) canAddToStack = !!addToStack;
      if (createStack != null) canCreateStack = !!createStack;
    },
    // Make one tab the active one, as clicking it does. Which tab is active
    // decides whether a NEW tab is swallowed into a stack, so tests that care
    // about grouping have to say.
    activate: (url) => {
      const t = TABS.find((x) => x.url === url);
      if (!t) throw new Error("activate: no tab with url " + url);
      for (const x of TABS) x.active = false;
      t.active = true;
      return t;
    },
    // Model the user switching workspace: make one of its tabs active and fire
    // chrome.tabs.onActivated, which is the ONLY thing that tells the mod the
    // active workspace changed. Resolves after the mod's 250ms switch debounce
    // plus room for the reconcile it triggers.
    switchWorkspace: async (wsId, settleMs = 900) => {
      const t = TABS.filter(
        (x) => String(Number(JSON.parse(x.vivExtData).workspaceId)) === String(Number(wsId))
      ).sort((a, b) => a.index - b.index)[0];
      if (!t) throw new Error("switchWorkspace: no tabs in workspace " + wsId);
      for (const x of TABS) x.active = false;
      t.active = true;
      fire("tabActivated", { tabId: t.id, windowId: t.windowId });
      await new Promise((r) => setTimeout(r, settleMs));
      return t;
    },
    // Load the mod and wait past its 1500ms boot delay.
    boot: async () => {
      (0, eval)(fs.readFileSync(MOD_PATH, "utf8"));
      await new Promise((r) => setTimeout(r, 2200));
      if (!global.VivaSync) throw new Error("mod did not install window.VivaSync");
      return global.VivaSync;
    },
  };
  return env;
}

// ---- tiny assertion runner -------------------------------------------------
const results = { pass: 0, fail: 0 };
function ok(label, cond, detail = "") {
  if (cond) results.pass++;
  else results.fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? "  -> " + detail : ""}`);
}
function done() {
  console.log(`\n${results.fail ? "FAILED" : "OK"}  ${results.pass} passed, ${results.fail} failed`);
  process.exit(results.fail ? 1 : 0);
}

module.exports = { createEnv, ok, done, WS, MOD_PATH };
