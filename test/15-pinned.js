// A pinned tab must arrive pinned — and a pin must not swap machines for ever.
//
// `pinned` was in the payload from the first version — buildSnapshot writes it,
// itemsOf reads it back, every document carries it — and it was honoured in
// exactly one place: createTab. Tab identity is (container, normUrl), so a tab
// whose only difference from the desired document is its pin state is ALREADY
// present: the create phase counts it satisfied, the delete phase has no claim
// on it, and nothing else in applyDesired touched a tab that is where it
// belongs. The flag synced perfectly and the pin did not.
//
// Three halves, and this file pins them all:
//   - the READ side (§1-§5, §7): a peer's pin state is applied here, in place,
//     after every move, and a pinned tab that arrives at a NEW url is created
//     pinned and never moved.
//   - the WRITE side (§6): pinning a tab is a change like any other — `pinned`
//     is in the signature — published as a fresh origination.
//   - a PINNED TAB IS NEVER A STACK MEMBER (§8, §11, §12): Vivaldi drops a
//     newborn into the active tab's stack pinned or not (a pinned tab
//     arriving while the user sits in a stack becomes that stack's first
//     member, and the device's document would then tell the peer to do the
//     same). The engine takes such a tab out before grouping, never publishes
//     a pinned tab as a member, hoists a member a document claims is pinned,
//     and repairs a workspace already left in that state.
//   - a STACK IS PINNED AS A WHOLE (§13-§17): Vivaldi pins a tab stack as a
//     unit and it stays a stack in the pinned strip. A stack carries its own
//     `pinned` and its members repeat it; a group whose members disagree is
//     the broken case above. Applied in place in both directions, built and
//     then pinned when its tabs are new here, published as a fresh origination
//     when the user does it, and rebuilt if pinning the members one at a time
//     takes the group apart.
//   - the SWAP (§8-§10): without provenance, a pin the browser declines would
//     become an endless swap (the refused device publishes its unpinned view
//     as news, the peer applies, is refused the other way, publishes back).
//     Under invariant 2 the write after an apply is an acknowledgement under
//     the peer's origin
//     whatever the browser made of the apply, and a device never applies its
//     own origin — so a refusal costs one acknowledgement, never a lap, and
//     the flag can stay in the signature. This file runs that scenario on a
//     build that refuses to pin at all.
const { createEnv, ok, done } = require("./harness");

const ONE = "https://one.example/";
const TWO = "https://two.example/";
const THREE = "https://three.example/";
const S1 = "https://s1.example/";
const S2 = "https://s2.example/";

const env = createEnv({
  tabs: [
    { id: 11, url: ONE, ws: 1717425015828.0, active: true },
    { id: 12, url: TWO, ws: 1717425015828.0 },
  ],
});
const WORK = env.WS.WORK;
const now = () => Date.now() / 1000;

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work"] });
  await W.reconcile("Work");

  const ownDoc = () => JSON.parse(env.noteByTitle("Work-boxA.json").content);
  const pinnedOf = (url) => {
    const i = ownDoc().items.find((x) => x.url === url);
    return i ? !!i.pinned : null;
  };
  const prov = () => `${ownDoc().origin} v${ownDoc().version}`;
  // A note write sleeps inside the 5s per-note throttle and is re-armed rather
  // than queued, so "the write landed" is a poll, not a fixed sleep.
  const awaitDoc = async (pred) => {
    for (let i = 0; i < 80 && !pred(); i++) await env.sleep(250);
    return ownDoc();
  };
  const tab = (url, pinned) => ({ type: "tab", url, title: url, pinned: !!pinned });
  const peer = (items, version) => ({
    workspace: "Work", origin: "boxB", version, timestamp: now() + version, items,
  });

  await W.writeNow();
  await awaitDoc(() => ownDoc().items.length === 2);
  ok("0pre. both tabs are published, neither pinned",
     pinnedOf(ONE) === false && pinnedOf(TWO) === false, JSON.stringify(ownDoc().items));

  // ===========================================================================
  // 1-2. A peer's pin is applied to the tab that is already here, in place.
  // ===========================================================================
  await env.putPeerDoc("Work-boxB.json", peer([tab(ONE), tab(TWO, true)], 10));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("1. a tab pinned on a peer becomes pinned here",
     env.pinnedUrls(WORK).join(",") === TWO, JSON.stringify(env.pinnedUrls(WORK)));
  ok("2. ...in place — one pin, and the tab is not closed and reopened",
     env.TABS.some((t) => t.id === 12 && t.url === TWO) &&
       env.OPS.length === 1 && env.OPS[0].op === "pin" && env.OPS[0].id === 12,
     JSON.stringify(env.OPS));

  // ===========================================================================
  // 3. Adopting a pin is acknowledged under the peer's provenance (invariant 2).
  // ===========================================================================
  await awaitDoc(() => pinnedOf(TWO) === true);
  ok("3. our copy of an adopted pin is an acknowledgement — origin boxB, version 10",
     pinnedOf(TWO) === true && ownDoc().origin === "boxB" && ownDoc().version === 10,
     `pinned=${pinnedOf(TWO)} ${prov()}`);

  // ===========================================================================
  // 4. Re-asserting the same pin state is not an operation.
  // ===========================================================================
  await env.updateNote("Work-boxB.json", peer([tab(ONE), tab(TWO, true)], 11));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("4. a document that changes no pin state performs no pin", env.OPS.length === 0, JSON.stringify(env.OPS));
  await awaitDoc(() => ownDoc().version === 11);

  // ===========================================================================
  // 5. Unpinning propagates the same way.
  // ===========================================================================
  await env.updateNote("Work-boxB.json", peer([tab(ONE), tab(TWO, false)], 12));
  await W.reconcile("Work");
  ok("5. unpinning on a peer unpins here", env.pinnedUrls(WORK).length === 0, JSON.stringify(env.pinnedUrls(WORK)));
  await awaitDoc(() => ownDoc().version === 12 && pinnedOf(TWO) === false);

  // ===========================================================================
  // 6. Pinning a tab HERE is a change worth publishing — a fresh origination.
  // ===========================================================================
  env.pin(11, true);
  await awaitDoc(() => pinnedOf(ONE) === true);
  ok("6a. pinning a tab locally is published", pinnedOf(ONE) === true, JSON.stringify(ownDoc().items));
  ok("6b. ...as this device's own change, out-ranking the state it held",
     ownDoc().origin === "boxA" && ownDoc().version === 13, prov());
  // The peer applies it and acknowledges under our origin; that never comes back.
  await env.updateNote("Work-boxB.json",
    { workspace: "Work", origin: "boxA", version: 13, timestamp: ownDoc().timestamp, items: [tab(TWO), tab(ONE, true)] });
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("6c. the peer's acknowledgement of our pin is not applied (own origin)",
     env.OPS.length === 0 && env.pinnedUrls(WORK).join(",") === ONE, JSON.stringify(env.OPS));

  // ===========================================================================
  // 7. A pinned tab that arrives at a NEW url is created pinned, in place.
  // ===========================================================================
  // Identity is (container, normUrl): a new URL is a new tab and its pin is
  // re-established from the document. Created pinned with a create-time
  // workspace, never moved (pinToWorkspace strips the pin in this model).
  const MOVED = "https://one.example/moved";
  await env.updateNote("Work-boxB.json", peer([tab(TWO), tab(MOVED, true)], 14));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("7a. a pinned tab that arrives at a new url is pinned",
     env.pinnedUrls(WORK).join(",") === MOVED, `pinned=${JSON.stringify(env.pinnedUrls(WORK))} of ${JSON.stringify(env.urls(WORK))}`);
  ok("7b. ...created pinned and never moved — no unpin-by-move, no pin op",
     env.OPS.some((o) => o.op === "create" && o.url === MOVED && o.pinned) &&
       !env.OPS.some((o) => o.op === "unpin-by-move" || o.op === "pin"),
     JSON.stringify(env.OPS));
  await awaitDoc(() => pinnedOf(MOVED) === true);
  ok("7c. the acknowledgement lists it pinned under the peer's provenance",
     pinnedOf(MOVED) === true && ownDoc().origin === "boxB" && ownDoc().version === 14, `pinned=${pinnedOf(MOVED)} ${prov()}`);

  // ===========================================================================
  // 8. A stack member the document claims is PINNED is a top-level pinned tab.
  // ===========================================================================
  // Pinning takes a tab out of its stack, so a document listing a pinned member
  // describes a browser state its writer should not have been in — a peer
  // whose pinned newborn was dropped into a stack. Honouring the
  // membership would spread that state; itemsOf hoists the member instead, and
  // the stack of one it leaves behind is a plain tab.
  await env.updateNote("Work-boxB.json", peer([tab(TWO), tab(MOVED, true),
    { type: "stack", id: "peer-gid", name: "Pair", tabs: [tab(S1, true), tab(S2)] }], 15));
  await W.reconcile("Work");
  ok("8a. a pinned member is hoisted: top-level and pinned, no stack built",
     env.stacks(WORK).length === 0 && env.pinnedUrls(WORK).sort().join(",") === [MOVED, S1].sort().join(",") &&
       env.urls(WORK).includes(S2),
     `${env.layout(WORK)} pinned=${JSON.stringify(env.pinnedUrls(WORK))}`);
  await awaitDoc(() => ownDoc().version === 15);
  // And the peer's next document, with the pair unpinned, builds the stack.
  await env.updateNote("Work-boxB.json", peer([tab(TWO), tab(MOVED, true),
    { type: "stack", id: "peer-gid", name: "Pair", tabs: [tab(S1), tab(S2)] }], 16));
  await W.reconcile("Work");
  const pair = env.stacks(WORK).find((s) => s.name === "Pair");
  ok("8b. ...and once the member is unpinned in the document the stack is built from the same tabs",
     pair && pair.urls.slice().sort().join(",") === [S1, S2].sort().join(",") &&
       env.pinnedUrls(WORK).join(",") === MOVED,
     `${env.layout(WORK)} pinned=${JSON.stringify(env.pinnedUrls(WORK))}`);
  await awaitDoc(() => ownDoc().version === 16);

  // ===========================================================================
  // 9-10. A build that REFUSES to pin: one acknowledgement, no swap.
  // ===========================================================================
  env.setPinSupport(false);
  await env.updateNote("Work-boxB.json", peer([tab(TWO, true), tab(MOVED, true),
    { type: "stack", id: "peer-gid", name: "Pair", tabs: [tab(S1), tab(S2)] }], 17));
  await W.reconcile("Work");
  ok("9a. the pin is refused here", env.pinnedUrls(WORK).join(",") === MOVED, JSON.stringify(env.pinnedUrls(WORK)));
  // The apply changed nothing here (the browser refused), so the live state
  // still matches the document this device last published — and invariant 2
  // says a pending acknowledgement is then DROPPED, not spent: our note stays
  // at the peer's v15, describing what is here. Had the refusal changed
  // anything else, the write would have gone out as the acknowledgement of v17
  // under the peer's origin, which the peer never applies. Either way there is
  // no fresh origination of "unpinned" for the peer to apply and bounce back.
  await env.sleep(6500);
  ok("9b. nothing is published — no acknowledgement to spend, no fresh origination",
     ownDoc().origin === "boxB" && ownDoc().version === 16 && pinnedOf(TWO) === false,
     `${prov()} two.pinned=${pinnedOf(TWO)}`);
  ok("9c. ...while this device holds the peer's v17 (it was applied, as far as the browser allowed)",
     W.config().holding.Work.origin === "boxB" && W.config().holding.Work.version === 17,
     JSON.stringify(W.config().holding.Work));
  // The refusal does not hold the device one document behind either: the next
  // peer change is applied.
  await env.updateNote("Work-boxB.json", peer([tab(TWO, true), tab(MOVED, true), tab(THREE),
    { type: "stack", id: "peer-gid", name: "Pair", tabs: [tab(S1), tab(S2)] }], 18));
  await W.reconcile("Work");
  ok("10. the next peer document is still applied after a refused pin",
     env.urls(WORK).includes(THREE), JSON.stringify(env.urls(WORK)));
  env.setPinSupport(true);
  await awaitDoc(() => ownDoc().version === 18);

  // ===========================================================================
  // 11. A pinned tab arrives while the user here sits in a stack.
  // ===========================================================================
  // A pinned tab on the peer reloads to a slightly different address (a new
  // tab by identity), and the document arrives while this user's active tab is
  // a member of the Pair stack. Vivaldi drops the newborn into the active tab's
  // stack, pinned or not, so the pinned tab becomes the stack's first member.
  // The engine must take it back out before grouping and re-pin it, and the
  // stack must be untouched.
  const FOUR = "https://four.example/";
  env.activate(S1);
  const pairGid = env.stacks(WORK).find((s) => s.name === "Pair").gid;
  await env.updateNote("Work-boxB.json", peer([tab(TWO), tab(MOVED, true), tab(THREE), tab(FOUR, true),
    { type: "stack", id: "peer-gid", name: "Pair", tabs: [tab(S1), tab(S2)] }], 19));
  env.OPS.length = 0;
  await W.reconcile("Work");
  const pairAfter = env.stacks(WORK).find((s) => s.name === "Pair");
  ok("11a. the model really dropped the pinned newborn into the active tab's stack",
     env.OPS.some((o) => o.op === "create" && o.url === FOUR && o.pinned && o.group === pairGid),
     JSON.stringify(env.OPS.filter((o) => o.op === "create")));
  ok("11b. ...and it ends up top-level and pinned, the stack exactly as it was",
     pairAfter && pairAfter.gid === pairGid && pairAfter.urls.slice().sort().join(",") === [S1, S2].sort().join(",") &&
       env.pinnedUrls(WORK).sort().join(",") === [FOUR, MOVED].sort().join(","),
     `${env.layout(WORK)} pinned=${JSON.stringify(env.pinnedUrls(WORK))}`);
  await awaitDoc(() => ownDoc().version === 19 && pinnedOf(FOUR) === true);
  const pairDoc = ownDoc().items.find((i) => i.type === "stack" && i.name === "Pair");
  ok("11c. the acknowledgement lists it top-level pinned and the stack with its two members",
     pinnedOf(FOUR) === true && pairDoc && pairDoc.tabs.length === 2 && ownDoc().origin === "boxB",
     JSON.stringify(ownDoc().items));

  // ===========================================================================
  // 12. A workspace left with a pinned tab inside a stack is repaired, not
  //     propagated.
  // ===========================================================================
  // The broken browser state: a pinned tab that reports the stack's
  // group. Publishing it must describe the intended state (top-level, pinned;
  // the stack with its two real members), and the next apply must get the tab
  // out of the group. Nothing else in the document differs, so without the pin
  // phase doing it the group would outlive every reconcile.
  const FIVE = "https://five.example/";
  env.addTab({ url: FIVE, ws: WORK, pinned: true, group: pairGid, stackName: "Pair" });
  await W.writeNow();
  await awaitDoc(() => ownDoc().items.some((i) => i.url === FIVE));
  const pairDoc2 = ownDoc().items.find((i) => i.type === "stack" && i.name === "Pair");
  ok("12a. a pinned tab inside a stack is PUBLISHED as top-level pinned, the stack without it",
     pinnedOf(FIVE) === true && pairDoc2 && pairDoc2.tabs.length === 2 &&
       !pairDoc2.tabs.some((x) => x.url === FIVE) && ownDoc().origin === "boxA",
     JSON.stringify(ownDoc().items));
  // The peer applies that and (here, for the test) originates something new on
  // top of it; the apply of that document is what repairs the local group.
  await env.updateNote("Work-boxB.json", peer([tab(TWO), tab(MOVED, true), tab(THREE), tab(FOUR, true), tab(FIVE, true),
    { type: "stack", id: "peer-gid", name: "Pair", tabs: [tab(S1), tab(S2)] }], 25));
  await W.reconcile("Work");
  const five = env.TABS.find((t) => t.url === FIVE);
  const pairFixed = env.stacks(WORK).find((s) => s.name === "Pair");
  ok("12b. the next apply takes the pinned tab out of the group and keeps it pinned",
     five && five.pinned === true && JSON.parse(five.vivExtData).group == null &&
       pairFixed && pairFixed.urls.length === 2,
     `${env.layout(WORK)} five=${five && five.vivExtData} pinned=${five && five.pinned}`);

  // ===========================================================================
  // 13-17. A STACK IS PINNED AS A WHOLE.
  // ===========================================================================
  // Vivaldi pins a tab stack as a unit: it stays a stack and moves into the
  // pinned strip. If `pinned` belonged to a tab alone, a stack the user pinned
  // on one machine would arrive on the other as its members, loose and pinned,
  // with the stack gone. So a stack carries its own `pinned`, its members
  // repeat it, and a group whose members DISAGREE is the broken case: the
  // larger part is the stack and the odd tabs out are top-level, which is what
  // §8, §11 and §12 above are about.
  const base = () => [tab(TWO), tab(MOVED, true), tab(THREE), tab(FOUR, true), tab(FIVE, true)];
  const stackItem = (name, urls, pinned) => ({
    type: "stack", id: "peer-" + name, name, pinned: !!pinned,
    tabs: urls.map((u) => tab(u, !!pinned)), // a member repeats the stack's state
  });
  const stackNamed = (name) => env.stacks(WORK).find((x) => x.name === name);

  // --- 13. A peer pins the stack: it is pinned HERE, and it is still a stack --
  await env.updateNote("Work-boxB.json", peer([...base(), stackItem("Pair", [S1, S2], true)], 26));
  env.OPS.length = 0;
  await W.reconcile("Work");
  const pair13 = stackNamed("Pair");
  ok("13a. a stack the peer pinned is pinned here, members and all — still one stack",
     pair13 && pair13.gid === pairGid && pair13.pinned === true &&
       pair13.urls.slice().sort().join(",") === [S1, S2].sort().join(","),
     `${env.layout(WORK)} pinned=${JSON.stringify(env.pinnedUrls(WORK))}`);
  ok("13b. ...pinned in place, one update per member, nothing created or closed",
     env.OPS.filter((o) => o.op === "pin" && o.pinned).length === 2 &&
       !env.OPS.some((o) => o.op === "create" || o.op === "remove"),
     JSON.stringify(env.OPS));
  await awaitDoc(() => ownDoc().version === 26);
  const pairDoc13 = ownDoc().items.find((i) => i.type === "stack" && i.name === "Pair");
  ok("13c. the acknowledgement publishes it as a PINNED STACK, not as loose pinned tabs",
     pairDoc13 && pairDoc13.pinned === true && pairDoc13.tabs.length === 2 &&
       pairDoc13.tabs.every((x) => x.pinned === true) &&
       !ownDoc().items.some((i) => i.type === "tab" && (i.url === S1 || i.url === S2)) &&
       ownDoc().origin === "boxB",
     JSON.stringify(ownDoc().items));

  // --- 14. A pinned stack whose tabs are not here yet ------------------------
  // Built like any other stack — created unpinned, grouped, and pinned by the
  // pin phase last. A member created pinned would land in the pinned strip and
  // never join the group.
  const N1 = "https://n1.example/";
  const N2 = "https://n2.example/";
  await env.updateNote("Work-boxB.json",
    peer([...base(), stackItem("Pair", [S1, S2], true), stackItem("Notes", [N1, N2], true)], 27));
  env.OPS.length = 0;
  await W.reconcile("Work");
  const notes14 = stackNamed("Notes");
  ok("14a. a pinned stack that is new here is created as a stack and then pinned",
     notes14 && notes14.pinned === true &&
       notes14.urls.slice().sort().join(",") === [N1, N2].sort().join(","),
     env.layout(WORK));
  ok("14b. ...its members were created UNPINNED, so the grouping could happen first",
     env.OPS.filter((o) => o.op === "create" && (o.url === N1 || o.url === N2)).every((o) => !o.pinned) &&
       env.OPS.filter((o) => o.op === "pin" && o.pinned && [N1, N2].includes(
         (env.TABS.find((t) => t.id === o.id) || {}).url)).length === 2,
     JSON.stringify(env.OPS.filter((o) => o.op === "create" || o.op === "pin")));

  // --- 15. Unpinning a stack propagates the same way -------------------------
  await env.updateNote("Work-boxB.json",
    peer([...base(), stackItem("Pair", [S1, S2], false), stackItem("Notes", [N1, N2], false)], 28));
  await W.reconcile("Work");
  const pair15 = stackNamed("Pair"), notes15 = stackNamed("Notes");
  ok("15. unpinning a stack on a peer unpins it here, and both are still stacks",
     pair15 && notes15 && pair15.pinned === false && notes15.pinned === false &&
       pair15.urls.length === 2 && notes15.urls.length === 2 &&
       env.pinnedUrls(WORK).sort().join(",") === [MOVED, FOUR, FIVE].sort().join(","),
     `${env.layout(WORK)} pinned=${JSON.stringify(env.pinnedUrls(WORK))}`);
  await awaitDoc(() => ownDoc().version === 28);

  // --- 16. Pinning a stack HERE is a fresh origination -----------------------
  // The user's gesture pins every member at once. It changes the signature (a
  // pinned stack is part of the pinned strip, an ordinary one is part of the
  // ordered sequence), so it is published as this device's own news.
  env.pinGroup(stackNamed("Pair").gid, true);
  await awaitDoc(() => ownDoc().origin === "boxA");
  const pairDoc16 = ownDoc().items.find((i) => i.type === "stack" && i.name === "Pair");
  ok("16a. pinning a stack locally is published as a pinned stack",
     pairDoc16 && pairDoc16.pinned === true && pairDoc16.tabs.length === 2,
     JSON.stringify(ownDoc().items));
  ok("16b. ...as this device's own change, out-ranking the state it held",
     ownDoc().origin === "boxA" && ownDoc().version > 28, prov());

  // --- 17. A build on which pinning a member drops it out of the group -------
  // Unverified against a real Vivaldi (VivaSync.diagPin() -> memberPinKeptGroup
  // answers it on the machine in front of you). The engine reads the group back
  // after the pin phase and rebuilds the stack when it came apart, rather than
  // publishing a half-pinned group — which every peer would read as an
  // instruction to take the stack apart.
  env.breakGroupOnPin(true);
  await env.updateNote("Work-boxB.json",
    peer([...base(), stackItem("Pair", [S1, S2], true), stackItem("Notes", [N1, N2], true)], 30));
  await W.reconcile("Work");
  const notes17 = stackNamed("Notes");
  ok("17. a stack the pin took apart is rebuilt, pinned, named, in one apply",
     notes17 && notes17.pinned === true &&
       notes17.urls.slice().sort().join(",") === [N1, N2].sort().join(","),
     env.layout(WORK));
  env.breakGroupOnPin(false);

  ok("no errors logged during the run", env.consoleErrors.length === 0, env.consoleErrors.join(" | ") || "clean");
  done();
})();
