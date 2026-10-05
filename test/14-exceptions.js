// Exceptions — address prefixes the user has excluded from synchronization.
//
// The "exceptions" list of sync.config (edited in the Exceptions dialog, see
// 05-ui.js) names address PREFIXES. A tab whose address begins with one is
// treated like an empty new tab: it is absent from this device's document and
// from the change signature (§1), it is never closed for being absent from a
// peer's document (§3), and a peer's document that still lists such an address
// does not open it here (§3, §4). The comparison ignores the scheme, a leading
// "www." and letter case (§2). A stack that exceptions reduce to one member is
// a plain tab, in a document being built and in one being applied (§4).
// Dropping an exception puts the tab back into the document (§5).
const { createEnv, ok, done } = require("./harness");

const WS_ID = 1717425015828.0;
const A = "https://a.example/";
const MAPS = "https://www.google.com/maps/@40.0809214,-75.0961545,2968m/data=!3m1!1e3!5m1!1e1?entry=ttu";
const MAPS_HTTP_CAPS = "http://google.com/MAPS/place/Somewhere";
const MAPS_LONGER = "https://www.google.com/mapsearch/x"; // a prefix match is a prefix match
const SEARCH = "https://www.google.com/search?q=maps"; // "maps" elsewhere is not excepted
const PEER_MAPS = "https://www.google.com/maps/place/Other";
const B = "https://b.example/";
const C = "https://c.example/";
const D = "https://d.example/";
const MAPS_IN_STACK = "https://www.google.com/maps/dir/here/there";

const env = createEnv({
  tabs: [
    { id: 11, url: A, ws: WS_ID, active: true },
    { id: 12, url: MAPS, ws: WS_ID },
  ],
});
const WORK = env.WS.WORK;
const now = () => Date.now() / 1000;

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work"], exceptions: ["www.google.com/maps"] });
  await W.reconcile("Work");

  const ownDoc = () => JSON.parse(env.noteByTitle("Work-boxA.json").content);
  const ownUrls = () => ownDoc().items.map((i) => (i.type === "stack" ? `[${i.tabs.map((t) => t.url).join(",")}]` : i.url)).sort().join(",");
  const awaitPublished = async (urls) => {
    for (let i = 0; i < 60 && ownUrls() !== urls; i++) await env.sleep(250);
    return ownDoc();
  };
  const snapUrls = async () =>
    (await W.snapshot("Work")).items.map((i) => (i.type === "stack" ? `[${i.tabs.map((t) => t.url).join(",")}]` : i.url)).sort();

  // ===========================================================================
  // 0. The list is read from the note and surfaced.
  // ===========================================================================
  ok("0a. config() exposes the exceptions",
     JSON.stringify(W.config().exceptions) === JSON.stringify(["www.google.com/maps"]),
     JSON.stringify(W.config().exceptions));
  const rowC = (await W.status()).find((r) => r.key === "C. config");
  ok("0b. the Debug window's config row counts them", rowC && rowC.detail.includes("1 exception(s): www.google.com/maps"),
     rowC && rowC.detail);

  // ===========================================================================
  // 1. An excepted tab is not in the document.
  // ===========================================================================
  ok("1a. the snapshot leaves the excepted tab out", JSON.stringify(await snapUrls()) === JSON.stringify([A]),
     JSON.stringify(await snapUrls()));
  await W.writeNow();
  await awaitPublished(A);
  ok("1b. ...and so does the published document", ownUrls() === A, ownUrls());
  ok("1c. the tab itself is untouched", env.urls(WORK).includes(MAPS));

  // ===========================================================================
  // 2. Matching ignores scheme, "www." and case; it is a prefix, not a host.
  // ===========================================================================
  env.addTab({ id: 13, url: MAPS_HTTP_CAPS, ws: WORK });
  env.addTab({ id: 14, url: MAPS_LONGER, ws: WORK });
  env.addTab({ id: 15, url: SEARCH, ws: WORK });
  ok("2. http, no www., upper case and a longer prefix are excepted; another path is not",
     JSON.stringify(await snapUrls()) === JSON.stringify([A, SEARCH].sort()), JSON.stringify(await snapUrls()));
  await W.writeNow();
  await awaitPublished([A, SEARCH].sort().join(","));

  // ===========================================================================
  // 3. A peer's document: excepted addresses in it are not opened, excepted
  //    tabs here are not closed for being absent from it.
  // ===========================================================================
  await env.putPeerDoc("Work-boxB.json", {
    workspace: "Work", origin: "boxB", version: 10, timestamp: now() + 5,
    items: [A, PEER_MAPS, B].map((u) => ({ type: "tab", url: u, title: u, pinned: false })),
  });
  await W.reconcile("Work");
  const urls3 = env.urls(WORK);
  ok("3a. the peer's ordinary tab is opened", urls3.includes(B), JSON.stringify(urls3));
  ok("3b. the peer's excepted address is not", !urls3.includes(PEER_MAPS), JSON.stringify(urls3));
  ok("3c. this device's excepted tabs survive, though no document lists them",
     urls3.includes(MAPS) && urls3.includes(MAPS_HTTP_CAPS) && urls3.includes(MAPS_LONGER), JSON.stringify(urls3));
  ok("3d. the non-excepted tab absent from the peer's document is closed (newest-wins still holds)",
     !urls3.includes(SEARCH), JSON.stringify(urls3));
  await awaitPublished([A, B].sort().join(","));
  ok("3e. the acknowledgement carries the peer's provenance and no excepted address",
     ownDoc().origin === "boxB" && ownDoc().version === 10 && ownUrls() === [A, B].sort().join(","),
     `${ownDoc().origin} v${ownDoc().version} ${ownUrls()}`);

  // ===========================================================================
  // 4. Stacks: a stack that exceptions reduce to one member is a plain tab.
  // ===========================================================================
  env.addTab({ id: 16, url: D, ws: WORK, group: "g1", stackName: "Trip" });
  env.addTab({ id: 17, url: MAPS_IN_STACK, ws: WORK, group: "g1", stackName: "Trip" });
  const snap4 = await snapUrls();
  ok("4a. a local stack of (tab, excepted) is published as the tab alone",
     JSON.stringify(snap4) === JSON.stringify([A, B, D].sort()), JSON.stringify(snap4));
  await W.writeNow();
  await awaitPublished([A, B, D].sort().join(","));
  await env.updateNote("Work-boxB.json", {
    workspace: "Work", origin: "boxB", version: 12, timestamp: now() + 10,
    items: [
      ...[A, B, D].map((u) => ({ type: "tab", url: u, title: u, pinned: false })),
      { type: "stack", id: "peer-gid", name: "Route",
        tabs: [C, PEER_MAPS].map((u) => ({ type: "tab", url: u, title: u, pinned: false })) },
    ],
  });
  await W.reconcile("Work");
  const urls4 = env.urls(WORK);
  ok("4b. the remaining member of a peer's stack arrives as a plain tab",
     urls4.includes(C) && !urls4.includes(PEER_MAPS) && !env.stacks(WORK).some((s) => s.name === "Route"),
     `${JSON.stringify(urls4)} stacks=${JSON.stringify(env.stacks(WORK))}`);
  const trip = env.stacks(WORK).find((s) => s.name === "Trip");
  ok("4c. the local stack keeps its excepted member — the peer's top-level D does not pull D out of it",
     trip && trip.urls.length === 2 && trip.urls.includes(D) && trip.urls.includes(MAPS_IN_STACK),
     JSON.stringify(env.stacks(WORK)));
  // Let the acknowledgement of v12 go out before changing the list: a write
  // while it is pending is spent on it (invariant 2), which is not what §5 is
  // about.
  await awaitPublished([A, B, C, D].sort().join(","));
  ok("4d. the acknowledgement lists the stack's synced member as a plain tab",
     ownDoc().origin === "boxB" && ownDoc().version === 12, `${ownDoc().origin} v${ownDoc().version}`);

  // ===========================================================================
  // 5. Removing the exception puts the tabs back into the document — from a
  //    config reload alone, without waiting for a tab event.
  // ===========================================================================
  await env.setConfig({ workspaces: ["Work"], exceptions: [] });
  ok("5a. config() reflects the emptied list", W.config().exceptions.length === 0);
  const all5 = [A, B, C, MAPS, MAPS_HTTP_CAPS, MAPS_LONGER, `[${D},${MAPS_IN_STACK}]`].sort().join(",");
  await awaitPublished(all5);
  ok("5b. the formerly excepted tabs (and the whole stack) are published", ownUrls() === all5, ownUrls());
  ok("5c. ...as a fresh origination of this device", ownDoc().origin === "boxA" && ownDoc().version > 12,
     `${ownDoc().origin} v${ownDoc().version}`);

  ok("no errors logged during the run", env.consoleErrors.length === 0, env.consoleErrors.join(" | ") || "clean");
  done();
})();
