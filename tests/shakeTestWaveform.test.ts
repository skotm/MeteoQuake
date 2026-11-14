import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WAVE_BASELINE_INTENSITY, buildSiteLookup, faultSamples, peakIntensityAt, prepareRealisticWaves, ruptureLengthKm,
  siteAmplification, stableUnit, waveValueAt, DEFAULT_FAULT,
} from "../src/engines/shakeTestWaveform";
import { computeShakeTestValues, isShakeTestFinished, prepareShakeTest } from "../src/engines/shakeTestSimulation";
import { stationGrid } from "./helpers";

// WE-Simulatorの式(1.43M − 0.32(M−7.4)² − 2.12log10(R+20) − 0.0042R + 地盤 − 0.95、上限7)と、許容±0.01で一致すること。
test("最終震度の式: WE-Simulatorの式と一致(M・震源距離・地盤補正・M7.4超の飽和・上限7)", () => {
  assert.ok(Math.abs(peakIntensityAt(6.0, 50, 0) - 3.5084) < 0.01);
  assert.ok(Math.abs(peakIntensityAt(7.8, 120, 0.3) - 5.399) < 0.01);
  assert.equal(peakIntensityAt(9.0, 30, 0), 7);
  assert.ok(Math.abs(peakIntensityAt(4.0, 10, 0) - 1.5965) < 0.01);
  // 遠方では0に丸めず、平常値を下回りうる(揺れが届かない観測点を除くため)
  assert.ok(peakIntensityAt(3.0, 600, 0) < WAVE_BASELINE_INTENSITY + 3);
});

test("地盤増幅: ARV・AVS30から-0.45〜+0.75。データが無ければ補正なし", () => {
  assert.ok(Math.abs(siteAmplification({ arv: 1.44, avs: 260.2 }) - 0.366) < 0.01);
  assert.equal(siteAmplification(null), 0);
  assert.equal(siteAmplification({}), 0);
  assert.ok(siteAmplification({ arv: 100, avs: 80 }) <= 0.75);
  assert.ok(siteAmplification({ arv: 0.2, avs: 900 }) >= -0.45);
  assert.ok(siteAmplification({ arv: 2.0, avs: 150 }) > siteAmplification({ arv: 1.0, avs: 400 }));
});

test("断層長: M6.6未満は点震源(0)。M7で約49km、巨大地震は520kmで頭打ち", () => {
  assert.equal(ruptureLengthKm(6.5), 0);
  assert.ok(Math.abs(ruptureLengthKm(7.0) - 48.98) < 0.1);
  assert.equal(ruptureLengthKm(9.0), 520);
});

test("気象庁観測点の地盤値: 最寄りを返す。40kmより遠ければ補正なし(null)", () => {
  const master = [
    { lat: "35.00", lon: "139.00", ARV: "1.5", AVS30: "250" },
    { lat: "35.30", lon: "139.00", ARV: "0.8", AVS30: "600" },
  ];
  const look = buildSiteLookup(master);
  assert.equal(look(35.01, 139.0)!.arv, 1.5);
  assert.equal(look(35.28, 139.0)!.arv, 0.8);
  assert.equal(look(38.0, 142.0), null);
  assert.equal(buildSiteLookup([])(35, 139), null);
});

test("有限断層: M6.6未満は震源1点。M7.5(両側)は震源を中心に左右対称で、遅れは震源から遠いほど大きい", () => {
  assert.equal(faultSamples({ lat: 35, lon: 139, magnitude: 6.0 }, DEFAULT_FAULT).length, 1);
  assert.equal(faultSamples({ lat: 35, lon: 139, magnitude: 7.5 }, null).length, 1);
  const both = faultSamples({ lat: 35, lon: 139, magnitude: 7.5 }, { strikeDeg: 0, direction: "both", ruptureSpeedKmS: 2.8 });
  assert.ok(both.length >= 3 && both.length <= 17);
  assert.ok(both.some(s => s.delaySec === 0 && s.lat === 35));
  const lats = both.map(s => s.lat);
  assert.ok(Math.min(...lats) < 35 && Math.max(...lats) > 35);
  const far = both.reduce((a, b) => (Math.abs(b.lat - 35) > Math.abs(a.lat - 35) ? b : a));
  assert.ok(far.delaySec > 15 && far.delaySec < 20); // 断層長約97kmの片側約48km ÷ 2.8km/s ≒ 17秒
  const fwd = faultSamples({ lat: 35, lon: 139, magnitude: 7.5 }, { strikeDeg: 90, direction: "forward", ruptureSpeedKmS: 2.8 });
  assert.ok(fwd.every(s => s.lon >= 139 - 1e-9)); // 走向90度(東)へ進む
  const bwd = faultSamples({ lat: 35, lon: 139, magnitude: 7.5 }, { strikeDeg: 90, direction: "backward", ruptureSpeedKmS: 2.8 });
  assert.ok(bwd.every(s => s.lon <= 139 + 1e-9));
});

const quake = { lat: 36.0, lon: 139.7, magnitude: 6.3, depth: 20 };
const stations = stationGrid(36.0, 139.7, 9, 0.12);

test("波形: 同じ入力なら毎回同じ(観測点ごとの揺らぎは固定)", () => {
  const a = prepareRealisticWaves(quake, stations);
  const b = prepareRealisticWaves(quake, stations);
  for (const [id, st] of a) {
    assert.deepEqual(st, b.get(id));
    assert.equal(waveValueAt(st, 12345), waveValueAt(b.get(id)!, 12345));
  }
  assert.equal(stableUnit("x"), stableUnit("x"));
  assert.notEqual(stableUnit("x"), stableUnit("y"));
});

test("波形: P波の前はデータなし。P波の段階は弱く、S波の後にピークへ立ち上がり、その後は平常値近くまで減衰する", () => {
  const waves = prepareRealisticWaves(quake, stations);
  const st = [...waves.values()].find(w => w.peak > 3)!;
  assert.ok(st);
  assert.equal(waveValueAt(st, st.pArrivalMs - 1), undefined);
  const justBeforeS = waveValueAt(st, st.sArrivalMs - 1)!;
  assert.ok(justBeforeS < st.peak - 0.5, "P波の段階はピークより十分に弱い");
  assert.ok(justBeforeS < 3.2, "P波の段階の震度は約2.4〜3.0までに収まる(ノイズ込み)");
  const atPeak = waveValueAt(st, st.sArrivalMs + st.riseMs)!;
  assert.ok(Math.abs(atPeak - st.peak) < 0.1, `立ち上がりの終わりでピークに達する(${atPeak} vs ${st.peak})`);
  const late = waveValueAt(st, st.endMs)!;
  assert.ok(late < WAVE_BASELINE_INTENSITY + 0.3, `終了時刻には平常値近くに戻る(${late})`);
  // 観測全体で、ピーク(+ノイズ)を大きくは超えない
  let max = -Infinity;
  for (let t = st.pArrivalMs; t <= st.endMs; t += 100) max = Math.max(max, waveValueAt(st, t)!);
  assert.ok(max <= st.peak + st.noiseAmp + 0.01);
  assert.ok(max >= st.peak - 0.1);
});

test("波形: ピーク後は一定に保たず、強弱(複数のピーク)がある。台形ではない", () => {
  const waves = prepareRealisticWaves(quake, stations);
  const st = [...waves.values()].find(w => w.peak > 3)!;
  const t0 = st.sArrivalMs + st.riseMs;
  const samples: number[] = [];
  for (let t = t0; t < t0 + st.strongMs + 6000; t += 250) samples.push(waveValueAt(st, t)!);
  const range = Math.max(...samples) - Math.min(...samples);
  assert.ok(range > 0.15, `ピーク後の値に強弱がある(幅${range.toFixed(2)})`);
});

test("波形: 遠い観測点ほどS波の立ち上がりが長く、Mが大きいほど揺れが長く続く", () => {
  const near = prepareRealisticWaves(quake, stations);
  const arr = [...near.entries()].map(([id, w]) => ({ id, w })).filter(x => x.w.peak > 1);
  const sorted = arr.sort((a, b) => a.w.sArrivalMs - b.w.sArrivalMs);
  assert.ok(sorted[sorted.length - 1].w.riseMs > sorted[0].w.riseMs);
  const bigger = prepareRealisticWaves({ ...quake, magnitude: 7.3 }, stations);
  const id = sorted[0].id;
  const dur = (w: any) => w.endMs - w.sArrivalMs;
  assert.ok(dur(bigger.get(id)) > dur(near.get(id)!));
});

test("地盤: 柔らかく増幅の大きい地盤の観測点は、同じ距離でも震度が大きい", () => {
  const sts = [{ id: 1, lat: 36.5, lon: 139.7 }, { id: 2, lat: 36.5, lon: 139.7 }];
  const soft = prepareRealisticWaves(quake, [sts[0]], { siteLookup: () => ({ arv: 2.0, avs: 150, distKm: 1 }) });
  const hard = prepareRealisticWaves(quake, [sts[1]], { siteLookup: () => ({ arv: 0.7, avs: 700, distKm: 1 }) });
  assert.ok(soft.get(1)!.peak > hard.get(2)!.peak + 0.4);
});

test("揺れが届かない観測点(最終震度が平常値以下)は、データなしとして扱う。弱い地震で全国に広がらない", () => {
  const far = [{ id: 1, lat: 43.0, lon: 141.3 }];
  assert.equal(prepareRealisticWaves({ lat: 33.0, lon: 130.0, magnitude: 2.5, depth: 10 }, far).size, 0);
});

test("有限断層(M7.5): 断層の延長上にある観測点では、小震源が時間差で着くため揺れの継続が長くなる", () => {
  const q = { lat: 35.0, lon: 139.0, magnitude: 7.5, depth: 20 };
  const st = [{ id: 7, lat: 35.8, lon: 139.0 }]; // 走向0度(北)の延長上。断層の北端(約35.43度)から約41km
  const point = prepareRealisticWaves(q, st);
  const fault = prepareRealisticWaves(q, st, { fault: { strikeDeg: 0, direction: "both", ruptureSpeedKmS: 2.8 } });
  assert.ok(fault.get(7)!.endMs - fault.get(7)!.sArrivalMs > point.get(7)!.endMs - point.get(7)!.sArrivalMs);
  assert.ok(fault.get(7)!.sArrivalMs < point.get(7)!.sArrivalMs + 1000); // 近い小震源が先に着く
  assert.ok(fault.get(7)!.peak >= point.get(7)!.peak - 0.01); // 断層上では、点震源より近い距離で評価される
});

test("生成器: 既定は現実的なモデル。終了判定は、全観測点が平常値に戻るまで。簡易モデルも選べる", () => {
  const per = prepareShakeTest(quake, stations);
  const any = [...per.values()][0];
  assert.equal(any.model, "realistic");
  const values = computeShakeTestValues(per, 20000);
  assert.ok(values.size > 0);
  assert.equal(isShakeTestFinished(per, 5000), false);
  const lastEnd = Math.max(...[...per.values()].map((w: any) => w.endMs));
  assert.equal(isShakeTestFinished(per, lastEnd + 3001), true);
  const simple = prepareShakeTest(quake, stations, { model: "simple" });
  assert.equal([...simple.values()][0].model, undefined);
  assert.ok(computeShakeTestValues(simple, 20000).size > 0);
});
