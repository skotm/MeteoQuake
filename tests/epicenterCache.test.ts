import { test } from "node:test";
import assert from "node:assert/strict";
import { EpicenterEstimator } from "../src/engines/epicenterEstimation";
import { makeDetections, stationGrid, T0 } from "./helpers";

const stations = stationGrid(38, 142, 4, 0.3);
const detections = makeDetections(stations, { lat: 38.1, lon: 141.9, depth: 20 }, 20, 100);
const now0 = T0 + 10_000;

function makeEvent(extra: Record<string, unknown>) {
  return { id: 1, detections, pointCount: detections.length, ...extra };
}
// 推定器が内部に記録している、直近に「再計算した」時刻。再利用しただけの呼び出しでは変わらない。
function computedAt(est: EpicenterEstimator): number | undefined {
  return est.cache.get(1)?.computedAt;
}

test("観測点数もrevisionも同じなら再計算しない", () => {
  const est = new EpicenterEstimator();
  est.updateAll([makeEvent({ revision: 3 })], stations, now0);
  assert.equal(computedAt(est), now0, "初回は計算される");
  assert.ok(est.cache.get(1)?.result, "初回の推定結果があること");
  est.updateAll([makeEvent({ revision: 3 })], stations, now0 + 5_000);
  assert.equal(computedAt(est), now0);
});

test("観測点数が増えたら、即座に再計算する(従来どおり)", () => {
  const est = new EpicenterEstimator();
  est.updateAll([makeEvent({ revision: 3 })], stations, now0);
  const more = makeDetections(stations, { lat: 38.1, lon: 141.9, depth: 20 }, 24, 100);
  est.updateAll([{ id: 1, detections: more, pointCount: more.length, revision: 3 }], stations, now0 + 100);
  assert.equal(computedAt(est), now0 + 100);
});

test("点数が同じでrevisionだけ変わった場合: 5秒の間隔内は再利用、間隔を過ぎたら再計算", () => {
  const est = new EpicenterEstimator();
  est.updateAll([makeEvent({ revision: 3 })], stations, now0);
  est.updateAll([makeEvent({ revision: 4 })], stations, now0 + 4_000);
  assert.equal(computedAt(est), now0, "5秒未満は間引く");
  est.updateAll([makeEvent({ revision: 4 })], stations, now0 + 5_000);
  assert.equal(computedAt(est), now0 + 5_000, "5秒以上経ったら、持ち越していたrevisionの差で再計算する");
  est.updateAll([makeEvent({ revision: 4 })], stations, now0 + 20_000);
  assert.equal(computedAt(est), now0 + 5_000, "revisionが同じなら再計算しない");
});

test("時刻が巻き戻っても(リプレイ)、revisionの変化を取りこぼさない", () => {
  const est = new EpicenterEstimator();
  est.updateAll([makeEvent({ revision: 3 })], stations, now0);
  est.updateAll([makeEvent({ revision: 4 })], stations, now0 - 30_000);
  assert.equal(computedAt(est), now0 - 30_000);
});

test("revisionを持たないイベント(グリッド検知)は、従来どおり観測点数だけで判定する", () => {
  const est = new EpicenterEstimator();
  est.updateAll([makeEvent({})], stations, now0);
  est.updateAll([makeEvent({})], stations, now0 + 60_000);
  assert.equal(computedAt(est), now0);
});
