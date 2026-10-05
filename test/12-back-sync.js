// Back-sync from the originator's side, end to end, and the two gaps next to
// it.
//
// The failure mode: a change made on one machine reaches the other and comes
// straight back "as if the change had been made there", overwriting whatever
// had been done here since — up to and including a freshly opened tab
// vanishing. Provenance prevents it (see 11-echo.js for the rule itself); this
// file drives it through the paths a real pair of devices takes:
//
//   1. the echo arrives through the NOTE EVENT, not a manual reconcile, after
//      a further change has already been published here;
//   2. two devices originate concurrently: both must resolve it the same way,
//      by comparing the other's provenance against what they hold — not swap;
//   3. a pull deferred for unpublished local changes (invariant 4) is retried
//      once the write lands, instead of waiting for the next unrelated event;
//   4. the invariant 4 check also covers the workspace-SWITCH path, so a remote
//      is not applied over a tab opened just before switching away.
const { createEnv, ok, done } = require("./harness");

const env = createEnv({
  tabs: [
    { id: 11, url: "https://a.example/", ws: 1717425015828.0, active: true },
    { id: 90, url: "https://personal.example/", ws: 1783536779848.0 },
  ],
});
const WORK = env.WS.WORK;
const PERSONAL = env.WS.PERSONAL;

const A = "https://a.example/";
const X = "https://x.example/";
const Y = "https://y.example/";
const Z = "https://z.example/";
const now = () => Date.now() / 1000;
const item = (u) => ({ type: "tab", url: u, title: u, pinned: false });
const peer = (origin, version, urls, ts) => ({
  workspace: "Work", origin, version, timestamp: ts, items: urls.map(item),
});

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work", "Personal"] });
  await W.reconcile("Work");

  const ownDoc = () => JSON.parse(env.noteByTitle("Work-boxA.json").content);
  const ownUrls = () => ownDoc().items.map((i) => i.url).sort().join(",");
  const awaitPublished = async (urls) => {
    const want = urls.slice().sort().join(",");
    for (let i = 0; i < 60 && ownUrls() !== want; i++) await env.sleep(250);
    return ownDoc();
  };
  const has = (u) => env.urls(WORK).includes(u);

  // ===========================================================================
  // 1. The echo arrives through the note event after a further change.
  // ===========================================================================
  await W.writeNow();
  await awaitPublished([A]);
  // The harness's addTab fires no tabs.onCreated, so each change is followed by
  // the write the real event would have armed.
  env.addTab({ id: 12, url: X, ws: WORK });
  await W.writeNow();
  const docX = await awaitPublished([A, X]);
  env.addTab({ id: 13, url: Y, ws: WORK });
  await W.writeNow();
  const docY = await awaitPublished([A, X, Y]);
  ok("1pre. both changes went out under this device's name, in order",
     docX.origin === "boxA" && docY.origin === "boxA" && docY.version === docX.version + 1,
     `v${docX.version} then v${docY.version}`);

  // The peer's copy of the X-state: appended at the end, freshly stamped,
  // lacking Y — and it lands as a NOTE EVENT, the way Vivaldi Sync delivers it.
  await env.putPeerDoc("Work-boxB.json", peer("boxA", docX.version, [X, A], now() + 60));
  await env.sleep(2500); // remote debounce + reconcile
  ok("1. the echo of our own earlier state does not close the newer tab",
     has(Y) && has(X), JSON.stringify(env.urls(WORK)));
  ok("1b. ...and our document was not touched by it",
     JSON.stringify(ownDoc()) === JSON.stringify(docY), "");

  // ===========================================================================
  // 2. Concurrent originations resolve the same way on both sides.
  // ===========================================================================
  // Each device compares the other's provenance against what IT holds. Equal
  // versions are a genuine tie, broken by timestamp — the same comparison on
  // both machines, so exactly one of them yields and they converge rather than
  // swap states.
  const held = docY;
  await env.updateNote("Work-boxB.json", peer("boxB", held.version, [A, Z], held.timestamp - 30));
  await W.reconcile("Work");
  ok("2. a concurrent origination that loses the tie-break is not applied",
     has(X) && has(Y) && !has(Z), JSON.stringify(env.urls(WORK)));
  await env.updateNote("Work-boxB.json", peer("boxB", held.version, [A, Z], held.timestamp + 30));
  await W.reconcile("Work");
  ok("2b. ...and one that wins it is",
     has(Z) && !has(X) && !has(Y), JSON.stringify(env.urls(WORK)));
  const ack = await awaitPublished([A, Z]);
  ok("2c. the yielding side acknowledges under the winner's provenance",
     ack.origin === "boxB" && ack.version === held.version, `${ack.origin} v${ack.version}`);

  // ===========================================================================
  // 3. A deferred pull is retried once the local write lands.
  // ===========================================================================
  // The user opens a tab; before it is published, a peer document arrives.
  // Invariant 4 defers the pull. The write goes out; the pull must then happen
  // on its own — before this it waited for the next note event, and if none
  // came the device stayed one document behind indefinitely.
  await env.sleep(5200); // open the note throttle...
  await W.writeNow();     // ...and close it again, so the next write is held ~5s
  const NEW = "https://new-here.example/";
  const FROM_PEER = "https://from-peer.example/";
  env.addTab({ id: 14, url: NEW, ws: WORK });
  await W.writeNow(); // re-armed behind the throttle, as a real tab event would be
  // Versioned above what we hold, so it wins the retry outright.
  await env.putPeerDoc("Work-boxC.json", peer("boxC", held.version + 5, [A, Z, FROM_PEER], now() + 120));
  await env.sleep(1600); // the remote debounce fires: deferred, nothing applied yet
  ok("3. the pull is deferred while the new tab is unpublished",
     has(NEW) && !has(FROM_PEER), JSON.stringify(env.urls(WORK)));
  for (let i = 0; i < 40 && !has(FROM_PEER); i++) await env.sleep(250);
  ok("3b. ...and retried by the write itself, with no further note event",
     has(FROM_PEER), JSON.stringify(env.urls(WORK)));

  // ===========================================================================
  // 4. The switch-into-workspace path honours invariant 4 too.
  // ===========================================================================
  await awaitPublished([A, Z, FROM_PEER]);
  await env.switchWorkspace(PERSONAL);
  const KEEP = "https://opened-before-switching.example/";
  // Close the note throttle, as §3 does, so the tab below stays unpublished
  // (§3 merges before it publishes, so its write lands too early to do that).
  await env.sleep(5200);
  await W.writeNow();
  env.addTab({ id: 15, url: KEEP, ws: WORK }); // opened in Work, not yet published
  await W.writeNow(); // held by the throttle closed just above
  const cur = ownDoc();
  // A peer state that would win an ordinary comparison against the held one
  // (same version, newer stamp) but not against what we publish next.
  await env.updateNote("Work-boxC.json", peer("boxC", cur.version, [A, Z], cur.timestamp + 30));
  await env.switchWorkspace(WORK);
  ok("4. switching back in does not apply the remote over the unpublished tab",
     has(KEEP), JSON.stringify(env.urls(WORK)));
  const pub = await awaitPublished([A, Z, FROM_PEER, KEEP]);
  await env.sleep(2500); // the deferred pull retries here; the remote is older now
  ok("4b. the tab is published under the next version and survives the retried pull",
     has(KEEP) && pub.origin === "boxA" && pub.version === cur.version + 1,
     `${pub.origin} v${pub.version} (held v${cur.version}); ${JSON.stringify(env.urls(WORK))}`);

  done();
})();
