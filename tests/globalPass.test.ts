import { test } from "node:test";
import assert from "node:assert/strict";
import { DEEP_SEARCH, estimateEpicenter } from "../src/engines/epicenterEstimation";
import { haversineKm, makeDetections, stationGrid, type Detection } from "./helpers";

// 走時テーブル未設定時のフォールバック(震源距離 / P波速度)。epicenterEstimation.tsのP_WAVE_SPEED_KM_S。
const P_SPEED = 6.8;
const NEAR_FIXED_WEIGHT_KM = 50; // NEAR_STATION_FIXED_WEIGHT_RADIUS_KM

const stations = stationGrid(36, 138, 6, 0.5);
const ep = { lat: 36.0, lon: 138.2, depth: 300 };
const detections = makeDetections(stations, ep, 60, 400);
const event = { id: 1, detections, pointCount: detections.length };
const now = detections[detections.length - 1].detectedAt + 500;

// Global Passを必ず採用させる(誤差の改善比の条件を外す)。テスト後に必ず元へ戻す。
function withForcedGlobalPass<T>(fn: () => T): T {
  const saved = { ...DEEP_SEARCH };
  DEEP_SEARCH.globalPass = true;
  DEEP_SEARCH.globalBetterRatio = 1e9;
  try { return fn(); } finally { Object.assign(DEEP_SEARCH, saved); }
}

// 独立した検算: 結果の位置で、推定と同じ観測点の選び方・重みの到達時刻RMS(ms)を求める。
function oracleRmsMs(r: { lat: number; lon: number; depthKm: number }, dets: Detection[]): number {
  const first = dets.reduce((a, b) => (b.detectedAt < a.detectedAt ? b : a));
  let firstDist = Infinity;
  for (const d of dets) if (d !== first) firstDist = Math.min(firstDist, haversineKm(first.lat, first.lon, d.lat, d.lon));
  const dist = (d: Detection) => haversineKm(r.lat, r.lon, d.lat, d.lon);
  let sel = dets;
  if (dets.length > 50) {
    sel = [...dets].sort((a, b) => dist(a) - dist(b)).slice(0, 50);
    if (!sel.includes(first)) sel.push(first);
  }
  const w = (d: Detection) => (dist(d) <= NEAR_FIXED_WEIGHT_KM ? 1 : (firstDist / Math.max(dist(d), 0.001)) ** 2);
  const tt = (d: Detection) => (Math.hypot(dist(d), r.depthKm) / P_SPEED) * 1000;
  let ws = 0, wt = 0;
  for (const d of sel) { ws += w(d) * (d.detectedAt - tt(d)); wt += w(d); }
  const origin = ws / wt;
  let s2 = 0;
  for (const d of sel) { const diff = d.detectedAt - tt(d) - origin; s2 += w(d) * diff * diff; }
  return Math.sqrt(s2 / wt);
}

test("Global Pass採用時、評価指標は旧候補の値ではなく採用した候補で再計算される", () => {
  const cur = withForcedGlobalPass(() => { DEEP_SEARCH.globalPass = false; return estimateEpicenter(event, stations, now); });
  const forced = withForcedGlobalPass(() => estimateEpicenter(event, stations, now));
  assert.ok(cur && forced);
  assert.ok(forced.globalPass, "Global Passが採用されていること(前提)");
  assert.ok(!cur.globalPass);
  assert.notEqual(forced.depthKm, cur.depthKm, "前提: Global Passで深さが変わっていること");

  // 採用した候補の位置で独立に求めたRMSと一致する(旧実装は採用前の値を引き継いでいた)。
  const expected = oracleRmsMs(forced, detections);
  assert.ok(Math.abs(forced.timeRmsMs - expected) < 0.5, `RMS ${forced.timeRmsMs} vs 検算 ${expected}`);
  assert.notEqual(forced.timeRmsMs, cur.timeRmsMs);

  assert.notEqual(forced.errorLevel, cur.errorLevel);
  assert.ok(Number.isFinite(forced.errorLevel) && forced.errorLevel >= 0);
  assert.ok(forced.azimuthalGapDeg >= 0 && forced.azimuthalGapDeg <= 360);
  assert.equal(typeof forced.uniquenessConfirmed, "boolean");
  assert.ok(forced.estimationPointCount > 0 && forced.estimationPointCount <= 51);
});

test("Global Passを無効にした結果は、設定を元に戻した後も再現する(設定の取りこぼしがない)", () => {
  const before = estimateEpicenter(event, stations, now);
  withForcedGlobalPass(() => estimateEpicenter(event, stations, now));
  const after = estimateEpicenter(event, stations, now);
  assert.deepEqual(after, before);
});
