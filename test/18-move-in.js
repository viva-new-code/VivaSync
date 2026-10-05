// Tabs MOVED into a synced workspace that has a peer's newer state waiting.
//
// The scenario: Shared is synced between two machines. On one of them the user
// sits in another workspace while the other machine changes Shared — nothing
// arrives yet, by design (invariant 5: only the active workspace is applied).
// The user then selects tabs, or a whole stack, and picks "Move to workspace →
// Shared". Vivaldi switches into Shared, the switch pulls the peer's pending
// state, and a plain whole-document apply would close everything the peer's
// document does not list — the moved tabs, which no document lists yet.
// Without a pending state the same move is harmless, because nothing is
// applied over it.
//
// The engine merges instead of overwriting: the remote, plus whatever is here that
// this device's last document did not list, less (within a session) what the
// user closed here — published as this device's next version, so the peer
// adopts it and neither side's work is lost. And a workspace that is not
// showing does not publish a change over a peer state it has not merged yet.
//
//   1. First open of the session: loose tabs moved in survive the pending pull,
//      and the peer's own change is applied too.
//   2. Already opened this session: a whole STACK moved in (name and colour
//      intact), while the workspace was inactive — the write is held, then
//      merged on open. The peer's close is honoured; a tab closed here while
//      the workspace was not showing is not reopened.
//   3. The merged state is this device's news, numbered above the peer's, and
//      nothing is applied back or republished after it.
//   4. The real browser's ORDER of events: the move's tab events fire the
//      write before the switch into the target is handled. A hold keyed on the
//      browser's active workspace would let that write go out — the pre-merge
//      state, stamped newer than the peer's — and the switch would then find
//      nothing to apply: the moved tabs survive, the peer's change does not.
//   5. No switch seen at all: a hold keyed on the switch being handled would
//      not apply, and the move would go out numbered equal to the peer's
//      state, which had added a tab — the peer adopts ours and loses its tab.
//      Modelled directly: the active workspace, an unpublished local change,
//      and a peer state numbered above ours arriving before the write. The
//      hold is keyed on provenance alone (peerAhead).
const { createEnv, ok, done } = require("./harness");

const WORK = 1717425015828.0;
const PERSONAL = 1783536779848.0;
const A = "https://a.example/";
const B = "https://b.example/";
const C = "https://c.example/";
const P1 = "https://p1.example/";
const S1 = "https://s1.example/";
const S2 = "https://s2.example/";
const P2 = "https://p2.example/";
const D = "https://d.example/";
const E = "https://e.example/";
const F = "https://f.example/";
const env = createEnv({
  tabs: [
    { id: 11, url: A, ws: WORK },
    { id: 90, url: "https://personal.example/", ws: PERSONAL, active: true },
    { id: 91, url: P1, ws: PERSONAL },
    { id: 92, url: S1, ws: PERSONAL, group: "g-moved", stackName: "Moved", stackColor: "color4" },
    { id: 93, url: S2, ws: PERSONAL, group: "g-moved", stackName: "Moved", stackColor: "color4" },
    { id: 94, url: P2, ws: PERSONAL },
  ],
});

const tab = (u) => ({ type: "tab", url: u, title: u, pinned: false });
const doc = (origin, version, items, ts) => ({ workspace: "Work", origin, version, timestamp: ts, items });
const now = () => Date.now() / 1000;

(async () => {
  const W = await env.boot();
  // Work was published by this device in an earlier session: [A] at v5.
  await env.putPeerDoc("Work-boxA.json", doc("boxA", 5, [tab(A)], now() - 600));
  await env.setConfig({ workspaces: ["Work"] });
  const ownDoc = () => JSON.parse(env.noteByTitle("Work-boxA.json").content);
  const ownUrls = (d = ownDoc()) =>
    d.items.flatMap((i) => (i.type === "stack" ? i.tabs.map((x) => x.url) : [i.url])).sort().join(",");
  const awaitDoc = async (pred) => {
    for (let i = 0; i < 80 && !pred(ownDoc()); i++) await env.sleep(250);
    return ownDoc();
  };
  const has = (u) => env.urls(WORK).includes(u);

  // ===========================================================================
  // 1. First open of the session, loose tabs moved in.
  // ===========================================================================
  // The peer added B while this device sat in Personal.
  await env.putPeerDoc("Work-boxB.json", doc("boxB", 6, [tab(A), tab(B)], now()));
  await env.sleep(1500); // the note event: Work is not active, nothing applies
  ok("1pre. the peer's state waits while Work is not showing", !has(B), env.layout(WORK));

  env.moveToWorkspace([91], WORK);
  await env.switchWorkspace(WORK, 2500);
  ok("1a. the moved tab survives the pull", has(P1), env.layout(WORK));
  ok("1b. ...and the peer's change is applied too", has(B) && has(A), env.layout(WORK));
  const d1 = await awaitDoc((d) => d.version > 6);
  ok("1c. the merge is published as this device's next version",
     d1.origin === "boxA" && d1.version === 7 && ownUrls(d1) === [A, B, P1].sort().join(","),
     `${d1.origin} v${d1.version}: ${ownUrls(d1)}`);

  // ===========================================================================
  // 2. Opened this session already: a stack moved in while Work is inactive.
  // ===========================================================================
  await env.switchWorkspace(PERSONAL, 1500);
  // The peer adopted v7 and then closed B and added C: v8.
  await env.updateNote("Work-boxB.json", doc("boxB", 8, [tab(A), tab(P1), tab(C)], now()));
  await env.sleep(1500);
  env.closeTab(91); // P1, closed here while Work is not showing
  env.moveToWorkspace([92, 93], WORK);
  await env.sleep(2500); // a write is armed for the inactive Work...
  ok("2pre. ...and held: nothing is published over a peer state not yet merged",
     ownDoc().version === 7, `${ownDoc().origin} v${ownDoc().version}: ${ownUrls()}`);

  const before = env.OPS.length;
  await env.switchWorkspace(WORK, 3000);
  const st = env.stacks(WORK).find((s) => s.name === "Moved");
  ok("2a. the moved stack survives the pull, still a stack, name and colour intact",
     !!st && st.gid === "g-moved" && st.color === "color4" && st.urls.join(",") === [S1, S2].join(","),
     env.layout(WORK));
  ok("2b. the peer's close and addition are applied", !has(B) && has(C), env.layout(WORK));
  ok("2c. the tab closed here is not reopened", !has(P1), env.layout(WORK));
  ok("2d. the stack is not rebuilt — kept where the move put it",
     !env.OPS.slice(before).some((o) => /stack|create/.test(o.op) &&
       (o.tabIds || []).some((id) => id === 92 || id === 93)),
     JSON.stringify(env.OPS.slice(before)));

  // ===========================================================================
  // 3. Published as this device's news, and that is the end of it.
  // ===========================================================================
  const d2 = await awaitDoc((d) => d.version > 8);
  const pubStack = d2.items.find((i) => i.type === "stack");
  ok("3a. the merge goes out as boxA v9: the peer's state plus the stack",
     d2.origin === "boxA" && d2.version === 9 && ownUrls(d2) === [A, C, S1, S2].sort().join(",") &&
       pubStack && pubStack.name === "Moved" && pubStack.color === "color4",
     `${d2.origin} v${d2.version}: ${JSON.stringify(d2.items)}`);
  await env.sleep(6000); // past the note throttle: anything further would show
  ok("3b. nothing is applied back or published after it",
     ownDoc().version === 9 && env.layout(WORK) === `${A} | ${C} | [Moved#color4: ${S1}, ${S2}]`,
     `v${ownDoc().version}; ${env.layout(WORK)}`);

  // ===========================================================================
  // 4. The move's write fires BEFORE the switch is handled.
  // ===========================================================================
  // A switch debounce longer than the write debounce puts the events in the
  // order the real browser produces.
  await env.setConfig({ workspaces: ["Work"], settings: { switchDebounceMs: 1500 } });
  await env.switchWorkspace(PERSONAL, 2500);
  await env.updateNote("Work-boxB.json", doc("boxB", 10, [
    tab(A), tab(C), tab(D),
    { type: "stack", id: "x", name: "Moved", color: "color4", pinned: false, tabs: [tab(S1), tab(S2)] },
  ], now()));
  await env.sleep(6000); // the note event, and past the note throttle
  env.moveToWorkspace([94], WORK);
  await env.switchWorkspace(WORK, 5000);
  ok("4a. the moved tab survives", has(P2), env.layout(WORK));
  ok("4b. ...and the peer's change is applied too", has(D), env.layout(WORK));
  const d4 = await awaitDoc((d) => d.version > 10);
  ok("4c. the merge goes out above the peer's version",
     d4.origin === "boxA" && d4.version === 11 && ownUrls(d4) === [A, C, D, P2, S1, S2].sort().join(","),
     `${d4.origin} v${d4.version}: ${ownUrls(d4)}`);

  // ===========================================================================
  // 5. A newer peer state and an unpublished local change, no switch involved.
  // ===========================================================================
  await env.sleep(6000); // past the note throttle
  const held = ownDoc();
  env.addTab({ id: 95, url: E, ws: WORK }); // the local change, not yet published
  await env.updateNote("Work-boxB.json", doc("boxB", held.version + 1, [
    ...held.items, tab(F),
  ], now()));
  await W.writeNow();
  await env.sleep(3000);
  ok("5a. both changes are here: ours and the peer's", has(E) && has(F), env.layout(WORK));
  const d5 = await awaitDoc((d) => d.version > held.version + 1);
  ok("5b. the merge is published above the peer's version, never beside it",
     d5.origin === "boxA" && d5.version === held.version + 2 &&
       ownUrls(d5).includes(E) && ownUrls(d5).includes(F),
     `held v${held.version}; published ${d5.origin} v${d5.version}: ${ownUrls(d5)}`);

  done();
})();
