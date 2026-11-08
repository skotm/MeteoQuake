import { test } from "node:test";
import assert from "node:assert/strict";
import { AreaFillCoordinator } from "../src/app/areaFillState.js";

// MapLibreのfeature-stateの代わり: areasソースの各区域の「今の色」(塗られていなければundefined)を持つ
function fakeMap() {
  const state = new Map<string, string | null>();
  const calls: [string, string | null][] = [];
  const coordinator = new AreaFillCoordinator((code: string, color: string | null) => { state.set(code, color); calls.push([code, color]); });
  const visible = () => Object.fromEntries([...state].filter(([, c]) => c != null));
  return { coordinator, visible, calls };
}
const QUAKE = new Map([["100", "#quake-a"], ["101", "#quake-b"], ["102", "#quake-c"]]);
const EEW = new Map([["101", "#eew-b"], ["102", "#eew-c"], ["200", "#eew-d"]]);

test("地震情報の塗り分けだけ: そのまま塗られ、空にすると消える", () => {
  const { coordinator, visible } = fakeMap();
  coordinator.setQuakeFill(QUAKE);
  assert.deepEqual(visible(), { "100": "#quake-a", "101": "#quake-b", "102": "#quake-c" });
  coordinator.setQuakeFill(new Map());
  assert.deepEqual(visible(), {});
});

test("EEWの塗り分けだけ: そのまま塗られ、空にすると消える", () => {
  const { coordinator, visible } = fakeMap();
  coordinator.setEewFill(EEW);
  assert.deepEqual(visible(), { "101": "#eew-b", "102": "#eew-c", "200": "#eew-d" });
  coordinator.setEewFill(new Map());
  assert.deepEqual(visible(), {});
});

test("両方が重なる区域は、EEWの色が優先される(従来の、EEWが後から塗って勝つ挙動と同じ)", () => {
  const { coordinator, visible } = fakeMap();
  coordinator.setQuakeFill(QUAKE);
  coordinator.setEewFill(EEW);
  assert.deepEqual(visible(), { "100": "#quake-a", "101": "#eew-b", "102": "#eew-c", "200": "#eew-d" });
});

test("【修正した不具合】EEWを隠した時(EEW側が自分の区域を消す)、重なった区域は地震情報の色に戻る", () => {
  const { coordinator, visible } = fakeMap();
  // EEW表示中 → 地震を選択(地震側が塗る → EEW側が空になる)。順序は、どちらが先でも同じ結果になること。
  coordinator.setEewFill(EEW);
  coordinator.setQuakeFill(QUAKE);
  coordinator.setEewFill(new Map());
  assert.deepEqual(visible(), { "100": "#quake-a", "101": "#quake-b", "102": "#quake-c" }, "重なった101・102が、消えずに地震の色になる");

  const other = fakeMap();
  other.coordinator.setEewFill(EEW);
  other.coordinator.setEewFill(new Map());   // 先にEEWが消え
  other.coordinator.setQuakeFill(QUAKE);     // 後から地震が塗る
  assert.deepEqual(other.visible(), visible());
});

test("【戻る】地震の選択を解除してEEWが再び表示される時、地震側の色が消えても、EEWの色は消えない", () => {
  const { coordinator, visible } = fakeMap();
  coordinator.setQuakeFill(QUAKE);                 // 地震を選択中(EEWは隠れている)
  coordinator.setQuakeFill(new Map());             // 戻る: 地震側が消える
  coordinator.setEewFill(EEW);                     // EEWが再び塗られる
  assert.deepEqual(visible(), { "101": "#eew-b", "102": "#eew-c", "200": "#eew-d" });

  // 逆順(EEWが先に塗られ、あとから地震側が消える)でも、EEWの色を巻き込んで消さない
  const rev = fakeMap();
  rev.coordinator.setQuakeFill(QUAKE);
  rev.coordinator.setEewFill(EEW);
  rev.coordinator.setQuakeFill(new Map());
  assert.deepEqual(rev.visible(), { "101": "#eew-b", "102": "#eew-c", "200": "#eew-d" }, "101・102のEEWの色が、地震側の消去に巻き込まれない");
});

test("色の更新(配色スキームの切り替え・続報)が反映され、無くなった区域は消える", () => {
  const { coordinator, visible } = fakeMap();
  coordinator.setEewFill(new Map([["1", "#a"], ["2", "#b"]]));
  coordinator.setEewFill(new Map([["2", "#b2"], ["3", "#c"]]));
  assert.deepEqual(visible(), { "2": "#b2", "3": "#c" });
});

test("同じ内容で再度呼ばれても、塗り直す(地図のデータが差し替わってfeature-stateが失われた場合の自己修復)", () => {
  const { coordinator, calls } = fakeMap();
  coordinator.setQuakeFill(QUAKE);
  const before = calls.length;
  coordinator.setQuakeFill(QUAKE);
  assert.ok(calls.length >= before + QUAKE.size, "全区域をもう一度塗る");
});
