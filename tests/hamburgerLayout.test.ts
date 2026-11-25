import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JSモジュール
import { detectNewActiveEew } from "../src/app/hamburgerLayout.js";
// @ts-expect-error JSモジュール
import { loadStoredTabPlacement, normalizeTabPlacement, saveTabPlacement } from "../src/app/settingsStorage.js";

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

test("タブ配置: hamburger を保存・読み込みでき、不正な値は slide にする", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(loadStoredTabPlacement(), "slide");
  saveTabPlacement("hamburger");
  assert.equal(loadStoredTabPlacement(), "hamburger");
  saveTabPlacement("corner");
  assert.equal(loadStoredTabPlacement(), "corner");
  assert.equal(normalizeTabPlacement("xyz"), "slide");
  assert.equal(normalizeTabPlacement(null), "slide");
});
