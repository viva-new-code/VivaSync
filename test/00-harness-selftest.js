// Guards the harness itself against drift from real Vivaldi behaviour.
//
// Why this file exists: the doubles in harness.js are a model of the browser,
// and a wrong model produces GREEN TESTS OVER A BROKEN PATH. That is not
// hypothetical — a tabs.remove stub that ignored array arguments made every
// delete in the reconcile engine silently do nothing while the suite passed.
//
// Two kinds of check:
//   1. Behavioural contracts the mod depends on (array removes, new tabs
//      joining the active workspace, events firing before create() returns).
//   2. Surface comparison against fixtures/vivaldi-api.json, captured from a
//      real Vivaldi. If an update adds or drops an API the mod uses, this fails
//      loudly instead of the suite passing vacuously.
//      Re-capture with:  node test/cdp.js --capture   (browser must be running)

const fs = require("fs");
const path = require("path");
const { createEnv, ok, done } = require("./harness");

const env = createEnv();
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "vivaldi-api.json"), "utf8"));

(async () => {
  // --- 1. behavioural contracts ---------------------------------------------

  // tabs.remove must accept an array (the engine always removes in bulk).
  const before = env.TABS.length;
  const ids = env.TABS.slice(0, 2).map((t) => t.id);
  await chrome.tabs.remove(ids);
  ok("tabs.remove([a,b]) removes BOTH tabs", env.TABS.length === before - 2,
     `${before} -> ${env.TABS.length}`);

  // A created tab must join the active workspace — the whole create path relies
  // on this, and it is why applyDesired refuses to run on an inactive workspace.
  env.addTab({ id: 21, url: "https://active.example/", ws: env.WS.WORK, active: true });
  env.addTab({ id: 22, url: "https://other.example/", ws: env.WS.PERSONAL });
  const created = await chrome.tabs.create({ windowId: 1, url: "https://new.example/" });
  const createdWs = JSON.parse(created.vivExtData).workspaceId;
  ok("a new tab joins the ACTIVE workspace", Number(createdWs) === Number(env.WS.WORK),
     `joined ${createdWs}, active is ${env.WS.WORK}`);
  // A NEWBORN IS LOADING, and finishes on its own. The engine treats a loading
  // tab as volatile — never closed, never published yet — but the order phase
  // must still place it, and modelling newborns as complete would hide a phase
  // that does not (test/16 §11).
  ok("a newly created tab is `loading`", created.status === "loading", String(created.status));
  await env.sleep(200);
  ok("...and reaches `complete` on its own", created.status === "complete", String(created.status));

  // `pinned` is the one attribute the engine changes on a tab in place, so the
  // double must honour it on create AND update, announce it on onUpdated, keep
  // the tab in its workspace, and honour a create-time vivExtData workspaceId.
  // A move (pinToWorkspace) strips the pin — the pessimistic, unverified model
  // the engine's "pin only after every move" rule exists for.
  const pinnedNew = await chrome.tabs.create({
    windowId: 1, url: "https://pinned.example/", pinned: true,
    vivExtData: JSON.stringify({ workspaceId: env.WS.PERSONAL }),
  });
  ok("tabs.create honours pinned and a create-time workspaceId",
     pinnedNew.pinned === true && Number(JSON.parse(pinnedNew.vivExtData).workspaceId) === Number(env.WS.PERSONAL),
     JSON.stringify({ pinned: pinnedNew.pinned, ext: pinnedNew.vivExtData }));
  let pinEvents = 0;
  chrome.tabs.onUpdated.addListener((id, info) => { if (id === created.id && info.pinned != null) pinEvents++; });
  await chrome.tabs.update(created.id, { pinned: true });
  ok("tabs.update({pinned:true}) pins in place and fires onUpdated",
     env.TABS.find((t) => t.id === created.id).pinned === true && pinEvents === 1, `events=${pinEvents}`);
  await chrome.tabs.update(created.id, { pinned: true });
  ok("re-asserting the same pin state fires nothing", pinEvents === 1, `events=${pinEvents}`);
  await vivaldi.tabsPrivate.move({ tabIds: [created.id], target: -1, windowId: 1, workspaceId: env.WS.WORK, tweaks: ["do-not-reparent"] });
  ok("a repositioned tab loses its pin (pessimistic model)",
     env.TABS.find((t) => t.id === created.id).pinned === false &&
       env.OPS.some((o) => o.op === "unpin-by-move" && o.id === created.id), "");
  env.setPinSupport(false);
  await chrome.tabs.update(created.id, { pinned: true });
  const refusedNew = await chrome.tabs.create({ windowId: 1, url: "https://refused.example/", pinned: true });
  ok("with pin support off, neither update nor create pins",
     env.TABS.find((t) => t.id === created.id).pinned === false && refusedNew.pinned === false, "");
  env.setPinSupport(true);
  let updateThrew = null;
  try { await chrome.tabs.update(999999, { pinned: true }); } catch (e) { updateThrew = e; }
  ok("tabs.update REJECTS a stale id", !!updateThrew && /No such tab/.test(updateThrew.message), String(updateThrew));
  await chrome.tabs.remove([pinnedNew.id, refusedNew.id]);

  // notes.create must fire onCreated before/at callback time, so the mod cannot
  // rely on knowing its own new note id when the event arrives.
  let firedBeforeCallback = false;
  let sawCallback = false;
  env.notes.onCreated.addListener(() => { if (!sawCallback) firedBeforeCallback = true; });
  await new Promise((res) => env.notes.create({ parentId: "1", title: "probe", type: "note" }, (n) => { sawCallback = true; res(n); }));
  ok("notes.create fires onCreated before its callback returns", firedBeforeCallback);

  // prefs.get may return a descriptor object rather than a value.
  const raw = await new Promise((res) => vivaldi.prefs.get("vivaldi.sync.session_name", res));
  ok("prefs.get can return a wrapper object (the [object Object] trap)",
     raw && typeof raw === "object" && !Array.isArray(raw), JSON.stringify(raw));

  // Promise form must work (the mod awaits these without callbacks).
  const q = await chrome.tabs.query({ windowId: 1 });
  ok("chrome.* returns a promise when no callback is passed", Array.isArray(q));

  // The tree must contain a trash node — folder resolution has to skip it.
  ok("notes tree exposes a trash node", (env.root.children || []).some((c) => c.type === "trash"));

  // ---- the stack model -----------------------------------------------------
  // These are how the doubles model tab stacks. Detaching a tab from a stack is
  // confirmed against a real build; the rest is still listed under "unverified"
  // in the fixture — the behaviour the mod's own comments assert, not something
  // captured from a running browser. If a Vivaldi update changes one, the mod is
  // wrong in a real browser while the suite stays green, so run VivaSync.diagMakeStack()
  // / VivaSync.diagAddToStack() / VivaSync.diagDetach() after an update.
  const gidOf = (t) => JSON.parse(t.vivExtData).group || null;
  const sA = env.addTab({ url: "https://s1.example/", ws: env.WS.WORK });
  const sB = env.addTab({ url: "https://s2.example/", ws: env.WS.WORK });
  const sC = env.addTab({ url: "https://s3.example/", ws: env.WS.WORK });
  const grp = await vivaldi.tabsPrivate.move({
    tabIds: [sA.id, sB.id, sC.id], target: sA.id,
    tweaks: ["do-not-reparent", "create-new-group", "target-is-tab"],
  });
  ok("tabsPrivate.move({create-new-group}) returns the backend-assigned id",
     grp && typeof grp.group === "string", JSON.stringify(grp));
  // THE fact the engine's ADAPTER.awaitStack exists for: the call returns the
  // new group id, but the tabs' vivExtData catches up afterwards. Publishing a
  // snapshot inside this window says "no stack", and the peer takes its own
  // stack apart in response — the endless regroup/ungroup loop seen in the
  // field. Anyone who "fixes" this double by applying the change synchronously
  // deletes the only coverage of that bug.
  ok("...but the grouping is NOT visible in vivExtData yet",
     gidOf(sA) === null, String(gidOf(sA)));
  await env.sleep(300);
  ok("...and every listed tab really joins that group once it lands",
     gidOf(sA) === grp.group && gidOf(sA) === gidOf(sB) && gidOf(sB) === gidOf(sC),
     [gidOf(sA), gidOf(sB), gidOf(sC)].join(","));

  await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: grp.group, groupTitle: "SELFTEST" });
  await env.sleep(300);
  ok("setGroupProperties names the whole stack",
     JSON.parse(sB.vivExtData).fixedGroupTitle === "SELFTEST", sB.vivExtData);

  // A stack's COLOUR travels the same call, one property at a time — Vivaldi's
  // own UI passes groupTitle alone (setFixedStackTitle) or groupColor alone
  // (setStackColor). A double that wrote both on every call would hide the
  // engine wiping a stack's colour each time it re-asserted the name, and vice
  // versa; the engine assumes precisely this and asserts the two separately.
  await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: grp.group, groupColor: "color4" });
  await env.sleep(300);
  ok("setGroupProperties colours the whole stack, and keeps its name",
     JSON.parse(sB.vivExtData).groupColor === "color4" &&
       JSON.parse(sA.vivExtData).groupColor === "color4" &&
       JSON.parse(sB.vivExtData).fixedGroupTitle === "SELFTEST",
     sB.vivExtData);
  await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: grp.group, groupTitle: "SELFTEST2" });
  await env.sleep(300);
  ok("...and renaming it keeps the colour",
     JSON.parse(sB.vivExtData).groupColor === "color4" &&
       JSON.parse(sB.vivExtData).fixedGroupTitle === "SELFTEST2",
     sB.vivExtData);
  await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: grp.group, groupColor: "" });
  await env.sleep(300);
  ok("...and the empty string clears it, the way Vivaldi's own menu does",
     JSON.parse(sB.vivExtData).groupColor === undefined, sB.vivExtData);
  // env.setStackColor is the USER colouring a stack: the same state change, and
  // the vivExtData update the engine hears it through.
  let colorEvents = 0;
  const onColor = (id, info) => { if (info.vivExtData != null) colorEvents++; };
  chrome.tabs.onUpdated.addListener(onColor);
  env.setStackColor(grp.group, "color9");
  ok("env.setStackColor colours every member and announces it",
     env.stacks(env.WS.WORK).find((x) => x.gid === grp.group).color === "color9" &&
       colorEvents === env.TABS.filter((t) => gidOf(t) === grp.group).length,
     `${env.layout(env.WS.WORK)} events=${colorEvents}`);
  env.setStackColor(grp.group, null);
  await vivaldi.tabsPrivate.setGroupProperties({ groupExtId: grp.group, groupTitle: "SELFTEST" });
  await env.sleep(300);
  // env.moveToWorkspace is the user's "Move to workspace": the workspace
  // changes and nothing else — a stack arrives a stack, name intact — and the
  // vivExtData update announces it (test/18-move-in.js).
  const memberIds = env.TABS.filter((t) => gidOf(t) === grp.group).map((t) => t.id);
  colorEvents = 0;
  env.moveToWorkspace(memberIds, env.WS.PERSONAL);
  const moved = env.stacks(env.WS.PERSONAL).find((x) => x.gid === grp.group);
  ok("env.moveToWorkspace moves a stack whole, named, and announces it",
     !!moved && moved.name === "SELFTEST" && moved.urls.length === memberIds.length &&
       !env.stacks(env.WS.WORK).some((x) => x.gid === grp.group) && colorEvents === memberIds.length,
     `${env.layout(env.WS.PERSONAL)} events=${colorEvents}`);
  env.moveToWorkspace(memberIds, env.WS.WORK);

  // A new tab lands in the active TAB's stack, not merely the active workspace.
  // The entire phase-1/phase-2 split in applyDesired exists because of this.
  for (const t of env.TABS) t.active = false;
  sA.active = true;
  const swallowed = await chrome.tabs.create({ windowId: 1, url: "https://s4.example/" });
  ok("a new tab joins the ACTIVE TAB'S stack", gidOf(swallowed) === gidOf(sA),
     String(gidOf(swallowed)));
  // ...pinned or not: a pinned tab arriving while the user sits in a stack
  // becomes that stack's first member, and the engine has to take such a tab
  // out itself (test/15 §11). A double that kept pinned newborns out of stacks
  // would pass the suite over that bug.
  const pinnedSwallowed = await chrome.tabs.create({
    windowId: 1, url: "https://s4-pinned.example/", pinned: true,
    vivExtData: JSON.stringify({ workspaceId: env.WS.WORK }),
  });
  ok("a PINNED new tab joins the active tab's stack just the same",
     pinnedSwallowed.pinned === true && gidOf(pinnedSwallowed) === gidOf(sA),
     `pinned=${pinnedSwallowed.pinned} group=${gidOf(pinnedSwallowed)}`);
  await chrome.tabs.remove([pinnedSwallowed.id]);

  // ...and ADAPTER.detachFromStack's first attempt is a move that is allowed to
  // reparent. Without this the mod cannot put a tab back at top level at all.
  await vivaldi.tabsPrivate.move({
    tabIds: [swallowed.id], target: -1, windowId: 1, workspaceId: env.WS.WORK, tweaks: [],
  });
  await env.sleep(300);
  ok("a move without 'do-not-reparent' takes the tab out of its stack",
     gidOf(swallowed) === null, String(gidOf(swallowed)));

  // The most valuable thing the double models: the real API validates the
  // tweak vocabulary and throws on anything outside it. A double that accepted
  // whatever it was handed would keep the suite green while a call with an
  // invented name ("group-follows-target") throws on every call in the browser
  // (SPEC.md F9).
  let threw = null;
  try {
    await vivaldi.tabsPrivate.move({
      tabIds: [sA.id], target: sB.id, tweaks: ["group-follows-target"],
    });
  } catch (e) { threw = e; }
  ok("tabsPrivate.move REJECTS a tweak outside the real vocabulary",
     threw instanceof TypeError && /Value must be one of/.test(threw.message),
     String(threw && threw.message).slice(0, 60));

  // Adding a tab to an EXISTING stack is Vivaldi's own drop-onto-a-stack call:
  // tweaks ["do-not-reparent","on","create-group"], targeting the GROUP id (not
  // a tab, and deliberately no "target-is-tab"). It settles with the same delay
  // as every other grouping op.
  const j1 = env.addTab({ url: "https://s5.example/", ws: env.WS.WORK });
  await vivaldi.tabsPrivate.move({
    tabIds: [j1.id], target: grp.group,
    tweaks: ["do-not-reparent", "on", "create-group"],
  });
  ok("...joining an existing stack is not visible in vivExtData yet either",
     gidOf(j1) === null, String(gidOf(j1)));
  await env.sleep(300);
  ok("'on'+'create-group' targeting a GROUP id joins that stack, name and all",
     gidOf(j1) === gidOf(sA) && JSON.parse(j1.vivExtData).fixedGroupTitle === "SELFTEST",
     j1.vivExtData);
  await chrome.tabs.remove([j1.id]);

  // A build that IGNORES the join has to be modelled as a plain no-op, not as
  // an accidental ungroup — the engine's createStack fallback only makes sense
  // if the tab simply stays where it was. test/06 §7 drives this switch.
  env.setGroupingSupport({ addToStack: false });
  const j2 = env.addTab({ url: "https://s6.example/", ws: env.WS.WORK });
  await vivaldi.tabsPrivate.move({
    tabIds: [j2.id], target: grp.group,
    tweaks: ["do-not-reparent", "on", "create-group"],
  });
  await env.sleep(300);
  ok("a build that ignores the join is a no-op, not an ungroup",
     gidOf(j2) === null && gidOf(sA) !== null, [gidOf(j2), gidOf(sA)].join(","));
  env.setGroupingSupport({ addToStack: true });
  await chrome.tabs.remove([j2.id]);

  // And the documented way OUT of a stack: Vivaldi's removeFromTabStack moves
  // with "ungroup". detachFromStack tries this first now.
  const j3 = env.addTab({ url: "https://s7.example/", ws: env.WS.WORK });
  await vivaldi.tabsPrivate.move({
    tabIds: [j3.id], target: grp.group,
    tweaks: ["do-not-reparent", "on", "create-group"],
  });
  await env.sleep(300);
  await vivaldi.tabsPrivate.move({
    tabIds: [j3.id], target: -1, windowId: 1, workspaceId: env.WS.WORK,
    tweaks: ["untile", "ungroup"],
  });
  await env.sleep(300);
  ok("the 'ungroup' tweak takes a tab back out of its stack",
     gidOf(j3) === null && gidOf(sA) !== null, [gidOf(j3), gidOf(sA)].join(","));
  await chrome.tabs.remove([j3.id]);

  // INDEX moves — the order phase's primitive, bundle.js's own moveToIndex: a
  // non-negative numeric target WITHOUT "target-is-tab" is a strip index in the
  // post-removal frame (chrome.tabs.move semantics), the movers keep their
  // relative order and their group under "do-not-reparent", the workspace named
  // in the call is kept, and chrome.tabs.onMoved fires once per moved tab. A
  // numeric target that happens to equal a tab id is still an index, not a
  // tab to stack onto.
  const p1 = env.addTab({ url: "https://p1.example/", ws: env.WS.WORK });
  const p2 = env.addTab({ url: "https://p2.example/", ws: env.WS.WORK });
  let movedEvents = [];
  chrome.tabs.onMoved.addListener((id, info) => movedEvents.push({ id, ...info }));
  const p1Index = p1.index;
  await vivaldi.tabsPrivate.move({
    tabIds: [p2.id], target: p1Index, windowId: 1, workspaceId: env.WS.WORK, tweaks: ["do-not-reparent"],
  });
  ok("a numeric target is a strip index: the tab lands there and the anchor shifts right",
     p2.index === p1Index && p1.index === p1Index + 1, `p2=${p2.index} p1=${p1.index}`);
  ok("...and chrome.tabs.onMoved fires for it, once",
     movedEvents.length === 1 && movedEvents[0].id === p2.id && movedEvents[0].toIndex === p1Index,
     JSON.stringify(movedEvents));
  movedEvents = [];
  // Whole run to the very front: three tabs, one call, group intact, order kept.
  const runBefore = env.TABS.filter((t) => gidOf(t) === grp.group).map((t) => t.id);
  await vivaldi.tabsPrivate.move({
    tabIds: runBefore, target: 0, windowId: 1, workspaceId: env.WS.WORK, tweaks: ["do-not-reparent"],
  });
  const runAfter = env.TABS.slice(0, runBefore.length).map((t) => t.id);
  ok("a whole run moved in one call lands contiguous, in order, group intact",
     JSON.stringify(runAfter) === JSON.stringify(runBefore) &&
       runBefore.every((id) => gidOf(env.TABS.find((t) => t.id === id)) === grp.group),
     `${JSON.stringify(runBefore)} -> ${JSON.stringify(runAfter)}`);
  ok("...one onMoved per moved tab", movedEvents.length === runBefore.length, String(movedEvents.length));
  // Post-removal frame: moving the FIRST tab to index 1 swaps it with the second.
  const first = env.TABS[0], second = env.TABS[1];
  await vivaldi.tabsPrivate.move({ tabIds: [first.id], target: 1, windowId: 1, tweaks: ["do-not-reparent"] });
  ok("the target index is in the post-removal frame (chrome.tabs.move semantics)",
     env.TABS[0] === second && env.TABS[1] === first, env.TABS.slice(0, 2).map((t) => t.id).join(","));
  // A numeric target equal to a tab id, without "target-is-tab", is still an index.
  const decoy = env.addTab({ url: "https://decoy.example/", ws: env.WS.WORK });
  await vivaldi.tabsPrivate.move({ tabIds: [p2.id], target: decoy.id, windowId: 1, tweaks: ["do-not-reparent"] });
  ok("a numeric target equal to some tab's id is an index, not that tab",
     gidOf(p2) === null && p2.index === Math.min(decoy.id, env.TABS.length - 1), `p2.index=${p2.index} decoy.id=${decoy.id}`);
  // Reordering a member INSIDE its own run keeps it in the stack: the target
  // sits between two members of the same group, and "do-not-reparent" leaves
  // membership alone. This is the in-stack order phase's one move.
  const runIds = env.TABS.filter((t) => gidOf(t) === grp.group).map((t) => t.id);
  const lastMember = env.TABS.find((t) => t.id === runIds[runIds.length - 1]);
  const firstMemberIndex = env.TABS.find((t) => t.id === runIds[0]).index;
  await vivaldi.tabsPrivate.move({
    tabIds: [lastMember.id], target: firstMemberIndex, windowId: 1,
    workspaceId: env.WS.WORK, tweaks: ["do-not-reparent"],
  });
  await env.sleep(200);
  ok("a member reordered inside its own run stays in the stack",
     gidOf(lastMember) === grp.group && lastMember.index === firstMemberIndex,
     `group=${gidOf(lastMember)} index=${lastMember.index}`);
  ok("...and the run is still contiguous",
     env.TABS.filter((t) => gidOf(t) === grp.group).map((t) => t.index)
       .every((v, i, a) => i === 0 || v === a[i - 1] + 1),
     env.TABS.filter((t) => gidOf(t) === grp.group).map((t) => t.index).join(","));

  // A PINNED STACK. Vivaldi pins a stack as a unit and it stays a stack in the
  // pinned strip (field, 2026-09-22), so the model must let a group's members
  // be pinned without the group evaporating — otherwise the engine's pinned
  // stacks would be green here and impossible in a browser. The engine can only
  // pin one member at a time, and whether a real build keeps the group through
  // that is unverified (VivaSync.diagPin -> memberPinKeptGroup), which is what
  // env.breakGroupOnPin models.
  const runNow = env.TABS.filter((t) => gidOf(t) === grp.group).map((t) => t.id);
  await chrome.tabs.update(runNow[0], { pinned: true });
  ok("pinning ONE member leaves it in the group",
     gidOf(env.TABS.find((t) => t.id === runNow[0])) === grp.group &&
       env.TABS.find((t) => t.id === runNow[0]).pinned === true,
     String(gidOf(env.TABS.find((t) => t.id === runNow[0]))));
  await chrome.tabs.update(runNow[0], { pinned: false });
  const pinnedIds = env.pinGroup(grp.group, true);
  ok("env.pinGroup pins every member and the stack survives",
     pinnedIds.length === runNow.length &&
       env.TABS.filter((t) => gidOf(t) === grp.group).every((t) => t.pinned) &&
       env.stacks(env.WS.WORK).find((x) => x.gid === grp.group).pinned === true,
     env.layout(env.WS.WORK));
  env.pinGroup(grp.group, false);
  // ...and the build on which it does NOT survive.
  env.breakGroupOnPin(true);
  await chrome.tabs.update(runNow[0], { pinned: true });
  ok("env.breakGroupOnPin models a build that drops the member out of the group",
     gidOf(env.TABS.find((t) => t.id === runNow[0])) === null,
     String(gidOf(env.TABS.find((t) => t.id === runNow[0]))));
  env.breakGroupOnPin(false);
  await chrome.tabs.update(runNow[0], { pinned: false });
  await vivaldi.tabsPrivate.move({
    tabIds: [runNow[0]], target: grp.group, tweaks: ["do-not-reparent", "on", "create-group"],
  });
  await env.sleep(200);

  // env.moveTab is the user dragging: same placement, same event.
  movedEvents = [];
  env.moveTab(p1.id, 0);
  ok("env.moveTab places the tab and fires onMoved", env.TABS[0] === p1 && movedEvents.length === 1, String(movedEvents.length));
  await chrome.tabs.remove([p1.id, p2.id, decoy.id]);

  // Which tab is active decides whether a new tab gets swallowed by a stack, so
  // any test that cares about grouping has to say. env.activate is how.
  env.activate("https://s1.example/");
  ok("env.activate makes exactly that tab the active one",
     env.TABS.filter((t) => t.active).length === 1 &&
     env.TABS.find((t) => t.active).url === "https://s1.example/",
     env.TABS.filter((t) => t.active).map((t) => t.url).join(","));

  // Closing the second-to-last member dissolves the stack — the survivor is a
  // plain tab again. Whether Vivaldi really clears `group` is unconfirmed,
  // which is exactly why buildSnapshot treats a group of one as a plain tab.
  await chrome.tabs.remove([sB.id, sC.id]);
  ok("a stack that drops below two members is dissolved", gidOf(sA) === null, String(gidOf(sA)));
  // tabs.remove REJECTS a stale id instead of skipping it, and one bad id in a
  // bulk call takes the whole list with it. The engine's delete phase has to
  // retry individually, or a single tab that dissolved on its own stops every
  // other deletion in that reconcile from happening.
  let removeThrew = null;
  try { await chrome.tabs.remove([sA.id, 999999]); } catch (e) { removeThrew = e; }
  ok("tabs.remove REJECTS a stale id rather than skipping it",
     removeThrew && /No such tab - 999999/.test(removeThrew.message),
     String(removeThrew && removeThrew.message));
  ok("...and the bulk call removed nothing at all",
     env.TABS.some((t) => t.id === sA.id), "sA was removed anyway");

  // Closing the ACTIVE tab activates another one — the browser is never left
  // without an active tab, and the mod derives the active WORKSPACE from it.
  for (const t of env.TABS) t.active = false;
  sA.active = true;
  await chrome.tabs.remove([sA.id]);
  ok("closing the active tab activates a surviving one in the same workspace",
     env.TABS.some((t) => t.active) &&
     Number(env.activeWorkspaceId()) === Number(env.WS.WORK),
     String(env.activeWorkspaceId()));
  await chrome.tabs.remove([swallowed.id]);

  // --- 2. surface comparison against the real browser -----------------------
  const stubNotes = Object.keys(vivaldi.notes).sort();
  const missingNotes = (fixture.notesApi || []).filter((k) => !stubNotes.includes(k));
  // Only the members the mod actually uses need to exist in the stub.
  const usedByMod = ["getTree", "get", "create", "update", "remove", "onChanged", "onCreated"];
  const missingUsed = usedByMod.filter((k) => !stubNotes.includes(k));
  ok("stub implements every vivaldi.notes member the mod uses", missingUsed.length === 0,
     missingUsed.join(",") || "none missing");
  ok("fixture's vivaldi.notes surface is still a superset of the stub's",
     missingNotes.length >= 0, `real-only members: ${missingNotes.join(",") || "none"}`);

  // Workspace list entries must carry the fields the adapter reads.
  const wsEntry = (await new Promise((res) => vivaldi.prefs.get("vivaldi.workspaces.list", res)))[0];
  const missingWsFields = (fixture.workspaceFields || []).filter((f) => !(f in wsEntry));
  ok("stub workspace entries carry the real fields the mod reads", missingWsFields.length === 0,
     missingWsFields.join(",") || "none missing");

  // Note nodes must carry the fields the transport reads.
  const noteNode = env.root.children.find((c) => c.type === "trash");
  const missingNoteFields = (fixture.noteFields || []).filter((f) => !(f in noteNode));
  ok("stub note nodes carry the real node fields", missingNoteFields.length === 0,
     missingNoteFields.join(",") || "none missing");

  // chrome.tabs.onUpdated was discarded by the double too. It is what starts a
  // tab's URL quiet period (URL_SETTLE_MS), so with it thrown away every test
  // of the settle window would pass without the window existing at all — the
  // exact shape of the tabs.remove bug this file was written for.
  const navTab = env.TABS.find((t) => !t.active);
  const seen = [];
  global.chrome.tabs.onUpdated.addListener((id, info, tab) => seen.push({ id, info, tab }));
  env.navigate(navTab.id, "https://navigated.example/?q=1");
  ok("tabs.onUpdated is delivered with the new url and the tab",
     seen.length === 1 && seen[0].id === navTab.id &&
       seen[0].info.url === "https://navigated.example/?q=1" &&
       seen[0].tab === navTab,
     JSON.stringify(seen.map((e) => e.info)));
  ok("...and env.navigate really moved the tab, rather than only signalling it",
     navTab.url === "https://navigated.example/?q=1" && navTab.status === "complete",
     `${navTab.url} (${navTab.status})`);
  env.navigate(navTab.id, "https://navigated.example/?q=2", "loading");
  ok("...and it can hold a tab mid-navigation, which suppresses publishing",
     navTab.status === "loading" && seen.length === 2 && seen[1].info.status === "loading",
     `${navTab.status}; ${seen.length} events`);

  // --- 3. the DOM double (opts.ui) ------------------------------------------
  // Same hazard as the browser stubs: the menu and dialogs are only as tested as
  // this model is faithful. These are the exact DOM behaviours the UI code
  // leans on. Created last — createEnv rebinds the globals the checks above use.
  const uenv = createEnv({ ui: true });
  const { doc, body, bar, dispatch } = uenv.ui;

  const outer = doc.createElement("div");
  outer.id = "probe-outer";
  const inner = doc.createElement("span");
  inner.textContent = "hello";
  outer.appendChild(inner);
  body.appendChild(outer);

  ok("appendChild links parentNode both ways", inner.parentNode === outer && outer.children[0] === inner);
  ok("getElementById finds a nested element", doc.getElementById("probe-outer") === outer);
  // Dismiss-on-outside-click is exactly this predicate.
  ok("contains() is true for descendants, false for outsiders",
     outer.contains(inner) && outer.contains(outer) && !outer.contains(bar));
  ok("textContent aggregates descendants", outer.textContent.includes("hello"), outer.textContent);
  // findBar() walks the window document for .statusbar and friends.
  ok("querySelector matches a class at depth", doc.querySelector(".statusbar") === bar);
  outer.remove();
  ok("remove() detaches from the tree", doc.getElementById("probe-outer") === null && outer.parentNode === null);
  // The Exceptions dialog focuses the input it appends and reads .value back.
  const inp = doc.createElement("input");
  inp.value = "x";
  inp.focus();
  ok("an input accepts focus() and holds its value", inp.value === "x" && inp.tagName === "INPUT");
  // Tick boxes in these dialogs are self-drawn spans that flip in their own
  // click handler (mkToggle) — Vivaldi styles native checkboxes into
  // invisibility. The double deliberately models NO checkbox behaviour, so a
  // raw <input type=checkbox> stays exactly as it was: anything that appeared
  // to work here would not work in the browser.
  const box = doc.createElement("input");
  box.type = "checkbox";
  body.appendChild(box);
  dispatch(box, "click");
  ok("a native checkbox is NOT flipped by a click — the mod must draw its own",
     !box.checked, String(box.checked));
  box.remove();

  // Menu dismissal registers on the document in the CAPTURE phase, so it must
  // see clicks aimed at any element, and it must run before that element's own
  // handler (which is what lets the handler close the menu first).
  const order = [];
  const target = doc.createElement("div");
  body.appendChild(target);
  const docFn = () => order.push("doc");
  doc.addEventListener("click", docFn, true);
  target.addEventListener("click", () => order.push("target"));
  dispatch(target, "click");
  ok("document capture listeners run before the target's own",
     JSON.stringify(order) === JSON.stringify(["doc", "target"]), JSON.stringify(order));
  doc.removeEventListener("click", docFn, true);
  order.length = 0;
  dispatch(target, "click");
  ok("removeEventListener actually detaches", JSON.stringify(order) === JSON.stringify(["target"]),
     JSON.stringify(order));

  // getViews() is how main.html reaches the visible window document at all; the
  // mod filters on the window.html href and a non-zero width.
  const views = chrome.extension.getViews();
  ok("getViews() returns a window.html view with a real width",
     views.length === 1 && /window\.html/.test(views[0].location.href) && views[0].innerWidth > 0,
     JSON.stringify(views.map((v) => v.location.href)));

  // chrome.tabs.onActivated is the ONLY signal the mod has that the user changed
  // workspace (the active tab's vivExtData is what defines the active
  // workspace). The double discarded its listeners, so the entire
  // switch-into-a-workspace path — the one a user performs to start syncing a
  // workspace at all — was unreachable from the suite and untested.
  const wsBeforeSwitch = env.activeWorkspaceId();
  await env.switchWorkspace(env.WS.PERSONAL, 0);
  // getTree() can report a note's content as "" while get() has the real
  // thing — the shape that made readConfig seed a second sync.config.
  {
    const n = await new Promise((res) =>
      global.vivaldi.notes.create({ parentId: "1", title: "hidden", type: "note", content: "{\"x\":1}" }, res));
    uenv.hideTreeContent(n.id);
    const treeHas = await new Promise((res) => global.vivaldi.notes.getTree((t) => {
      let hit = null;
      const walk = (x) => { if (String(x.id) === String(n.id)) hit = x; (x.children || []).forEach(walk); };
      t.forEach(walk);
      res(hit);
    }));
    const got = await new Promise((res) => global.vivaldi.notes.get(String(n.id), (r) => res(r[0])));
    ok("hideTreeContent: getTree reports \"\" while get() still returns the content",
       treeHas && treeHas.content === "" && got && got.content === "{\"x\":1}",
       `tree=${JSON.stringify(treeHas && treeHas.content)} get=${JSON.stringify(got && got.content)}`);
    uenv.hideTreeContent(n.id, false);
  }

  // ...and a failed notes.update leaves no lastError behind for the next call.
  {
    await new Promise((res) => global.vivaldi.notes.update("no-such-id", { content: "x" }, res));
    ok("notes.update on a missing id scopes lastError to its own callback",
       global.chrome.runtime.lastError == null, JSON.stringify(global.chrome.runtime.lastError));
  }

  ok("tabs.onActivated is delivered and moves the active workspace",
     String(Number(env.activeWorkspaceId())) === String(Number(env.WS.PERSONAL)) &&
       String(Number(wsBeforeSwitch)) !== String(Number(env.WS.PERSONAL)),
     `${wsBeforeSwitch} -> ${env.activeWorkspaceId()}`);

  console.log(`\n(fixture captured from Vivaldi ${fixture.vivaldiVersion || "unknown"})`);
  done();
})();
