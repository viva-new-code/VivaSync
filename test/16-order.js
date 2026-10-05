// Tab-bar ORDER is synchronized — and a reorder never becomes a swap.
//
// The document carries the sequence (`items` is the tab-bar order, a stack at
// its first member). Creation order alone reproduces it only on a clean
// restore: a tab already present keeps its place, and a tab appended here sits
// next to its opener there. So the order phase of applyDesired (R2.2.2b) puts
// the workspace's UNITS — an unpinned top-level tab, or a whole stack — into
// the document's sequence with the fewest moves, and the signature compares
// that sequence (an order that were compared but not reproduced would look
// like unpublished local news for ever — invariant 4).
// This file pins:
//   - §1-§2, §10: a peer's order is applied with the minimum number of moves
//     (the units already in increasing order stay put; re-asserting the same
//     order performs nothing);
//   - §3: the user dragging a tab is a change worth publishing — a fresh
//     origination, like a pin;
//   - §4: a tab that arrives at a NEW position is created and then placed;
//   - §5-§6: a stack is created with its members in document order and moves
//     as ONE run, every member in one call;
//   - §7: what is NOT compared and never moved — the pinned strip;
//   - §11: a tab a peer opened from a link is created here and is `loading`,
//     hence `volatile` — an order phase that matched units by URL and skipped
//     volatile ones would leave it at the end of the strip. Identity comes
//     from the create phase;
//   - §12-§14: the order of members INSIDE a stack — a peer's member order
//     applied, a local in-stack drag published, and a member that a move takes
//     out of its stack put back;
//   - §8: a tab no document speaks for (an empty new tab) is never moved and
//     keeps its place;
//   - §9: the rendering is acknowledged under the peer's provenance; the peer
//     never applies it; nothing is published afterwards — no swap.
// Timers: none in the engine's order logic. The waits below are the note
// throttle (5s) and the write debounce, as in every other file.
const { createEnv, ok, done } = require("./harness");

const A = "https://a.example/";
const B = "https://b.example/";
const C = "https://c.example/";
const D = "https://d.example/";
const E = "https://e.example/";
const S1 = "https://s1.example/";
const S2 = "https://s2.example/";
const BLANK = "about:blank";

const env = createEnv({
  tabs: [
    { id: 11, url: A, ws: 1717425015828.0, active: true },
    { id: 12, url: B, ws: 1717425015828.0 },
    { id: 13, url: C, ws: 1717425015828.0 },
    { id: 14, url: D, ws: 1717425015828.0 },
  ],
});
const WORK = env.WS.WORK;
const now = () => Date.now() / 1000;

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work"] });
  await W.reconcile("Work");

  const ownDoc = () => JSON.parse(env.noteByTitle("Work-boxA.json").content);
  const docOrder = () => ownDoc().items.map((i) => (i.type === "stack" ? "[" + (i.name || "?") + ": " + i.tabs.map((t) => t.url).join(", ") + "]" : i.url)).join(" | ");
  const prov = () => `${ownDoc().origin} v${ownDoc().version}`;
  const awaitDoc = async (pred) => {
    for (let i = 0; i < 80 && !pred(); i++) await env.sleep(250);
    return ownDoc();
  };
  const tab = (url, pinned) => ({ type: "tab", url, title: url, pinned: !!pinned });
  const stack = (name, urls) => ({ type: "stack", id: "peer-" + name, name, tabs: urls.map((u) => tab(u)) });
  const peer = (items, version) => ({
    workspace: "Work", origin: "boxB", version, timestamp: now() + version, items,
  });
  const moveOps = () => env.OPS.filter((o) => o.op === "move");
  const idOf = (url) => env.TABS.find((t) => t.url === url).id;

  await W.writeNow();
  await awaitDoc(() => ownDoc().items.length === 4);
  ok("0pre. the document carries the tab-bar order", docOrder() === [A, B, C, D].join(" | "), docOrder());

  // ===========================================================================
  // 1-2. A peer's order is applied with the fewest moves; re-asserting it is free.
  // ===========================================================================
  await env.putPeerDoc("Work-boxB.json", peer([tab(B), tab(A), tab(C), tab(D)], 10));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("1a. the peer's order is rendered here", env.layout(WORK) === [B, A, C, D].join(" | "), env.layout(WORK));
  ok("1b. ...with exactly one move (the other three were already in order)",
     moveOps().length === 1 && moveOps()[0].ids.length === 1 && env.OPS.every((o) => o.op === "move"),
     JSON.stringify(env.OPS));
  await awaitDoc(() => ownDoc().version === 10);
  ok("1c. our copy is the acknowledgement — boxB v10, in the peer's order",
     ownDoc().origin === "boxB" && docOrder() === [B, A, C, D].join(" | "), `${prov()} ${docOrder()}`);

  await env.updateNote("Work-boxB.json", peer([tab(B), tab(A), tab(C), tab(D)], 11));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("2. a document that changes no order performs no move", moveOps().length === 0, JSON.stringify(env.OPS));
  await awaitDoc(() => ownDoc().version === 11);

  // ===========================================================================
  // 3. The user drags a tab: a change like any other, published as our own.
  // ===========================================================================
  env.moveTab(14, 1); // D in front of A: B D A C
  await awaitDoc(() => ownDoc().origin === "boxA");
  ok("3a. a local reorder is published", docOrder() === [B, D, A, C].join(" | "), docOrder());
  ok("3b. ...as a fresh origination out-ranking the state held", ownDoc().version === 12, prov());

  // ===========================================================================
  // 4. A tab that arrives at a NEW position is created, then placed.
  // ===========================================================================
  await env.updateNote("Work-boxB.json", peer([tab(B), tab(D), tab(E), tab(A), tab(C)], 13));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("4a. a new tab from the peer sits where the document puts it, not at the end",
     env.layout(WORK) === [B, D, E, A, C].join(" | "), env.layout(WORK));
  ok("4b. ...created once and moved once",
     env.OPS.filter((o) => o.op === "create").length === 1 && moveOps().length === 1 &&
       moveOps()[0].ids[0] === idOf(E),
     JSON.stringify(env.OPS));
  await awaitDoc(() => ownDoc().version === 13);
  ok("4c. the acknowledgement lists it third", docOrder() === [B, D, E, A, C].join(" | "), docOrder());

  // ===========================================================================
  // 5-6. A stack is created in document order and moves as ONE run.
  // ===========================================================================
  await env.updateNote("Work-boxB.json", peer([stack("Pair", [S1, S2]), tab(B), tab(D), tab(E), tab(A), tab(C)], 14));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("5. a new stack is built with its members in document order and placed at the head",
     env.layout(WORK) === `[Pair: ${S1}, ${S2}] | ${[B, D, E, A, C].join(" | ")}`, env.layout(WORK));
  await awaitDoc(() => ownDoc().version === 14);

  await env.updateNote("Work-boxB.json", peer([tab(B), tab(D), stack("Pair", [S1, S2]), tab(E), tab(A), tab(C)], 15));
  env.OPS.length = 0;
  await W.reconcile("Work");
  const pairIds = [idOf(S1), idOf(S2)];
  ok("6a. a stack moves as one run — one call, both members",
     moveOps().length === 1 && JSON.stringify(moveOps()[0].ids.slice().sort()) === JSON.stringify(pairIds.slice().sort()),
     JSON.stringify(env.OPS));
  ok("6b. ...and lands intact where the document puts it",
     env.layout(WORK) === `${B} | ${D} | [Pair: ${S1}, ${S2}] | ${[E, A, C].join(" | ")}`, env.layout(WORK));
  await awaitDoc(() => ownDoc().version === 15);

  // ===========================================================================
  // 7. Not compared, never moved: the pinned strip.
  // ===========================================================================
  env.pin(12, true); // B
  env.pin(14, true); // D
  await awaitDoc(() => ownDoc().origin === "boxA" && ownDoc().version === 16);
  ok("7a. pinning is published (control: the write path is alive)",
     ownDoc().items.filter((i) => i.pinned).length === 2, docOrder());
  env.moveTab(14, 0); // D in front of B: two pinned tabs swap
  await env.sleep(6500);
  ok("7b. reordering PINNED tabs is not a change (no publish)",
     ownDoc().origin === "boxA" && ownDoc().version === 16, `${prov()} ${env.layout(WORK)}`);

  // ===========================================================================
  // 8. A tab no document speaks for keeps its place and is never moved.
  // ===========================================================================
  const blank = env.addTab({ url: BLANK, ws: WORK });
  env.moveTab(blank.id, env.TABS.find((t) => t.url === E).index); // in the middle of the strip
  await env.updateNote("Work-boxB.json",
    peer([tab(B, true), tab(D, true), tab(C), tab(A), tab(E), stack("Pair", [S1, S2])], 20));
  env.OPS.length = 0;
  await W.reconcile("Work");
  const ranked = () => env.TABS.filter((t) => String(Number(JSON.parse(t.vivExtData).workspaceId)) === String(Number(WORK)))
    .sort((a, b) => a.index - b.index)
    .filter((t) => !t.pinned && t.url !== BLANK)
    .map((t) => (JSON.parse(t.vivExtData).group ? "Pair" : t.url))
    .filter((u, i, arr) => u !== "Pair" || arr[i - 1] !== "Pair")
    .join(" | ");
  ok("8a. the synced units are in the document's order",
     ranked() === [C, A, E, "Pair"].join(" | "), `${ranked()}  (${env.layout(WORK)})`);
  ok("8b. the empty new tab is still here and was never moved",
     env.TABS.some((t) => t.id === blank.id) && !moveOps().some((o) => o.ids.includes(blank.id)),
     JSON.stringify(moveOps()));

  // ===========================================================================
  // 9. Acknowledged, never applied back, nothing more published: no swap.
  // ===========================================================================
  await awaitDoc(() => ownDoc().version === 20);
  ok("9a. the rendering is acknowledged under the peer's provenance",
     ownDoc().origin === "boxB" && ownDoc().version === 20, prov());
  env.OPS.length = 0;
  await W.reconcile("Work");
  await env.sleep(6500);
  ok("9b. a second reconcile moves nothing and publishes nothing",
     moveOps().length === 0 && ownDoc().origin === "boxB" && ownDoc().version === 20,
     `${prov()} ${JSON.stringify(env.OPS)}`);

  // ===========================================================================
  // 10. Fewest moves: a rotation is one move, a reversal at most n-1.
  // ===========================================================================
  await env.updateNote("Work-boxB.json",
    peer([tab(B, true), tab(D, true), tab(A), tab(E), stack("Pair", [S1, S2]), tab(C)], 21));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("10a. rotating four units by one is a single move",
     moveOps().length === 1 && ranked() === [A, E, "Pair", C].join(" | "), `${moveOps().length} move(s): ${ranked()}`);
  await awaitDoc(() => ownDoc().version === 21);
  await env.updateNote("Work-boxB.json",
    peer([tab(B, true), tab(D, true), tab(C), stack("Pair", [S1, S2]), tab(E), tab(A)], 22));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("10b. reversing four units takes at most three moves",
     moveOps().length <= 3 && ranked() === [C, "Pair", E, A].join(" | "), `${moveOps().length} move(s): ${ranked()}`);
  await awaitDoc(() => ownDoc().version === 22);

  // ===========================================================================
  // 11. A tab that is still LOADING is placed, not left behind.
  // ===========================================================================
  // Vivaldi opens a link's "open in new tab" next to the tab it was clicked in,
  // so the peer's document names it in the middle of the sequence. Here it is
  // created (at the end, as every newborn is) and is `loading` — which makes it
  // `volatile`: never closed, not published until it settles. An order phase
  // that matched units by URL and skipped volatile ones would leave the tab at
  // the end of the strip on this device for ever. Held loading for the whole
  // apply to pin it precisely.
  const SPAWNED = "https://spawned.example/";
  env.setLoadLatency(4000);
  await env.updateNote("Work-boxB.json",
    peer([tab(B, true), tab(D, true), tab(C), tab(SPAWNED), stack("Pair", [S1, S2]), tab(E), tab(A)], 23));
  env.OPS.length = 0;
  await W.reconcile("Work");
  const spawned = env.TABS.find((t) => t.url === SPAWNED);
  ok("11a. it really was still loading while the apply ran",
     spawned && spawned.status === "loading", String(spawned && spawned.status));
  ok("11b. a loading newborn is placed where the document puts it, not left at the end",
     ranked() === [C, SPAWNED, "Pair", E, A].join(" | "), `${ranked()}  (${env.layout(WORK)})`);
  env.setLoadLatency(60);
  await awaitDoc(() => ownDoc().version === 23);
  ok("11c. ...and the acknowledgement says so once it has settled",
     ownDoc().origin === "boxB" && docOrder().includes(`${C} | ${SPAWNED} |`), `${prov()} ${docOrder()}`);

  // ===========================================================================
  // 12-14. The order of members INSIDE a stack.
  // ===========================================================================
  // A signature that sorted a stack's members would make neither a drag inside
  // the stack nor a tab opened from a link inside it a change, and nothing
  // would reproduce the order on the peer.
  const inStack = () => (env.stacks(WORK).find((s2) => s2.name === "Pair") || { urls: [] }).urls.join(" > ");
  const docMembers = () => {
    const st = ownDoc().items.find((i) => i.type === "stack" && i.name === "Pair");
    return st ? st.tabs.map((t) => t.url).join(" > ") : "";
  };
  ok("12pre. the pair is in document order", inStack() === `${S1} > ${S2}`, inStack());
  await env.updateNote("Work-boxB.json",
    peer([tab(B, true), tab(D, true), tab(C), tab(SPAWNED), stack("Pair", [S2, S1]), tab(E), tab(A)], 24));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("12a. a peer's member order is applied inside the stack",
     inStack() === `${S2} > ${S1}`, `${inStack()}  ops=${JSON.stringify(moveOps())}`);
  ok("12b. ...with one move, and the members stay in the stack",
     moveOps().length === 1 && env.stacks(WORK).find((s2) => s2.name === "Pair").urls.length === 2,
     JSON.stringify(env.OPS));
  await awaitDoc(() => ownDoc().version === 24);
  ok("12c. the acknowledgement carries that member order",
     docMembers() === `${S2} > ${S1}` && ownDoc().origin === "boxB", `${prov()} ${docMembers()}`);

  // A drag inside the stack is a change worth publishing, like any other.
  env.moveTab(idOf(S1), env.TABS.find((t) => t.url === S2).index);
  await awaitDoc(() => ownDoc().origin === "boxA");
  ok("13. reordering members locally is published as a fresh origination",
     docMembers() === `${S1} > ${S2}` && ownDoc().version === 25, `${prov()} ${docMembers()}`);

  // A tab opened from a link INSIDE a stack joins next to its opener there and
  // is a member in the middle of the document's member list here.
  const INNER = "https://inner.example/";
  await env.updateNote("Work-boxB.json",
    peer([tab(B, true), tab(D, true), tab(C), tab(SPAWNED), stack("Pair", [S1, INNER, S2]), tab(E), tab(A)], 26));
  await W.reconcile("Work");
  ok("14. a new member arrives in the middle of the stack, not at its end",
     inStack() === `${S1} > ${INNER} > ${S2}`, inStack());
  await awaitDoc(() => ownDoc().version === 26);

  ok("no errors logged during the run", env.consoleErrors.length === 0, env.consoleErrors.join(" | ") || "clean");
  done();
})();
