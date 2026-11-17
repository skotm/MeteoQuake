import test from "node:test";
import assert from "node:assert/strict";
import { ZERO_INSETS, insetsToRect, rectToInsets, pinchRect, pinchSample, clampRect, isFullScreen, sanitizeInsets } from "../src/displayArea.ts";

const VW = 400, VH = 800;
test("初期は全画面で、余白との相互変換ができる", () => {
  assert.ok(isFullScreen(ZERO_INSETS));
  assert.deepEqual(insetsToRect(ZERO_INSETS, VW, VH), { l: 0, t: 0, r: VW, b: VH });
  const i = { top: 40, right: 10, bottom: 30, left: 20 };
  assert.deepEqual(rectToInsets(insetsToRect(i, VW, VH), VW, VH), i);
});
test("ピンチで縮めると中心を保って小さくなる", () => {
  const rect0 = insetsToRect(ZERO_INSETS, VW, VH);
  const p0 = pinchSample(100, 300, 300, 500); // dx=200, dy=200
  const p1 = pinchSample(150, 350, 250, 450); // 半分
  const r = pinchRect(rect0, p0, p1, VW, VH);
  assert.deepEqual(r, { l: 100, t: 200, r: 300, b: 600 });
});
test("2本指の中心を動かすと位置も動き、画面外には出ない", () => {
  const rect0 = { l: 100, t: 200, r: 300, b: 600 };
  const p0 = pinchSample(150, 350, 250, 450);
  const moved = pinchRect(rect0, p0, pinchSample(950, 350, 1050, 450), VW, VH);
  assert.equal(moved.r, VW);
  assert.equal(moved.r - moved.l, 200);
});
test("小さくしすぎない・大きくしすぎない", () => {
  const rect0 = { l: 100, t: 200, r: 300, b: 600 };
  const tiny = pinchRect(rect0, pinchSample(0, 0, 200, 200), pinchSample(100, 100, 130, 130), VW, VH);
  assert.ok(tiny.r - tiny.l >= 160 && tiny.b - tiny.t >= 160);
  const huge = clampRect({ l: -500, t: -500, r: 5000, b: 5000 }, VW, VH);
  assert.deepEqual(huge, { l: 0, t: 0, r: VW, b: VH });
});
test("保存値の読み込みは不正な値を0にする", () => {
  assert.deepEqual(sanitizeInsets({ top: -5, right: "x", bottom: 12.4, left: NaN }), { top: 0, right: 0, bottom: 12, left: 0 });
  assert.deepEqual(sanitizeInsets(null), ZERO_INSETS);
});
