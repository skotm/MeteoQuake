import { test } from "node:test";
import assert from "node:assert/strict";
import { calcPeakIntensity, createPeakIntensityModel } from "../src/engines/shakeTestSimulation";
import { lookupJmaPTimeSec, lookupJmaTravelTime, tableFromJSON } from "../src/engines/jmaTravelTime";
import { readFileSync } from "node:fs";

// ---- 基準(最適化前の実装を、そのまま写したもの)。新しい実装が、全入力で1ビットも違わないことを確かめる ----
function referencePeakIntensity(magnitudeJma: number, depthKm: number, distHypoKm: number, eventTypeCoeff = 0): number {
  const mw = magnitudeJma - 0.171;
  const faultLengthKm = Math.pow(10, 0.5 * mw - 1.85);
  const shortestDistKm = Math.max(distHypoKm - faultLengthKm * 0.5, 3);
  const logPgv600 =
    0.58 * mw +
    0.0038 * depthKm +
    eventTypeCoeff -
    Math.log10(shortestDistKm + 0.0028 * Math.pow(10, 0.5 * mw)) -
    0.002 * shortestDistKm -
    1.29;
  const pgv600 = Math.pow(10, logPgv600);
  const ARV = 1.0;
  const pgvSurface = pgv600 * 1.31 * ARV;
  let intensity = 2.68 + 1.72 * Math.log10(pgvSurface);
  if (intensity > 7.5) intensity = 7.5 + (intensity - 7.5) * 0.1;
  return intensity;
}

type Table = ReturnType<typeof tableFromJSON>;
function referenceLookup(table: Table | null, distanceKm: number, depthKm: number) {
  if (!table || table.distances.length === 0 || table.depths.length === 0) return null;
  const { distances, depths, pTimesSec, sTimesSec } = table;
  function bracket(arr: number[], v: number): [number, number, number] {
    const n = arr.length;
    if (n === 0) return [0, 0, 0];
    if (v <= arr[0]) return [0, 0, 0];
    if (v >= arr[n - 1]) return [n - 1, n - 1, 0];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid; }
    const span = arr[hi] - arr[lo];
    const t = span > 0 ? (v - arr[lo]) / span : 0;
    return [lo, hi, t];
  }
  const [xLo, xHi, tx] = bracket(distances, distanceKm);
  const [dLo, dHi, td] = bracket(depths, depthKm);
  const nx = distances.length;
  const idx = (di: number, xi: number) => di * nx + xi;
  function bilerp(arr: Float32Array): number | null {
    const v00 = arr[idx(dLo, xLo)], v01 = arr[idx(dLo, xHi)], v10 = arr[idx(dHi, xLo)], v11 = arr[idx(dHi, xHi)];
    if (!Number.isFinite(v00) || !Number.isFinite(v01) || !Number.isFinite(v10) || !Number.isFinite(v11)) return null;
    const top = v00 + (v01 - v00) * tx;
    const bottom = v10 + (v11 - v10) * tx;
    return top + (bottom - top) * td;
  }
  const pTimeSec = bilerp(pTimesSec);
  if (pTimeSec == null) return null;
  return { pTimeSec, sTimeSec: bilerp(sTimesSec) };
}

// 決定的な擬似乱数
function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

// 想定震度は、べき乗と対数の往復を省いた等価な式に置き換えたので、基準(旧実装)との差は、丸めによる最後の桁だけ。
// 許容は絶対値1e-12(実際の差は約1e-15)。
const INTENSITY_TOLERANCE = 1e-12;
function assertClose(actual: number, expected: number, message: string) {
  assert.ok(Math.abs(actual - expected) <= INTENSITY_TOLERANCE, `${message}: ${actual} vs ${expected} (差 ${Math.abs(actual - expected)})`);
}

test("想定震度: createPeakIntensityModelとcalcPeakIntensityが、基準(旧実装)と許容誤差1e-12以内で一致する", () => {
  const r = rng(1);
  let n = 0;
  let maxDiff = 0;
  for (let i = 0; i < 20000; i++) {
    const mag = 2 + r() * 7;          // M2〜9
    const depth = r() * 700;
    const dist = r() < 0.1 ? r() * 5 : r() * 2500; // 近距離(3km下限に掛かる)も含む
    const coef = r() < 0.2 ? (r() - 0.5) * 0.3 : 0;
    const expected = referencePeakIntensity(mag, depth, dist, coef);
    assertClose(calcPeakIntensity(mag, depth, dist, coef), expected, `calcPeakIntensity M${mag} d${depth} x${dist}`);
    assertClose(createPeakIntensityModel(mag, depth, coef)(dist), expected, `model M${mag} d${depth} x${dist}`);
    maxDiff = Math.max(maxDiff, Math.abs(createPeakIntensityModel(mag, depth, coef)(dist) - expected));
    n++;
  }
  // 境界: 7.5を超える強い揺れ(ソフトキャップ)・3km下限
  for (const [m, d, x] of [[9, 10, 3], [8.5, 0, 0], [7.5, 5, 1], [3.5, 700, 2000]] as const) {
    assertClose(createPeakIntensityModel(m, d)(x), referencePeakIntensity(m, d, x), `境界 M${m} d${d} x${x}`);
  }
  assert.equal(n, 20000);
  assert.ok(maxDiff < 1e-13, `最大の差 ${maxDiff}(想定: 1e-15程度)`);
});

const tableJson = JSON.parse(readFileSync(new URL("../public/jma-travel-time.json", import.meta.url), "utf8"));
const table = tableFromJSON(tableJson);

test("走時表: lookupJmaTravelTime/lookupJmaPTimeSecが、基準と全入力で厳密に一致する", () => {
  const r = rng(2);
  for (let i = 0; i < 20000; i++) {
    const dist = r() < 0.05 ? -r() * 10 : r() < 0.05 ? 2000 + r() * 500 : r() * 2000;   // 範囲外(下側・上側)も含む
    const depth = r() < 0.05 ? -r() * 10 : r() < 0.05 ? 700 + r() * 100 : r() * 700;
    const expected = referenceLookup(table, dist, depth);
    const got = lookupJmaTravelTime(table, dist, depth);
    assert.deepEqual(got, expected, `lookup d${dist} z${depth}`);
    assert.equal(lookupJmaPTimeSec(table, dist, depth), expected ? expected.pTimeSec : null, `P d${dist} z${depth}`);
  }
  // グリッド点ちょうど・端
  for (const d of [0, 2, 50, 200, 2000]) for (const z of [0, 2, 50, 200, 700]) {
    assert.deepEqual(lookupJmaTravelTime(table, d, z), referenceLookup(table, d, z));
    assert.equal(lookupJmaPTimeSec(table, d, z), referenceLookup(table, d, z)?.pTimeSec ?? null);
  }
});

test("走時表: 目盛りが狭義単調増加でない(重複・不等間隔)表でも、基準と一致する(二分探索へのフォールバック)", () => {
  const distances = [0, 5, 5, 20, 21, 90, 400, 400.5, 2000];   // 重複あり
  const depths = [0, 10, 11, 300, 700];
  const make = (n: number, seed: number) => { const r = rng(seed); return new Float32Array(n).map(() => 1 + r() * 300); };
  const weird = { distances, depths, pTimesSec: make(distances.length * depths.length, 7), sTimesSec: make(distances.length * depths.length, 8) } as unknown as Table;
  const r = rng(11);
  for (let i = 0; i < 5000; i++) {
    const dist = r() * 2100 - 20, depth = r() * 750 - 20;
    assert.deepEqual(lookupJmaTravelTime(weird, dist, depth), referenceLookup(weird, dist, depth));
    assert.equal(lookupJmaPTimeSec(weird, dist, depth), referenceLookup(weird, dist, depth)?.pTimeSec ?? null);
  }
  // 単調増加でも不等間隔(ヒント表の区画に、複数の目盛りが入る/入らない)
  const dist2 = [0, 1, 2, 3, 100, 101, 5000];
  const dep2 = [0, 1, 2, 3, 4, 700];
  const tab2 = { distances: dist2, depths: dep2, pTimesSec: make(dist2.length * dep2.length, 9), sTimesSec: make(dist2.length * dep2.length, 10) } as unknown as Table;
  for (let i = 0; i < 5000; i++) {
    const dist = r() * 5100 - 50, depth = r() * 720 - 10;
    assert.deepEqual(lookupJmaTravelTime(tab2, dist, depth), referenceLookup(tab2, dist, depth));
  }
});

test("走時表: テーブルが無い・空の時はnull", () => {
  assert.equal(lookupJmaPTimeSec(null, 10, 10), null);
  assert.equal(lookupJmaTravelTime(null, 10, 10), null);
  const empty = { distances: [], depths: [], pTimesSec: new Float32Array(0), sTimesSec: new Float32Array(0) };
  assert.equal(lookupJmaPTimeSec(empty, 10, 10), null);
  assert.equal(lookupJmaTravelTime(empty, 10, 10), null);
});
