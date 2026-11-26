import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JSモジュール
import { detectNewActiveEew } from "../src/app/hamburgerLayout.js";
// @ts-expect-error JSモジュール
import { TAB_PLACEMENT_VARIANTS_ENABLED, loadStoredTabPlacement, normalizeTabPlacement, resolveTabPlacement } from "../src/app/settingsStorage.js";

const eew = (eventId: string, extra = {}) => ({ eventId, cancelled: false, ...extra });

test("初回(prevがnull)は、すでにある速報では『新しく届いた』とみなさない", () => {
  const r = detectNewActiveEew(null, [eew("a")]);
  assert.equal(r.arrived, false);
  assert.deepEqual([...r.ids], ["a"]);
});

test("新しいidの速報が増えた時だけ arrived になる(続報・同じ速報では動かさない)", () => {
  const first = detectNewActiveEew(null, [eew("a")]);
  assert.equal(detectNewActiveEew(first.ids, [eew("a")]).arrived, false);
  assert.equal(detectNewActiveEew(first.ids, [eew("a"), eew("b")]).arrived, true);
});

test("取消・終了では arrived にならず、取消済みは数えない", () => {
  const prev = new Set(["a"]);
  assert.equal(detectNewActiveEew(prev, [eew("a", { cancelled: true })]).arrived, false);
  assert.equal(detectNewActiveEew(prev, []).arrived, false);
  assert.equal(detectNewActiveEew(prev, [eew("b", { cancelled: true })]).arrived, false);
});

test("過去の速報の再生(isReplay)では切り替えない。試験配信・シミュレーションは切り替える", () => {
  const prev = new Set<string>();
  assert.equal(detectNewActiveEew(prev, [eew("r", { isReplay: true })]).arrived, false);
  assert.equal(detectNewActiveEew(prev, [eew("t", { isTest: true })]).arrived, true);
  assert.equal(detectNewActiveEew(prev, [eew("s", { isSimulation: true })]).arrived, true);
});

test("タブ配置: 右上配置・ハンバーガー式は、いったん無効(常に slide)。保存済みの値は消さない", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(TAB_PLACEMENT_VARIANTS_ENABLED, false);
  assert.equal(loadStoredTabPlacement(), "slide");
  // 以前に保存していた値があっても、今は slide で読み込む(値そのものは残る)
  store.set("tabPlacement", "hamburger");
  assert.equal(loadStoredTabPlacement(), "slide");
  assert.equal(store.get("tabPlacement"), "hamburger");
  assert.equal(resolveTabPlacement("corner"), "slide");
});

test("タブ配置: 有効にすれば、corner / hamburger が元どおり使える。不正な値は slide", () => {
  assert.equal(resolveTabPlacement("hamburger", true), "hamburger");
  assert.equal(resolveTabPlacement("corner", true), "corner");
  assert.equal(resolveTabPlacement("slide", true), "slide");
  assert.equal(resolveTabPlacement("xyz", true), "slide");
  assert.equal(resolveTabPlacement(null, true), "slide");
  assert.equal(normalizeTabPlacement("hamburger"), "hamburger");
});
