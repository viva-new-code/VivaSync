// Stack membership across devices — the third field failure.
//
// Reported: aur.archlinux.org and aur.archlinux.org/packages/claude-desktop
// were in one stack on both machines. Closing aur.archlinux.org on cinfra left
// the OTHER machine with BOTH a leftover top-level
// aur.archlinux.org/packages/claude-desktop tab AND the original stack, still
// holding both members.
//
// Everything here leans on two browser behaviours the doubles now model (see
// harness.js): a stack that drops below two members is dissolved, and a new tab
// joins the ACTIVE TAB's stack.
const { createEnv, ok, done } = require("./harness");

const C = "https://c.example/";
const AUR = "https://aur.archlinux.org/";
const PKG = "https://aur.archlinux.org/packages/claude-desktop";

const env = createEnv({
  tabs: [
    { id: 11, url: C, ws: 1717425015828.0, active: true },
    { id: 12, url: AUR, ws: 1717425015828.0, group: "g1", stackName: "AUR" },
    { id: 13, url: PKG, ws: 1717425015828.0, group: "g1", stackName: "AUR" },
  ],
});
const WORK = env.WS.WORK;

const tab = (url) => ({ type: "tab", url, title: url, pinned: false });
const stack = (name, urls) => ({ type: "stack", id: "peer-gid", name, tabs: urls.map(tab) });
// The offset doubles as the peer's version: it only ever grows through the file.
const doc = (items, tsOffset) =>
  ({ workspace: "Work", origin: "boxB", version: tsOffset, timestamp: Date.now() / 1000 + tsOffset, items });

(async () => {
  const W = await env.boot();
  await env.setConfig({ workspaces: ["Work"] });
  await W.reconcile("Work");
  await W.writeNow();

  ok("0a. the fixture starts as one top-level tab plus a two-member stack",
     env.layout(WORK) === `${C} | [AUR: ${AUR}, ${PKG}]`, env.layout(WORK));

  const published = () => JSON.parse(env.noteByTitle("Work-boxA.json").content).items;
  ok("0b. the stack is published as a stack",
     published().filter((i) => i.type === "stack").length === 1,
     JSON.stringify(published().map((i) => i.type)));

  // ===========================================================================
  // 1. The peer closed one of two stack members, so ITS stack dissolved and it
  //    published the survivor as a plain top-level tab.
  // ===========================================================================
  await env.putPeerDoc("Work-boxB.json", doc([tab(C), tab(PKG)], 60));
  await W.reconcile("Work");
  ok("1a. the local stack is gone too — no stack survives",
     env.stacks(WORK).length === 0, env.layout(WORK));
  ok("1b. exactly one copy of the survivor remains, at top level",
     env.layout(WORK) === `${C} | ${PKG}`, env.layout(WORK));

  // ===========================================================================
  // 2. Same edit, but the peer's browser kept the group id on the survivor, so
  //    it published a one-member stack instead. Must converge to the same
  //    thing: one tab, no duplicate.
  // ===========================================================================
  // Rebuild the two-member stack locally, as a peer re-adding the tab would.
  await env.updateNote("Work-boxB.json", doc([tab(C), stack("AUR", [AUR, PKG])], 120));
  await W.reconcile("Work");
  ok("2a. the stack is rebuilt from the peer document",
     env.stacks(WORK).length === 1 && env.stacks(WORK)[0].urls.length === 2,
     env.layout(WORK));
  ok("2b. rebuilding it does not leave the old tabs behind",
     env.layout(WORK) === `${C} | [AUR: ${AUR}, ${PKG}]`, env.layout(WORK));

  await env.updateNote("Work-boxB.json", doc([tab(C), stack("AUR", [PKG])], 180));
  await W.reconcile("Work");
  ok("2c. a one-member remote stack leaves exactly one local copy of that tab",
     env.layout(WORK) === `${C} | ${PKG}` || env.layout(WORK) === `${C} | [AUR: ${PKG}]`,
     env.layout(WORK));

  // ===========================================================================
  // 3. The local direction: the user closes a stack member HERE. What we
  //    publish must describe the dissolved stack, not the old one.
  // ===========================================================================
  await env.updateNote("Work-boxB.json", doc([tab(C), stack("AUR", [AUR, PKG])], 240));
  await W.reconcile("Work");
  await env.sleep(5200);
  await W.writeNow();
  ok("3a. precondition: back to one top-level tab plus the two-member stack",
     env.layout(WORK) === `${C} | [AUR: ${AUR}, ${PKG}]`, env.layout(WORK));

  const stackTab = env.TABS.find((t) => t.url === AUR);
  await env.closeTab(stackTab.id);
  ok("3b. closing the second-to-last member dissolves the stack locally",
     env.layout(WORK) === `${C} | ${PKG}`, env.layout(WORK));

  await env.sleep(5200);
  await W.writeNow();
  ok("3c. the published document no longer contains a stack",
     published().every((i) => i.type === "tab"),
     JSON.stringify(published().map((i) => (i.type === "tab" ? i.url : "stack:" + i.name))));
  ok("3d. the published document lists the survivor exactly once",
     published().filter((i) => i.url === PKG).length === 1,
     JSON.stringify(published().map((i) => i.url)));

  // ===========================================================================
  // 4. A tab created for TOP LEVEL must not be swallowed by the active tab's
  //    stack. Vivaldi adds a new tab to the stack the active tab is in, and
  //    pinToWorkspace passes "do-not-reparent", so nothing pulls it back out.
  // ===========================================================================
  await env.updateNote("Work-boxB.json", doc([stack("AUR", [AUR, PKG])], 300));
  await W.reconcile("Work");
  // Put the user inside the stack, as they would be after clicking a member.
  for (const t of env.TABS) t.active = false;
  env.TABS.find((t) => t.url === AUR).active = true;
  ok("4a. precondition: the active tab is a stack member",
     env.stacks(WORK).length === 1, env.layout(WORK));

  await env.updateNote("Work-boxB.json", doc([tab(C), stack("AUR", [AUR, PKG])], 360));
  await W.reconcile("Work");
  ok("4b. a new top-level tab is not swallowed into the active tab's stack",
     env.stacks(WORK).length === 1 && env.stacks(WORK)[0].urls.length === 2,
     env.layout(WORK));
  ok("4c. ...and it really is present, at top level",
     env.layout(WORK) === `${C} | [AUR: ${AUR}, ${PKG}]` ||
     env.layout(WORK) === `[AUR: ${AUR}, ${PKG}] | ${C}`,
     env.layout(WORK));

  // ===========================================================================
  // 5. The reported artifact: the same URL ends up BOTH at top level and in the
  //    stack. A live tab that cannot be closed (it is still loading) must be
  //    adopted into the stack, not duplicated by a fresh create.
  // ===========================================================================
  await env.updateNote("Work-boxB.json", doc([tab(C), tab(AUR), tab(PKG)], 420));
  await W.reconcile("Work");
  ok("5a. precondition: three plain tabs, no stack",
     env.stacks(WORK).length === 0, env.layout(WORK));
  env.TABS.find((t) => t.url === PKG).status = "loading";

  await env.updateNote("Work-boxB.json", doc([tab(C), stack("AUR", [AUR, PKG])], 480));
  await W.reconcile("Work");
  const copies = env.TABS.filter((t) => t.url === PKG).length;
  ok("5b. the URL exists exactly once in the workspace, not once per container",
     copies === 1, `${copies} copies -> ${env.layout(WORK)}`);

  // ===========================================================================
  // 6. The stack/no-stack ping-pong (three tabs joined into a stack on the
  //    peer). Applying the peer's stack is only half the job: what we publish
  //    immediately afterwards must ALSO say "stack". vivaldi.tabsPrivate returns
  //    before the grouping reaches vivExtData, so a snapshot taken in that
  //    window reports three plain tabs — the peer applies that by taking its own
  //    stack apart, republishes, and the two devices swap roles for ever.
  //    The symptom, seen with code.claude.com/docs tabs: "grouped on workshop
  //    but ungrouped on cinfra, then grouped on cinfra and ungrouped on
  //    workshop and so on in an endless loop".
  // ===========================================================================
  for (const t of env.TABS) t.status = "complete"; // §5 left one navigating
  const D1 = "https://code.claude.com/docs/en/desktop-linux";
  const D2 = "https://code.claude.com/docs/en/remote-control";
  const D3 = "https://code.claude.com/docs/en/desktop-quickstart";

  await env.updateNote("Work-boxB.json", doc([tab(D1), tab(D2), tab(D3)], 540));
  await W.reconcile("Work");
  ok("6a. precondition: the three docs tabs are plain top-level tabs",
     env.stacks(WORK).length === 0 && env.urls(WORK).length === 3, env.layout(WORK));

  // The peer joins them into a stack and publishes it.
  await env.updateNote("Work-boxB.json", doc([stack(null, [D1, D2, D3])], 600));
  await W.reconcile("Work");
  ok("6b. the stack arrives",
     env.stacks(WORK).length === 1 && env.stacks(WORK)[0].urls.length === 3, env.layout(WORK));

  // The snapshot is what reconcile() publishes on its way out. If the grouping
  // has not landed yet this reads back three tabs — the document that starts
  // the loop.
  const snap = await W.snapshot("Work");
  ok("6c. what we publish back describes a STACK, not three plain tabs",
     snap.items.length === 1 && snap.items[0].type === "stack" &&
     snap.items[0].tabs.length === 3,
     JSON.stringify(snap.items.map((i) => i.type + ":" + (i.url || (i.tabs || []).length))));

  // ...and having agreed, a further round must change nothing on either side.
  env.OPS.length = 0;
  await env.updateNote("Work-boxB.json", doc([stack(null, [D1, D2, D3])], 660));
  await W.reconcile("Work");
  ok("6d. re-applying the same stack is a no-op (the loop terminates)",
     env.OPS.length === 0 && env.stacks(WORK).length === 1,
     env.OPS.map((o) => o.op).join(",") + " -> " + env.layout(WORK));

  // The same must hold for a NAMED stack: the name is part of the signature, so
  // publishing before setGroupProperties lands makes the peers flap it back.
  await env.updateNote("Work-boxB.json", doc([stack("Docs", [D1, D2, D3])], 720));
  await W.reconcile("Work");
  const named = await W.snapshot("Work");
  ok("6e. a stack's NAME has landed before we publish it",
     named.items[0] && named.items[0].name === "Docs",
     JSON.stringify(named.items.map((i) => i.name || i.url)));

  // ===========================================================================
  // 7. A tab opened INSIDE an existing stack on the peer. The peer publishes a
  //    stack that has gained a member; applying that means adding one tab to a
  //    stack we already have, which is ADAPTER.addToStack (the
  //    ["do-not-reparent","on","create-group"] move targeting the group id —
  //    see test/fixtures/vivaldi-api.json).
  //
  //    The symptom when it fails: "creating a new tab inside an existing stack
  //    creates a tab inside the stack, but it gets synced to another machine as
  //    a top-level tab, and in turn synced back as top-level, removed from the
  //    stack where it had been created". That is what a silently-ignored
  //    addToStack produces: the new member stays a plain tab here, we publish it
  //    as one, and the machine that made the stack un-stacks it to match us.
  //
  //    The ACTIVE tab must be a top-level one throughout, or the test proves
  //    nothing: Vivaldi drops a new tab into the active tab's stack, so with a
  //    stack member active the tab would join by accident and addToStack would
  //    never be exercised.
  // ===========================================================================
  const D4 = "https://code.claude.com/docs/en/hooks";

  await env.updateNote("Work-boxB.json", doc([tab(C), stack("Docs", [D1, D2, D3])], 780));
  await W.reconcile("Work");
  env.activate(C);
  ok("7a. precondition: a top-level tab (active) beside a named three-member stack",
     env.stacks(WORK).length === 1 && env.stacks(WORK)[0].urls.length === 3 &&
     env.urls(WORK).length === 4, env.layout(WORK));

  // The build ignores "group-follows-target". createStack still works, which is
  // what the engine falls back to.
  env.setGroupingSupport({ addToStack: false });
  await env.updateNote("Work-boxB.json", doc([tab(C), stack("Docs", [D1, D2, D3, D4])], 840));
  await W.reconcile("Work");
  ok("7b. the new member joins the stack even when addToStack is a no-op",
     env.stacks(WORK).length === 1 && env.stacks(WORK)[0].urls.length === 4,
     env.layout(WORK));

  const grown = await W.snapshot("Work");
  ok("7c. and we publish it as a four-member stack, not a stack plus a loose tab",
     grown.items.length === 2 && grown.items[1].type === "stack" &&
     grown.items[1].tabs.length === 4 && grown.items[1].name === "Docs",
     JSON.stringify(grown.items.map((i) => i.type + ":" + (i.url || (i.tabs || []).length))));

  env.setGroupingSupport({ addToStack: true });

  // ...and when NOTHING can group, the engine must decline to publish rather
  // than broadcast the half-applied state it is stuck in. Publishing "these are
  // plain tabs" would tell the peer to take its own stack apart, and the two
  // devices would swap roles for ever — invariant 6.
  await env.updateNote("Work-boxB.json", doc([tab(C), tab(D1), tab(D2), tab(D3), tab(D4)], 900));
  await W.reconcile("Work");
  env.activate(C);
  ok("7d. precondition: the stack is dissolved, five plain tabs published",
     env.stacks(WORK).length === 0 && env.urls(WORK).length === 5, env.layout(WORK));

  // The peer's document both adds a tab AND asks for a stack. The added tab
  // lands, the stack does not — so the live state now genuinely differs from
  // what we last published, and the signature gate alone would let it out.
  const D5 = "https://code.claude.com/docs/en/mcp";
  const before7 = env.noteByTitle("Work-boxA.json").content;
  env.setGroupingSupport({ addToStack: false, createStack: false });
  await env.updateNote("Work-boxB.json",
    doc([tab(C), stack("Docs", [D1, D2]), tab(D3), tab(D4), tab(D5)], 960));
  await W.reconcile("Work");
  ok("7e. a grouping that never lands is not published",
     env.noteByTitle("Work-boxA.json").content === before7,
     JSON.stringify((JSON.parse(env.noteByTitle("Work-boxA.json").content).items || [])
       .map((i) => i.type + ":" + (i.url || (i.tabs || []).length))));
  env.setGroupingSupport({ addToStack: true, createStack: true });

  // ===========================================================================
  // 8. One stale id must not abandon the whole delete list.
  //
  //    chrome.tabs.remove rejects the entire bulk call with "No such tab - N"
  //    if any id in it is no longer live, and a tab can go stale between being
  //    planned for deletion and being closed — dissolving a stack is
  //    asynchronous. Without the individual retry, that single rejection would
  //    leave EVERY tab a peer asked us to close still open, which is
  //    indistinguishable from "deletes stopped propagating".
  // ===========================================================================
  await env.updateNote("Work-boxB.json",
    doc([tab(C), tab(D1), tab(D2), tab(D3)], 1020));
  await W.reconcile("Work");
  env.activate(C);
  ok("8a. precondition: four plain tabs",
     env.stacks(WORK).length === 0 && env.urls(WORK).length === 4, env.layout(WORK));

  // The peer wants three of them gone. One of the doomed tabs vanishes on its
  // own the instant the delete phase runs — exactly what a dissolving stack
  // does — so the bulk call is rejected.
  const doomed = env.TABS.find((t) => t.url === D2);
  const origRemove = global.chrome.tabs.remove;
  let sabotaged = false;
  // Forward the argument list VERBATIM: the harness promisifies chrome.* by
  // looking at whether the last argument is a function, so passing an explicit
  // undefined callback makes it wait for a callback that never comes.
  global.chrome.tabs.remove = (...args) => {
    const [id] = args;
    if (!sabotaged && Array.isArray(id) && id.length > 1) {
      sabotaged = true;
      env.TABS.splice(env.TABS.indexOf(doomed), 1); // it closed itself first
    }
    return origRemove(...args);
  };
  await env.updateNote("Work-boxB.json", doc([tab(C)], 1080));
  await W.reconcile("Work");
  global.chrome.tabs.remove = origRemove;

  ok("8b. the surviving deletions still happen despite the rejected bulk call",
     env.urls(WORK).length === 1 && env.urls(WORK)[0] === C, env.layout(WORK));

  // ===========================================================================
  // 9. A SECOND stack arriving while the user sits inside one.
  // ===========================================================================
  // Vivaldi drops every newborn into the ACTIVE TAB's stack, so both members of
  // a new stack start out in the user's stack — together. "These tabs are one
  // stack now" is then already true of the WRONG group: a wait after
  // createStack that did not name the group it asked for would return the
  // user's group, the new stack's name would be applied to it, and the new
  // stack would never settle, so the round would publish nothing.
  const F1 = "https://f1.example/", F2 = "https://f2.example/";
  const E1 = "https://e1.example/", E2 = "https://e2.example/";
  await env.updateNote("Work-boxB.json", doc([tab(C), stack("One", [F1, F2])], 1090));
  await W.reconcile("Work");
  const one = env.stacks(WORK).find((x) => x.name === "One");
  env.activate(F1); // the user is sitting INSIDE that stack
  await env.updateNote("Work-boxB.json",
    doc([tab(C), stack("One", [F1, F2]), { type: "stack", id: "peer-2", name: "Two", tabs: [E1, E2].map(tab) }], 1091));
  await W.reconcile("Work");
  const one2 = env.stacks(WORK).find((x) => x.name === "One");
  const two = env.stacks(WORK).find((x) => x.name === "Two");
  ok("9a. the new stack is its own group, with its own name and members",
     two && two.urls.slice().sort().join(",") === [E1, E2].sort().join(","),
     env.layout(WORK));
  ok("9b. ...and the stack the user was sitting in is untouched",
     one2 && one && one2.gid === one.gid && one2.name === "One" &&
       one2.urls.slice().sort().join(",") === [F1, F2].sort().join(","),
     env.layout(WORK));

  // ===========================================================================
  // 10-14. A STACK'S COLOUR.
  // ===========================================================================
  // Vivaldi lets the user colour a tab stack (Tab Stack > Color, nine named
  // colours plus "no colour"). It is stored beside the name, in every member's
  // vivExtData.groupColor, and set through the same setGroupProperties call
  // with the other property — so it syncs on exactly the terms the NAME does:
  // it is in the document, it is in the signature, it is applied in place
  // (never by re-creating the stack), and the browser is given it only when it
  // is actually wrong.
  //
  // The one place it differs from the name and from `pinned`: a document that
  // says NOTHING about the colour is not a document that says "no colour". A
  // writer that does not track colour (or a hand-edited document) has no
  // `color` field at all, and wiping the user's colour because of it would be
  // a change nobody asked for — see §14.
  const stackC = (name, urls, color) =>
    ({ type: "stack", id: "peer-" + name, name, color, tabs: urls.map(tab) });
  const stackNamed = (n) => env.stacks(WORK).find((x) => x.name === n);
  const ownDoc = () => JSON.parse(env.noteByTitle("Work-boxA.json").content);
  const docStack = (n) => (ownDoc().items || []).find((i) => i.type === "stack" && i.name === n);
  // A note write sleeps inside the 5s per-note throttle and is re-armed rather
  // than queued, so "the write landed" is a poll, not a fixed sleep.
  const awaitDoc = async (pred) => {
    for (let i = 0; i < 80 && !pred(); i++) await env.sleep(250);
    return ownDoc();
  };

  // --- 10. A peer colours a stack: applied in place, still the same stack ----
  const oneGid = stackNamed("One").gid;
  await env.updateNote("Work-boxB.json",
    doc([tab(C), stackC("One", [F1, F2], "color3"), stack("Two", [E1, E2])], 1100));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("10a. a colour a peer set is applied to the stack that is already here",
     stackNamed("One") && stackNamed("One").color === "color3" && stackNamed("One").gid === oneGid &&
       stackNamed("One").urls.slice().sort().join(",") === [F1, F2].sort().join(","),
     env.layout(WORK));
  ok("10b. ...by colouring it, not by rebuilding it — one call, nothing created or closed",
     env.OPS.filter((o) => o.op === "stack-color").length === 1 &&
       env.OPS.filter((o) => o.op === "stack-color")[0].color === "color3" &&
       !env.OPS.some((o) => o.op === "create" || o.op === "remove"),
     JSON.stringify(env.OPS));
  ok("10c. ...and the stack whose colour the document did not mention is left alone",
     stackNamed("Two") && stackNamed("Two").color === null, env.layout(WORK));
  await awaitDoc(() => ownDoc().version === 1100);
  ok("10d. the acknowledgement publishes the colour, under the peer's provenance",
     docStack("One") && docStack("One").color === "color3" && ownDoc().origin === "boxB",
     JSON.stringify(ownDoc().items));

  // --- 11. Re-colouring and clearing ----------------------------------------
  await env.updateNote("Work-boxB.json",
    doc([tab(C), stackC("One", [F1, F2], "color7"), stack("Two", [E1, E2])], 1110));
  await W.reconcile("Work");
  ok("11a. changing the colour changes it here",
     stackNamed("One") && stackNamed("One").color === "color7", env.layout(WORK));

  // `color: null` is a device saying the stack has no colour — as opposed
  // to saying nothing at all (§14). It must clear it.
  await env.updateNote("Work-boxB.json",
    doc([tab(C), stackC("One", [F1, F2], null), stack("Two", [E1, E2])], 1120));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("11b. clearing the colour clears it here, and the stack survives it",
     stackNamed("One") && stackNamed("One").color === null &&
       stackNamed("One").urls.length === 2 && stackNamed("One").gid === oneGid,
     env.layout(WORK));
  ok("11c. ...cleared with the empty string, the way Vivaldi's own menu does",
     env.OPS.filter((o) => o.op === "stack-color").length === 1 &&
       env.OPS.filter((o) => o.op === "stack-color")[0].color === null,
     JSON.stringify(env.OPS));

  // --- 12. The user colours a stack HERE: a fresh origination ---------------
  // Let the acknowledgement for §11 land first. A local change made while one
  // is still pending is FOLDED INTO it and goes out under the peer's provenance
  // (invariant 2) — correct, and not what this section is about.
  await awaitDoc(() => ownDoc().version === 1120);
  // The colour is in the signature, so this is a change worth publishing on its
  // own — not something that reaches the peer only when a tab happens to move.
  env.setStackColor(stackNamed("Two").gid, "color5");
  await awaitDoc(() => ownDoc().origin === "boxA");
  ok("12a. colouring a stack locally is published as this device's own change",
     docStack("Two") && docStack("Two").color === "color5" &&
       ownDoc().origin === "boxA" && ownDoc().version > 1120,
     JSON.stringify(ownDoc().items) + ` prov=${ownDoc().origin} v${ownDoc().version}`);

  // --- 13. A stack that is new here arrives named AND coloured --------------
  const G1 = "https://g1.example/", G2 = "https://g2.example/";
  await env.updateNote("Work-boxB.json",
    doc([tab(C), stackC("One", [F1, F2], null), stack("Two", [E1, E2]),
         stackC("Green", [G1, G2], "color5")], 1130));
  await W.reconcile("Work");
  ok("13a. a new stack is built, named and coloured in the one apply",
     stackNamed("Green") && stackNamed("Green").color === "color5" &&
       stackNamed("Green").urls.slice().sort().join(",") === [G1, G2].sort().join(","),
     env.layout(WORK));
  ok("13b. ...and naming it did not erase the colour, nor the colour the name",
     env.TABS.filter((t) => [G1, G2].includes(t.url))
       .every((t) => JSON.parse(t.vivExtData).fixedGroupTitle === "Green" &&
                     JSON.parse(t.vivExtData).groupColor === "color5"),
     JSON.stringify(env.TABS.filter((t) => [G1, G2].includes(t.url)).map((t) => t.vivExtData)));

  // --- 14. A document that says nothing about colour ------------------------
  // `stack()` has no `color` key at all. It must not read as "no colour": the
  // user set that colour on this machine, and the document simply makes no
  // claim about it.
  await env.updateNote("Work-boxB.json",
    doc([tab(C), stack("One", [F1, F2]), stack("Two", [E1, E2]), stack("Green", [G1, G2])], 1140));
  env.OPS.length = 0;
  await W.reconcile("Work");
  ok("14a. a stack's colour survives a document that does not speak of colour",
     stackNamed("Green") && stackNamed("Green").color === "color5" &&
       stackNamed("Two") && stackNamed("Two").color === "color5",
     env.layout(WORK));
  ok("14b. ...and nothing was said to the browser about any colour",
     !env.OPS.some((o) => o.op === "stack-color"), JSON.stringify(env.OPS));

  done();
})();
