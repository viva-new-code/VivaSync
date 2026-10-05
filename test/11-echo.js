// A peer's copy of a state WE originated must never be applied back to us —
// and it has to be recognised by its ORIGIN, not by what it looks like or what
// it is stamped with.
//
// Recognising the echo by anything else fails. The peer's rendering of our
// state is not signature-identical to ours as soon as a tab was opened next to
// its opener here and appended at the end there, so a peer that re-stamped our
// state with its own clock would publish it as its news — and applied here, a
// tab opened in the meantime would be closed by our own state arriving back
// without it. (SPEC.md, "Approaches that failed", has the timestamp-matching
// design this replaced.)
//
// Documents carry {origin, version}. A document whose origin is this device
// is skipped outright, whatever its content or timestamp (§1, §2). A peer
// genuinely putting itself onto that same state is a new origination under the
// peer's own name and a higher version, and applies normally (§3, §4). A
// document without provenance is not a sync document and is ignored (§5).
const { createEnv, ok, done } = require("./harness");

const env = createEnv({
  tabs: [{ id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true }],
});
const WORK = env.WS.WORK;

const A = "https://a.example/";
const FIRST = "https://wiki.example/";
const SECOND = "https://wiki.example/title/Installation_guide";
const now = () => Date.now() / 1000;

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work"] });
  await W.reconcile("Work"); // seeds the baseline, as the first reconcile of a session does

  const ownDoc = () => JSON.parse(env.noteByTitle("Work-boxA.json").content);
  const ownUrls = () => ownDoc().items.map((i) => i.url).join(",");
  // A note write sleeps inside the 5s per-note throttle and is re-armed rather
  // than queued, so "the write landed" is a poll, not a fixed sleep.
  const awaitPublished = async (urls) => {
    for (let i = 0; i < 60 && ownUrls() !== urls; i++) await env.sleep(250);
    return ownDoc();
  };
  const peer = (origin, version, urls, tsOffset) => ({
    workspace: "Work",
    origin,
    version,
    timestamp: now() + tsOffset,
    items: urls.map((u) => ({ type: "tab", url: u, title: u, pinned: false })),
  });

  // ===========================================================================
  // 1. The echo is not applied — even re-ordered and freshly stamped.
  // ===========================================================================
  await W.writeNow();
  await awaitPublished(A);
  ok("1pre. the device has published a state of its own", ownUrls() === A, ownUrls());
  ok("1pre2. ...carrying its own provenance",
     ownDoc().origin === "boxA" && ownDoc().version >= 1,
     `origin ${ownDoc().origin} version ${ownDoc().version}`);

  // The user navigates. This device originates the address. (The harness's
  // addTab fires no tabs.onCreated, so the write the event would arm is forced.)
  env.addTab({ id: 12, url: FIRST, ws: WORK });
  await W.writeNow();
  await awaitPublished([A, FIRST].join(","));
  const vFirst = ownDoc().version;

  // The peer adopts it and mirrors it back — in the OTHER order (its browser
  // appended the new tab at the end), with a timestamp newer than anything we
  // have, and still naming us as the origin, which is the one thing that
  // matters. Before provenance this was exactly the document that came back
  // and closed the next tab.
  await env.putPeerDoc("Work-boxB.json", peer("boxA", vFirst, [FIRST, A], 60));

  // ...but the user has already moved on here, before that echo arrives.
  env.closeTab(12);
  env.addTab({ id: 13, url: SECOND, ws: WORK });
  await W.writeNow();
  await awaitPublished([A, SECOND].join(","));
  const vSecond = ownDoc().version;
  ok("1a. a fresh change takes the next version", vSecond === vFirst + 1, `${vFirst} -> ${vSecond}`);

  env.OPS.length = 0;
  const before = JSON.stringify(ownDoc());
  await W.reconcile("Work");
  await env.sleep(6500); // longer than the note throttle: we are asserting absence
  ok("1. a peer's echo of our own state does not reload the tab",
     env.urls(WORK).includes(SECOND) && !env.urls(WORK).includes(FIRST),
     JSON.stringify(env.urls(WORK)));
  ok("2. ...and nothing was closed, reopened or republished for it",
     env.OPS.length === 0 && JSON.stringify(ownDoc()) === before,
     `${env.OPS.length} ops; doc ${before === JSON.stringify(ownDoc()) ? "unchanged" : "CHANGED"}`);

  // The same with an extra tab the peer's browser produced while applying (a
  // redirect target, a tab it could not close). Still our state, still skipped.
  const ARTEFACT = "https://peer-artefact.example/";
  await env.updateNote("Work-boxB.json", peer("boxA", vSecond, [SECOND, A, ARTEFACT], 120));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("2b. an echo carrying the peer's apply artefacts is skipped too",
     !env.urls(WORK).includes(ARTEFACT) && env.OPS.length === 0,
     JSON.stringify(env.urls(WORK)));

  // ===========================================================================
  // 3. A peer genuinely re-originating that same state IS applied.
  // ===========================================================================
  // "This state came from boxA" is true of the echo AND of the user
  // deliberately putting boxB back onto that address. What separates them is
  // who originated the document: the deliberate one is boxB's own, with boxB's
  // next version.
  await env.updateNote("Work-boxB.json", peer("boxB", vSecond + 1, [A, FIRST], 600));
  await W.reconcile("Work");
  ok("3. a peer genuinely re-originating that same state IS applied",
     env.urls(WORK).includes(FIRST) && !env.urls(WORK).includes(SECOND),
     JSON.stringify(env.urls(WORK)));
  // ...and what we publish back is an ACKNOWLEDGEMENT: the peer's provenance,
  // unchanged, so the peer in turn recognises its own state coming back.
  const ackDoc = await awaitPublished([A, FIRST].join(","));
  ok("3b. the republished copy carries the origin's provenance, not ours",
     ackDoc.origin === "boxB" && ackDoc.version === vSecond + 1,
     `origin ${ackDoc.origin} version ${ackDoc.version}`);

  // ===========================================================================
  // 4. And a peer's own, unrelated state is still applied normally.
  // ===========================================================================
  const THEIRS = "https://peer-only.example/";
  await env.updateNote("Work-boxB.json", peer("boxB", vSecond + 2, [A, THEIRS], 900));
  await W.reconcile("Work");
  ok("4. an ordinary remote change is untouched by any of this",
     env.urls(WORK).includes(THEIRS) && !env.urls(WORK).includes(FIRST),
     JSON.stringify(env.urls(WORK)));

  // ===========================================================================
  // 5. A document without provenance is not a sync document, however new.
  // ===========================================================================
  const LEGACY = "https://legacy.example/";
  await env.putPeerDoc("Work-boxC.json", {
    workspace: "Work",
    timestamp: now() + 1200,
    items: [{ type: "tab", url: A, title: A, pinned: false },
            { type: "tab", url: LEGACY, title: LEGACY, pinned: false }],
  });
  await W.reconcile("Work");
  ok("5. a document without origin/version is ignored, however new its timestamp",
     !env.urls(WORK).includes(LEGACY) && env.urls(WORK).includes(THEIRS),
     JSON.stringify(env.urls(WORK)));

  done();
})();
