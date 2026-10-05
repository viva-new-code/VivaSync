// Regressions for URL churn: a tab opening and closing in a cycle on BOTH
// devices, with sustained CPU load (seen with https://www.infoworld.com).
//
// Cause: tab identity is the URL string, so a URL that does not survive the
// round-trip can never match. A publishes "https://www.infoworld.com", B opens
// it, the site redirects to "https://infoworld.com/", B publishes THAT, A no
// longer recognises its own tab and deletes + recreates it, for ever.
//
// Three defences, one per section below:
//   1. normUrl()   - cosmetic differences (www., trailing slash, case, default
//                    port) stop being differences at all
//   2. loading tabs - never deleted, never published, because their URL is
//                    transient while they navigate
//   3. circuit breaker - a URL that genuinely cannot round-trip is abandoned
//                    after a few attempts instead of blinking for ever
const { createEnv, ok, done } = require("./harness");

const env = createEnv({
  tabs: [{ id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true }],
});
const WORK = env.WS.WORK;

// The offset doubles as the peer's version: it only ever grows through the file.
const peerDoc = (urls, tsOffset) => ({
  workspace: "Work",
  origin: "boxB",
  version: tsOffset,
  timestamp: Date.now() / 1000 + tsOffset,
  items: urls.map((u) => ({ type: "tab", url: u, title: u, pinned: false })),
});

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work"] });
  await W.reconcile("Work");
  await W.writeNow();

  // ===========================================================================
  // 1. Cosmetic URL differences must not be treated as different tabs.
  // ===========================================================================
  // Live tab is https://a.example/ ; the peer publishes the same page spelled
  // four common other ways. None should cause a delete + recreate.
  env.OPS.length = 0;
  await env.putPeerDoc("Work-boxB.json", peerDoc(["https://www.a.example"], 60));
  await W.reconcile("Work");
  ok("1a. www. + missing trailing slash is the SAME tab (no churn)",
     env.OPS.length === 0, env.OPS.map((o) => o.op).join(",") || "no tab operations");

  env.OPS.length = 0;
  await env.updateNote("Work-boxB.json", peerDoc(["HTTPS://A.EXAMPLE:443/"], 120));
  await W.reconcile("Work");
  ok("1b. case + default port is the SAME tab (no churn)",
     env.OPS.length === 0, env.OPS.map((o) => o.op).join(",") || "no tab operations");

  // ...but a genuinely different page must still sync.
  env.OPS.length = 0;
  await env.updateNote("Work-boxB.json", peerDoc(["https://a.example/", "https://a.example/news"], 180));
  await W.reconcile("Work");
  ok("1c. a genuinely different path IS a different tab",
     env.urls(WORK).includes("https://a.example/news"), JSON.stringify(env.urls(WORK)));
  // Query and fragment are preserved: collapsing them would delete tabs the
  // user considers distinct (two views of one SPA).
  env.OPS.length = 0;
  await env.updateNote("Work-boxB.json",
    peerDoc(["https://a.example/", "https://a.example/news", "https://a.example/news?page=2"], 240));
  await W.reconcile("Work");
  ok("1d. a differing query string IS a different tab",
     env.urls(WORK).includes("https://a.example/news?page=2"), JSON.stringify(env.urls(WORK)));

  // ===========================================================================
  // 2. A tab that is still navigating must be left alone.
  // ===========================================================================
  // Vivaldi reports status:"loading" and a transient URL while a page resolves.
  const loadingTab = env.addTab({ id: 55, url: "https://slow.example/", ws: WORK });
  loadingTab.status = "loading";
  await env.updateNote("Work-boxB.json", peerDoc(["https://a.example/"], 300));
  await W.reconcile("Work");
  ok("2a. a loading tab is not deleted even when absent from the remote",
     env.TABS.some((t) => t.id === 55), JSON.stringify(env.urls(WORK)));

  // ...and its transient URL must not be published to the peers.
  const before = JSON.parse(env.noteByTitle("Work-boxA.json").content).timestamp;
  await W.writeNow();
  await env.sleep(300);
  const during = JSON.parse(env.noteByTitle("Work-boxA.json").content).timestamp;
  ok("2b. nothing is published while a tab is still loading", during === before,
     `timestamp ${before} -> ${during}`);

  loadingTab.status = "complete";
  await env.sleep(5200); // clear the per-note write throttle
  await W.writeNow();
  const after = JSON.parse(env.noteByTitle("Work-boxA.json").content);
  ok("2c. once loading completes the snapshot is published",
     after.items.some((i) => i.url === "https://slow.example/"),
     JSON.stringify(after.items.map((i) => i.url)));

  // A HIBERNATED tab is not an in-flight one. chrome.tabs.Tab.status is
  // "unloaded" | "loading" | "complete", and Vivaldi both discards background
  // tabs and restores a session lazily — so right after a restart most of a
  // workspace reports "unloaded", holding a perfectly good URL. Lumping that in
  // with "loading" would pin every such tab in place: nothing could be deleted
  // for being absent from a remote, so deletes would stop crossing between
  // devices at all ("deleted top level tabs do not synchronize"), and every
  // publish would burn the whole load-defer budget first.
  env.addTab({ id: 56, url: "https://napping.example/", ws: WORK, status: "unloaded" });
  await env.updateNote("Work-boxB.json",
    peerDoc(["https://a.example/", "https://slow.example/"], 360));
  await W.reconcile("Work");
  ok("2d. a hibernated ('unloaded') tab IS deleted when absent from the remote",
     !env.TABS.some((t) => t.id === 56), JSON.stringify(env.urls(WORK)));

  // Hibernation must not cost a publish its load-defer budget either. Asserting
  // on the note alone is not enough: MAX_LOAD_DEFERS eventually gives up and
  // publishes anyway, so a wrong predicate still lands the write, just slowly.
  // The tell is what this particular write LOGGED, so watch the new log lines.
  await env.sleep(5200); // clear the per-note write throttle
  for (const t of env.TABS) t.status = "unloaded";
  env.addTab({ id: 57, url: "https://fresh.example/", ws: WORK, status: "unloaded" });
  const logMark = W.log(400).length;
  await W.writeNow();
  // writeNow re-arms rather than queues when the note throttle is still closed
  // (invariant 3), so the write can land in a later sweep. Wait for the note,
  // then read back everything that write logged on its way out.
  const landed = () =>
    JSON.parse(env.noteByTitle("Work-boxA.json").content)
      .items.some((i) => i.url === "https://fresh.example/");
  for (let i = 0; i < 40 && !landed(); i++) await env.sleep(250);
  const emitted = W.log(400).slice(logMark);
  const napped = JSON.parse(env.noteByTitle("Work-boxA.json").content);
  ok("2e. a workspace of hibernated tabs publishes without a load-deferral",
     napped.items.some((i) => i.url === "https://fresh.example/") &&
     !emitted.some((l) => /defer write of Work|despite a stuck loading tab/.test(l)),
     emitted.join(" | ") || "no log output");

  // ===========================================================================
  // 3. A URL that cannot round-trip is abandoned, not retried for ever.
  // ===========================================================================
  // Simulate the infoworld case: whatever we open, the tab ends up somewhere
  // else, so the desired URL is never satisfied and the peer keeps asking.
  const REDIRECTS_TO = "https://www.infoworld.com/uk/";
  const ASKED_FOR = "https://www.infoworld.com/";
  const realCreate = chrome.tabs.create;
  chrome.tabs.create = async (p) => {
    const t = await realCreate(p);
    if (p.url === ASKED_FOR) t.url = REDIRECTS_TO; // the site bounces us elsewhere
    return t;
  };

  let creates = 0;
  for (let round = 0; round < 8; round++) {
    env.OPS.length = 0;
    await env.updateNote("Work-boxB.json", peerDoc(["https://a.example/", ASKED_FOR], 400 + round * 10));
    await W.reconcile("Work");
    creates += env.OPS.filter((o) => o.op === "create").length;
    // drop the redirected tab, as the next reconcile round would
    env.TABS = env.TABS.filter((t) => t.url !== REDIRECTS_TO);
  }
  chrome.tabs.create = realCreate;

  ok("3a. an unstable URL is retried a bounded number of times, then dropped",
     creates <= 3, `${creates} create attempts over 8 reconcile rounds (cap is 3)`);

  const churn = W.diagChurn();
  ok("3b. the offending URL is reported as blocked, with its address",
     churn.blocked.some((b) => b.url === ASKED_FOR),
     JSON.stringify(churn.blocked.map((b) => b.url)));

  W.clearChurn();
  ok("3c. clearChurn() resets the counters", W.diagChurn().blocked.length === 0);

  // ===========================================================================
  // 4. The empty new tab. Same loop as section 3, but the URL never even had a
  //    chance to round-trip: it is a start page, spelled differently per build
  //    and per device, and it turns into something else the moment the user
  //    finishes typing. Synced, it is a new tab flipping between empty and
  //    loaded on two machines in step — and unfixable by waiting,
  //    because the trigger is the human pause before typing.
  // ===========================================================================
  // Start from a clean, agreed state.
  await env.updateNote("Work-boxB.json", peerDoc(["https://a.example/"], 600));
  await W.reconcile("Work");
  await env.sleep(5200);
  await W.writeNow();

  const blank = env.addTab({ id: 71, url: "chrome://vivaldi-webui/startpage", ws: WORK });
  await env.sleep(5200);
  await W.writeNow();
  const withBlank = JSON.parse(env.noteByTitle("Work-boxA.json").content);
  ok("4a. an empty new tab is not published at all",
     !withBlank.items.some((i) => /startpage|newtab|about:blank/.test(i.url || "")),
     JSON.stringify(withBlank.items.map((i) => i.url)));

  // ...and symmetrically, the peer not knowing about it must not close it: the
  // user is most likely typing in it.
  await env.updateNote("Work-boxB.json", peerDoc(["https://a.example/"], 660));
  await W.reconcile("Work");
  ok("4b. ...and it is not deleted for being absent from the remote",
     env.TABS.some((t) => t.id === 71), JSON.stringify(env.urls(WORK)));

  // The user finishes typing. NOW it is content, and now it syncs.
  blank.url = "https://meduza.io/";
  blank.title = "Meduza";
  await env.sleep(5200);
  await W.writeNow();
  const typed = JSON.parse(env.noteByTitle("Work-boxA.json").content);
  ok("4c. once the user navigates, the real URL IS published",
     typed.items.some((i) => i.url === "https://meduza.io/"),
     JSON.stringify(typed.items.map((i) => i.url)));

  // And the loop itself: a peer that has not seen the navigation yet publishes
  // the older layout. That must not resurrect an empty tab here, nor delete the
  // page the user just opened... and the document we publish back must still
  // name it, or the two devices trade the tab back and forth for ever.
  env.OPS.length = 0;
  await env.updateNote("Work-boxB.json", peerDoc(["https://a.example/", "https://meduza.io/"], 720));
  await W.reconcile("Work");
  const settled = await W.snapshot("Work");
  ok("4d. the tab is not re-opened or re-closed once both sides agree",
     env.OPS.length === 0, env.OPS.map((o) => o.op + ":" + (o.url || o.ids)).join(",") || "no tab operations");
  ok("4e. ...and what we publish still names the page, not a blank tab",
     settled.items.some((i) => i.url === "https://meduza.io/") &&
     !settled.items.some((i) => /startpage|newtab|about:blank/.test(i.url || "")),
     JSON.stringify(settled.items.map((i) => i.url)));

  // ===========================================================================
  // 5. A URL still being typed is not published until it holds still.
  // ===========================================================================
  // The case that "wait for the load to complete" does NOT cover. Google
  // Translate drives its address from the input box: typing "well" COMPLETES a
  // navigation at "w", at "we", and again at "well". Each of those is a fully
  // loaded, perfectly well-formed URL, so `isLoadingTab` lets every one of them
  // through — and the peer would open each prefix in turn, publish it back, and
  // the user's own tab would reload through its own half-typed history.
  //
  // The tell is not the load state, it is a quiet period: what the user stopped
  // on is what is still there a moment later (URL_SETTLE_MS).
  // ===========================================================================
  const url = (word) => `https://translate.example/?text=${word}`;
  const T = env.TABS.find((t) => t.url === "https://meduza.io/") || env.TABS[0];
  const published = () =>
    JSON.parse(env.noteByTitle("Work-boxA.json").content).items.map((i) => i.url);

  // Land a write and then wait the note throttle out, so the typing below
  // starts with an OPEN throttle. Without this the section passes vacuously:
  // nothing is published during it either way, and the assertions cannot tell
  // the settle window from the 5s floor between two writes of the same note.
  env.navigate(T.id, url("seed"));
  for (let i = 0; i < 60 && !published().includes(url("seed")); i++) await env.sleep(250);
  ok("5pre. the section starts from a published, settled state",
     published().includes(url("seed")), JSON.stringify(published()));
  await env.sleep(5200);

  env.navigate(T.id, url("w"));
  await env.sleep(900);
  env.navigate(T.id, url("we"));
  await env.sleep(900);
  ok("5. a URL that keeps changing is not published, even though it is 'complete'",
     published().includes(url("seed")) &&
       !published().some((u) => u === url("w") || u === url("we")),
     JSON.stringify(published()));

  env.navigate(T.id, url("well"));
  // Long enough for the quiet period AND the note throttle behind it.
  for (let i = 0; i < 48 && !published().includes(url("well")); i++) await env.sleep(250);
  ok("5b. ...and once it holds still, the settled value is published",
     published().includes(url("well")), JSON.stringify(published()));
  ok("5c. ...and not one of the values it passed through on the way",
     !published().some((u) => u === url("w") || u === url("we")),
     JSON.stringify(published()));

  // Liveness: a page that rewrites its URL for ever must delay the publish, not
  // cancel it. MAX_SETTLE_HOLD_MS is the ceiling.
  await env.sleep(5200);
  let n = 0;
  const tick = setInterval(() => env.navigate(T.id, url("loop" + n++)), 700);
  let heldFor = 0;
  for (let i = 0; i < 100; i++) {
    await env.sleep(250);
    heldFor += 250;
    if (published().some((u) => /text=loop/.test(u))) break;
  }
  clearInterval(tick);
  ok("5d. a URL that never settles is published anyway, once, after the ceiling",
     published().some((u) => /text=loop/.test(u)) && heldFor >= 2500,
     `published ${JSON.stringify(published())} after ${heldFor}ms`);

  // ===========================================================================
  // 6. A tab THIS device opened from a document is closable while it loads.
  // ===========================================================================
  // "A loading tab is never closed" (§2a) is about a tab the USER opened: its
  // address is not a fact yet and closing it takes a page out from under them.
  // A tab we opened because a document named it is the opposite case — nobody
  // is typing in it, and if a NEWER document drops it, it should go. Without
  // that distinction a second document arriving inside the first apply's load
  // window would leave every tab of the first one open, and the acknowledgement
  // would publish them back under the peer's own provenance, which the peer
  // never applies: the two devices would sit on different tab sets. Needs the
  // harness modelling a newborn as `loading`.
  env.setLoadLatency(4000); // hold every newborn loading across both applies
  await env.updateNote("Work-boxB.json", peerDoc(["https://keep.example/", "https://drop.example/"], 900));
  await W.reconcile("Work");
  const born = env.TABS.filter((t) => /keep|drop/.test(t.url));
  ok("6a. both arrive, and are still loading",
     born.length === 2 && born.every((t) => t.status === "loading"),
     JSON.stringify(born.map((t) => [t.url, t.status])));
  await env.updateNote("Work-boxB.json", peerDoc(["https://keep.example/"], 910));
  await W.reconcile("Work");
  ok("6b. a newer document closes the sync-born tab it dropped, loading or not",
     env.urls(WORK).includes("https://keep.example/") &&
       !env.urls(WORK).includes("https://drop.example/"),
     JSON.stringify(env.urls(WORK)));
  // ...while a tab the USER opened mid-navigation is still untouchable (§2a).
  const userTab = env.addTab({ url: "https://user-typed.example/", ws: WORK });
  userTab.status = "loading";
  await env.updateNote("Work-boxB.json", peerDoc(["https://keep.example/"], 920));
  await W.reconcile("Work");
  ok("6c. ...but a tab the USER opened is still never closed while it loads",
     env.urls(WORK).includes("https://user-typed.example/"), JSON.stringify(env.urls(WORK)));
  env.setLoadLatency(60);

  done();
})();
