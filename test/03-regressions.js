// Regression scenarios from running two real devices. Each case is a failure
// mode the reconcile invariants exist to prevent (see AGENTS.md, "Reconcile
// invariants"); none of them is caught by the happy-path tests.
//
//   A. ping-pong        - both machines pegged at ~15-20% CPU, for ever
//   B. vanishing tab    - a newly opened tab was closed a second later
//   C. workspace bleed  - another workspace's tab appeared in the synced one
//   D. empty window     - the workspace was momentarily empty mid-reconcile,
//                         which is what caused C
const { createEnv, ok, done } = require("./harness");

const env = createEnv({
  tabs: [
    { id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true },
    { id: 12, url: "https://b.example/", ws: 1717425015828.0 },
    // A tab in a DIFFERENT, non-synced workspace — the user's "Local"/maps tab.
    { id: 90, url: "https://maps.example/", ws: 1783536779848.0, index: 9 },
  ],
});
const WORK = env.WS.WORK;
const PERSONAL = env.WS.PERSONAL;

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work", "Personal"] });
  await W.reconcile("Work");
  await W.writeNow();

  // ===========================================================================
  // A. Applying a remote we already match must not write anything.
  //
  // If reconcile() ended with writeChanged(TRUE) — a forced write — then, once
  // both devices pull on remote change, it would be perpetual motion: A writes,
  // B applies and force-writes a newer doc even though nothing changed, A
  // applies and force-writes, for ever. Each lap costs a full notes read, a note write
  // and a sync push. Signature-gating the write terminates the exchange.
  // ===========================================================================
  const ts0 = JSON.parse(env.noteByTitle("Work-boxA.json").content).timestamp;
  await env.putPeerDoc("Work-boxB.json", {
    workspace: "Work",
    origin: "boxB",
    version: 1,
    timestamp: Date.now() / 1000 + 60,
    items: [
      { type: "tab", url: "https://a.example/", title: "A", pinned: false },
      { type: "tab", url: "https://b.example/", title: "B", pinned: false },
    ],
  });
  await W.reconcile("Work");
  await env.sleep(1200);
  const ts1 = JSON.parse(env.noteByTitle("Work-boxA.json").content).timestamp;
  ok("A. applying an already-matching remote writes nothing (ping-pong ends)",
     ts1 === ts0, `timestamp ${ts0} -> ${ts1}`);

  // ===========================================================================
  // B. A tab the user just opened must survive an incoming peer document.
  //
  // Reconcile is newest-wins whole-document: anything absent from the remote is
  // closed. A brand-new tab is by definition absent from every peer's document,
  // so pulling before our own write goes out would delete it under the user's
  // cursor. The pull is deferred while local changes are unpublished.
  // ===========================================================================
  env.addTab({ id: 77, url: "https://brand-new-tab.example/", ws: WORK });
  // Version 2 out-ranks what we hold (v1) at the moment it arrives, so only
  // the deferral keeps it from being applied; it is stamped OLDER than our
  // clock, so once our v2 is out the retried pull leaves tab 77 alone too.
  await env.updateNote("Work-boxB.json", {
    workspace: "Work",
    origin: "boxB",
    version: 2,
    timestamp: Date.now() / 1000 - 100,
    items: [
      { type: "tab", url: "https://a.example/", title: "A", pinned: false },
      { type: "tab", url: "https://b.example/", title: "B", pinned: false },
    ],
  });
  await env.sleep(2000); // let the change-event path run
  ok("B. an unpublished new tab survives an incoming peer document",
     env.TABS.some((t) => t.id === 77), JSON.stringify(env.urls(WORK)));

  // ===========================================================================
  // C. Reconciling a workspace that is not active must be refused.
  //
  // createTab relies on new tabs auto-joining the ACTIVE workspace, so
  // reconciling an inactive one creates its tabs in whatever IS active while
  // deleting from the target — corrupting two workspaces at once.
  // ===========================================================================
  await W.writeNow(); // publish, so the B-guard is not what blocks us here
  await env.putPeerDoc("Personal-boxB.json", {
    workspace: "Personal",
    origin: "boxB",
    version: 1,
    timestamp: Date.now() / 1000 + 400,
    items: [{ type: "tab", url: "https://should-not-be-created.example/", title: "X", pinned: false }],
  });
  const countBefore = env.TABS.length;
  await W.reconcile("Personal"); // Personal is NOT active — active tab is in Work
  ok("C. reconciling a non-active workspace creates nothing",
     !env.TABS.some((t) => t.url === "https://should-not-be-created.example/") &&
       env.TABS.length === countBefore,
     `tab count ${countBefore} -> ${env.TABS.length}`);
  ok("C2. the other workspace's own tab is untouched",
     env.TABS.some((t) => t.id === 90), JSON.stringify(env.urls(PERSONAL)));
  // The refusal must happen before any state changes: publishing a document for
  // a workspace we never reconciled would leak an unmaterialized (possibly
  // empty) snapshot to the peers, and recording its remote timestamp would mean
  // the document we skipped is never applied later either.
  ok("C3. nothing is published for the refused workspace",
     !env.noteByTitle("Personal-boxA.json"), JSON.stringify(env.noteTitles()));
  ok("C4. the skipped remote is still pending, not marked as applied",
     !W.config().opened.includes("Personal"), JSON.stringify(W.config().opened));

  // ===========================================================================
  // D. Creates must precede deletes.
  //
  // If the delete phase empties the workspace even for an instant, Vivaldi
  // activates a neighbouring workspace's tab. activeWorkspaceId() is derived
  // from the active tab, so the mod's notion of "active workspace" silently
  // flips mid-reconcile while the selector still shows the original — which is
  // how a Local tab ended up displayed inside Shared.
  // ===========================================================================
  env.OPS.length = 0;
  await env.updateNote("Work-boxB.json", {
    workspace: "Work",
    origin: "boxB",
    version: 3,
    timestamp: Date.now() / 1000 + 900,
    items: [
      { type: "tab", url: "https://fresh1.example/", title: "F1", pinned: false },
      { type: "tab", url: "https://fresh2.example/", title: "F2", pinned: false },
    ],
  });
  await W.reconcile("Work");
  const firstRemove = env.OPS.findIndex((o) => o.op === "remove");
  const lastCreate = env.OPS.map((o) => o.op === "create").lastIndexOf(true);
  ok("D. every create happens before any delete (workspace never empties)",
     firstRemove === -1 || lastCreate < firstRemove,
     env.OPS.map((o) => (o.op === "create" ? "create" : "remove x" + o.ids.length)).join(" | "));
  ok("D2. and it still converges to the remote",
     JSON.stringify(env.urls(WORK)) === JSON.stringify(["https://fresh1.example/", "https://fresh2.example/"]),
     JSON.stringify(env.urls(WORK)));
  ok("D3. every tab created landed in the target workspace",
     env.OPS.filter((o) => o.op === "create").every((o) => Number(o.ws) === Number(WORK)),
     JSON.stringify(env.OPS.filter((o) => o.op === "create").map((o) => o.ws)));

  // ===========================================================================
  // E. An adopted state must not be re-stamped as this device's own.
  //
  // A is the case where nothing changed. This is the case where something DID:
  // we adopt a peer's document, so our live state differs from the last one we
  // wrote and the signature gate correctly lets a write through. Publishing
  // that as OUR news republishes the peer's own state back at it as something
  // newer — and if the peer meanwhile has a state of its own, the two swap for
  // ever, because each lap refreshes the provenance of both and "newest" never
  // settles on one document. The write is an ACKNOWLEDGEMENT instead: the
  // origin's name, version and timestamp, unchanged.
  //
  // Field report: a site that rewrites its own URL as you type (Google
  // Translate). A half-typed word reached the peer, the finished word was
  // published here, and the two spellings replaced each other on both machines
  // without end. The rule that terminates it: only the device that ORIGINATED a
  // state advances its timestamp.
  // ===========================================================================
  // A note write sleeps inside the 5s per-note throttle, so "the write landed"
  // is a poll, not a fixed sleep. Absence still has to be waited out in full.
  const ownDoc = () => JSON.parse(env.noteByTitle("Work-boxA.json").content);
  const ownTs = () => ownDoc().timestamp;
  const ownUrls = () => ownDoc().items.map((i) => i.url).join(",");
  // Wait for OUR note to carry a given state. Not "wait for any change": a
  // write from the previous case can still be asleep in the throttle holding an
  // older snapshot, and it lands first.
  const awaitPublished = async (urls) => {
    for (let i = 0; i < 60 && ownUrls() !== urls; i++) await env.sleep(250);
    return ownDoc();
  };

  const HALF = "https://translate.example/?text=si";
  const WHOLE = "https://translate.example/?text=sixty";
  const tHalf = Date.now() / 1000 + 1800;
  await env.updateNote("Work-boxB.json", {
    workspace: "Work",
    origin: "boxB",
    version: 4,
    timestamp: tHalf,
    items: [{ type: "tab", url: HALF, title: "si", pinned: false }],
  });
  await W.reconcile("Work");
  const docE = await awaitPublished(HALF);
  ok("E. the adopted state is published under the ORIGIN's provenance, not ours",
     docE.timestamp === tHalf && docE.origin === "boxB" && docE.version === 4,
     `${docE.origin} v${docE.version} @${docE.timestamp} vs origin boxB v4 @${tHalf}; items ${ownUrls()}`);
  ok("E2. ...and it really is the adopted content",
     JSON.stringify(env.urls(WORK)) === JSON.stringify([HALF]), JSON.stringify(env.urls(WORK)));

  // The peer now holds what we published a moment ago and originates the
  // finished word. Ours must lose to it — and, once applied, must not come
  // back: with nobody re-stamping, the newest document in the folder stops
  // moving and both devices sit on it.
  const tWhole = tHalf + 1;
  await env.updateNote("Work-boxB.json", {
    workspace: "Work",
    origin: "boxB",
    version: 5,
    timestamp: tWhole,
    items: [{ type: "tab", url: WHOLE, title: "sixty", pinned: false }],
  });
  await W.reconcile("Work");
  await awaitPublished(WHOLE);
  ok("E3. a newer origin still wins",
     JSON.stringify(env.urls(WORK)) === JSON.stringify([WHOLE]), JSON.stringify(env.urls(WORK)));
  // Replay the older document — this is the peer echoing back what it adopted
  // from us earlier. Un-restamped, it can no longer out-rank the finished word,
  // so the exchange has a fixed point instead of swapping the two for ever.
  env.OPS.length = 0;
  const tsBefore = ownTs();
  await env.putPeerDoc("Work-boxC.json", {
    workspace: "Work",
    origin: "boxB",
    version: 4,
    timestamp: tHalf,
    items: [{ type: "tab", url: HALF, title: "si", pinned: false }],
  });
  await W.reconcile("Work");
  await env.sleep(6500); // longer than the note throttle: we are asserting absence
  ok("E4. the older state cannot take the tab back (no ping-pong)",
     JSON.stringify(env.urls(WORK)) === JSON.stringify([WHOLE]), JSON.stringify(env.urls(WORK)));
  ok("E5. and nothing was rewritten or reopened for it",
     env.OPS.length === 0 && ownTs() === tsBefore,
     `${env.OPS.length} ops; timestamp ${tsBefore} -> ${ownTs()}`);

  // ===========================================================================
  // F. A write held back by the note throttle must publish the state it LANDS
  //    with, not the state it was armed with.
  //
  // Each note write is throttled to minNoteWriteGapMs, and the wait happens
  // inside NOTES.write — after writeChanged has taken its snapshot, and before
  // the payload is stamped. A write QUEUED while the throttle is closed would
  // publish a state up to five seconds out of date under a brand-new timestamp:
  // the newest document in the folder would describe tabs this device no longer
  // has. The peer adopts them, we adopt them back, and the two trade a state
  // neither is in — the same endless swap as E, entered from the write side
  // instead of the read side. A throttled write is therefore re-armed and
  // re-snapshotted rather than queued.
  // ===========================================================================
  const ONE = "https://slow-one.example/";
  const TWO = "https://slow-two.example/";
  const THREE = "https://slow-three.example/";
  env.addTab({ id: 78, url: ONE, ws: WORK });
  await W.writeNow(); // lands immediately, and closes the throttle behind it
  env.addTab({ id: 79, url: TWO, ws: WORK });
  await W.writeNow(); // armed inside the throttle window — cannot land yet
  await env.sleep(1500);
  env.addTab({ id: 80, url: THREE, ws: WORK }); // ...and the state moves on again
  const docF = await awaitPublished([WHOLE, ONE, TWO, THREE].join(","));
  ok("F. a throttled write publishes the state at landing, not at arming",
     docF.items.map((i) => i.url).join(",") === [WHOLE, ONE, TWO, THREE].join(","),
     ownUrls());

  done();
})();
