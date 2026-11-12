import { test } from "node:test";
import assert from "node:assert/strict";
import { computeShakeTestValues, prepareShakeTest } from "../src/engines/shakeTestSimulation";
import { AnalysisPipeline, type AnalysisTickInput } from "../src/analysis/analysisPipeline";
import { collectSimStationIds, isSimulationOnlyEvent, findOwnerTest, canIssueFromEstimate } from "../src/app/simEew.js";
import { stationGrid, T0 } from "./helpers";

// 実際のエンジン(検知・震源推定)に、シミュレーション値を流し、連動EEWの前提(推定の形・発生時刻・検知点のid)を確かめる。
// 観測点: 模擬地震の周り(A)と、同時刻に起きる「実際の地震」の周り(B)。idは重複させない。
const stationsA = stationGrid(38, 142, 9, 0.12);
const stationsB = stationGrid(34, 135, 9, 0.12).map(s => ({ ...s, id: s.id + 361 }));
const allStations = [...stationsA, ...stationsB];

const perSim = prepareShakeTest({ lat: 38.0, lon: 142.0, magnitude: 6.3, depth: 20 }, stationsA);
const perReal = prepareShakeTest({ lat: 34.0, lon: 135.0, magnitude: 6.5, depth: 15 }, stationsB);
const simTest = { id: "t1", startedAt: T0, perStation: perSim, eewLinked: true };

function valuesAt(sec: number, includeReal: boolean): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of allStations) m.set(s.id, -3); // 平常値(実データ側に当たる)
  for (const [id, v] of computeShakeTestValues(perSim, sec * 1000)) m.set(id, v);
  if (includeReal) for (const [id, v] of computeShakeTestValues(perReal, sec * 1000)) m.set(id, v);
  return m;
}

function run(includeReal: boolean) {
  const pipe = new AnalysisPipeline();
  pipe.setStations(allStations, false);
  const issued: { eventId: unknown; est: any }[] = [];
  const rejectedNonSim: unknown[] = [];
  const simIds = collectSimStationIds([simTest]);
  for (let k = 0; k < 45; k++) {
    const now = T0 + k * 1000;
    const out = pipe.tick({
      values: valuesAt(k, includeReal), now, sourceMode: "test", replayClock: false,
      shakeDetectionEnabled: true, gridDetectionEnabled: false, epicenterEstimationEnabled: true,
    } as AnalysisTickInput);
    if (!out.estimates) continue;
    const byId = new Map(out.shakeEvents.map((e: any) => [e.id, e]));
    for (const [eventId, est] of out.estimates as Map<unknown, any>) {
      if (!canIssueFromEstimate(est)) continue;
      const simOnly = isSimulationOnlyEvent(byId.get(eventId), simIds);
      const owner = findOwnerTest(est, [simTest], now);
      if (simOnly && owner) issued.push({ eventId, est });
      else if (!simOnly) rejectedNonSim.push(eventId);
    }
  }
  return { issued, rejectedNonSim };
}

test("連動: シミュレーションだけの世界では、震源推定が発報条件を満たし、推定はシミュレーションの震源付近になる", () => {
  const { issued, rejectedNonSim } = run(false);
  assert.ok(issued.length > 0, "推定が発報条件(R2)を満たす");
  assert.equal(rejectedNonSim.length, 0);
  const last = issued[issued.length - 1].est;
  assert.ok(Math.abs(last.originTime - T0) <= 15000, `推定の発生時刻がシミュレーション開始に近い(差${last.originTime - T0}ms)`);
  assert.ok(Math.hypot(last.lat - 38, (last.lon - 142) * Math.cos(38 * Math.PI / 180)) < 1.5, "推定位置がおおむね震源付近");
});

test("R2: 実データを隔離しない(同時刻の実際の地震が混ざる)場合でも、実際の地震の推定はEEW化されない", () => {
  const { issued, rejectedNonSim } = run(true);
  assert.ok(rejectedNonSim.length > 0, "実際の地震側の検知・推定は発生している(=R2で弾いている)");
  // EEW化された推定は、全てシミュレーションの震源側(北緯38度付近)で、実際の地震側(北緯34度付近)ではない
  assert.ok(issued.length > 0);
  for (const { est } of issued) assert.ok(est.lat > 36, `EEW化された推定が実際の地震側(lat=${est.lat})ではない`);
});
