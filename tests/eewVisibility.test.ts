import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEewVisibility, shouldRevealIncomingEew } from "../src/app/eewVisibility.js";

const active = { eventId: "a", cancelled: false, isWarnLevel: false };
const cancelled = { eventId: "b", cancelled: true, isWarnLevel: false };
const NONE: never[] = [];

test("通常時(リアルタイムタブでEEW発表中・地震は未選択): EEWの表示はそのまま", () => {
  const v = computeEewVisibility({ effectiveNav: "realtime", effectiveEews: [active], realtimeTabSelectedQuakeId: null, eewDetailOpen: true });
  assert.equal(v.eewHiddenBySelection, false);
  assert.deepEqual(v.displayedEews, [active]);
  assert.equal(v.displayedEewDetailOpen, true);
});

test("リアルタイムタブでEEW発表中に地震を選択: EEW(円・予想震度・カード・凡例)を隠し、選んだ地震の表示を出せる", () => {
  const eews = [active];
  const v = computeEewVisibility({ effectiveNav: "realtime", effectiveEews: eews, realtimeTabSelectedQuakeId: "q1", eewDetailOpen: true });
  assert.equal(v.eewHiddenBySelection, true);
  assert.deepEqual(v.displayedEews, [], "MapCanvas・BottomDockへは空のEEW一覧を渡す");
  assert.equal(v.displayedEewDetailOpen, false, "eewDetailOpenが残っていても、地図の震源・観測点・凡例・戻るボタンを塞がない");
});

test("選択を解除(戻る)すれば、発表中のEEWが元どおり表示される", () => {
  const eews = [active];
  const hidden = computeEewVisibility({ effectiveNav: "realtime", effectiveEews: eews, realtimeTabSelectedQuakeId: "q1", eewDetailOpen: true });
  const back = computeEewVisibility({ effectiveNav: "realtime", effectiveEews: eews, realtimeTabSelectedQuakeId: null, eewDetailOpen: true });
  assert.equal(hidden.eewHiddenBySelection, true);
  assert.equal(back.eewHiddenBySelection, false);
  assert.equal(back.displayedEews, eews, "元のEEW一覧(同じ配列)がそのまま渡る");
  assert.equal(back.displayedEewDetailOpen, true);
});

test("取消済みのEEWしか無い間は、選択してもEEWの扱いは変わらない(元々表示対象外)", () => {
  const eews = [cancelled];
  const v = computeEewVisibility({ effectiveNav: "realtime", effectiveEews: eews, realtimeTabSelectedQuakeId: "q1", eewDetailOpen: false });
  assert.equal(v.eewHiddenBySelection, false);
  assert.equal(v.displayedEews, eews);
});

test("リアルタイムタブ以外(津波・天気・設定など)では、何も変わらない", () => {
  for (const nav of ["quake", "tsunami", "weather", "alert", "settings"]) {
    const eews = [active];
    const v = computeEewVisibility({ effectiveNav: nav, effectiveEews: eews, realtimeTabSelectedQuakeId: "q1", eewDetailOpen: true });
    assert.equal(v.eewHiddenBySelection, false, nav);
    assert.equal(v.displayedEews, eews, nav);
    assert.equal(v.displayedEewDetailOpen, true, nav);
  }
});

test("EEWが無い時は、選択してもEEW一覧は空のまま(同じ配列を返す)", () => {
  const v = computeEewVisibility({ effectiveNav: "realtime", effectiveEews: NONE, realtimeTabSelectedQuakeId: "q1", eewDetailOpen: false });
  assert.equal(v.eewHiddenBySelection, false);
  assert.equal(v.displayedEews, NONE);
});

// ---- 隠れている間に来た速報を見逃さない ----
const sel = { selectedQuakeId: "q1", selectedQuakeOrigin: "realtime" };

test("リアルタイムタブで地震を選択中に、新しい速報が来たら、選択を解除して速報を見せる", () => {
  assert.equal(shouldRevealIncomingEew({ ...sel, existing: undefined, incoming: { cancelled: false, isWarnLevel: false } }), true);
  assert.equal(shouldRevealIncomingEew({ ...sel, existing: null, incoming: { cancelled: false, isWarnLevel: true } }), true);
});

test("続報で、予報から警報へ切り上がった時は、選択を解除して速報を見せる", () => {
  assert.equal(shouldRevealIncomingEew({ ...sel, existing: { isWarnLevel: false }, incoming: { cancelled: false, isWarnLevel: true } }), true);
});

test("同じ段階の続報・警報のままの続報・取消では、選択を解除しない(見ている地震を奪わない)", () => {
  assert.equal(shouldRevealIncomingEew({ ...sel, existing: { isWarnLevel: false }, incoming: { cancelled: false, isWarnLevel: false } }), false);
  assert.equal(shouldRevealIncomingEew({ ...sel, existing: { isWarnLevel: true }, incoming: { cancelled: false, isWarnLevel: true } }), false);
  assert.equal(shouldRevealIncomingEew({ ...sel, existing: { isWarnLevel: true }, incoming: { cancelled: false, isWarnLevel: false } }), false);
  assert.equal(shouldRevealIncomingEew({ ...sel, existing: undefined, incoming: { cancelled: true, isWarnLevel: false } }), false, "最初から取消の速報は見せる必要が無い");
  assert.equal(shouldRevealIncomingEew({ ...sel, existing: { isWarnLevel: false }, incoming: { cancelled: true, isWarnLevel: true } }), false);
});

test("地震タブで選んだ地震(リアルタイムタブでは無視される選択)や、未選択の時は、何もしない", () => {
  const incoming = { cancelled: false, isWarnLevel: true };
  assert.equal(shouldRevealIncomingEew({ selectedQuakeId: "q1", selectedQuakeOrigin: "quake", existing: undefined, incoming }), false, "地震タブ側の選択は残す(速報後に戻れるように)");
  assert.equal(shouldRevealIncomingEew({ selectedQuakeId: "q1", selectedQuakeOrigin: null, existing: undefined, incoming }), false);
  assert.equal(shouldRevealIncomingEew({ selectedQuakeId: null, selectedQuakeOrigin: null, existing: undefined, incoming }), false);
});

// ---- 画面の判定(App.jsx・BottomDock.jsxの条件式を写したもの): 3つの状態で、何が見えるか ----
// 注意: 式はApp.jsx/BottomDock.jsxから写している。そちらの式を変えた時は、ここも合わせること。
function screen(state: { selectedQuakeId: string | null; eewDetailOpen: boolean }) {
  const effectiveNav = "realtime";
  const eews = [{ eventId: "a", cancelled: false, isWarnLevel: false }];
  const v = computeEewVisibility({ effectiveNav, effectiveEews: eews, realtimeTabSelectedQuakeId: state.selectedQuakeId, eewDetailOpen: state.eewDetailOpen });
  const hasActiveEew = v.displayedEews.some((e) => !e.cancelled);                                  // BottomDock: EEWカード
  const showQuakeMapLayers = !v.displayedEewDetailOpen && (effectiveNav === "realtime" && state.selectedQuakeId != null); // App: 震源・観測点・震度塗り分け
  const eewMapLegendVisible = v.displayedEewDetailOpen || v.displayedEews.some((e) => !e.cancelled); // App: 予想震度凡例
  const quakeLegendVisible = !v.displayedEewDetailOpen && state.selectedQuakeId != null;            // App: 震度凡例
  const backButtonVisible = !v.displayedEewDetailOpen && state.selectedQuakeId != null;             // BottomDock: 戻るボタン
  return { eewCards: hasActiveEew, eewCircles: v.displayedEews.length > 0, eewLegend: eewMapLegendVisible, quakeMapLayers: showQuakeMapLayers, quakeLegend: quakeLegendVisible, backButton: backButtonVisible };
}

test("画面: EEW発表中(リアルタイムタブ)の、選択前→選択中→戻った後で、見えるものが入れ替わる", () => {
  // 新規の速報で、eewDetailOpenは自動的にtrueになっている(リアルタイムタブには閉じるボタンが無く、trueのまま残る)
  const before = screen({ selectedQuakeId: null, eewDetailOpen: true });
  assert.deepEqual(before, { eewCards: true, eewCircles: true, eewLegend: true, quakeMapLayers: false, quakeLegend: false, backButton: false }, "選択前: EEWだけ");

  const selected = screen({ selectedQuakeId: "q1", eewDetailOpen: true });
  assert.deepEqual(selected, { eewCards: false, eewCircles: false, eewLegend: false, quakeMapLayers: true, quakeLegend: true, backButton: true },
    "選択中: EEW(カード・PS円・予想震度・凡例)は消え、選んだ地震の震源・観測点・震度凡例・戻るボタンが出る");

  const back = screen({ selectedQuakeId: null, eewDetailOpen: true });
  assert.deepEqual(back, before, "戻った後: 発表中のEEWが元どおり");
});

test("画面: (修正前の挙動の再現) eewDetailOpenが残ったまま選択すると、EEWが残り、選んだ地震が出なかった", () => {
  // 修正前は、computeEewVisibilityを通さず、そのままeffectiveEews・eewDetailOpenを使っていた
  const eews = [{ eventId: "a", cancelled: false, isWarnLevel: false }];
  const eewDetailOpen = true, selectedQuakeId = "q1";
  const oldEewCards = eews.some((e) => !e.cancelled);
  const oldQuakeMapLayers = !eewDetailOpen && selectedQuakeId != null;
  const oldBackButton = !eewDetailOpen && selectedQuakeId != null;
  assert.deepEqual({ oldEewCards, oldQuakeMapLayers, oldBackButton }, { oldEewCards: true, oldQuakeMapLayers: false, oldBackButton: false });
});
