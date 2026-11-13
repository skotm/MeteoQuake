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

// ── 報更新ルールの通し確認: 実際の検知・震源推定エンジン+実際の細分区域データで、報の列が妥当か ──
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { calcTestEewAreasByAttenuation } from "../src/app/testSimulation.js";
import { buildForecast, evaluateReport, publishedDepthKm, publishedMagnitude } from "../src/app/simEewRules.js";

test("通し: 第1報の後は、更新条件を満たした時だけ報が出る(毎秒は出ない)。報番号は報ごとに+1", () => {
  // 細分区域.json(環境によってファイル名の文字化けがあるため、名前のパターンで探す)
  const mapDir = fileURLToPath(new URL("../public/map/", import.meta.url));
  const areaFile = readdirSync(mapDir).find(n => n === "細分区域.json" || n.startsWith("#U7d30"));
  assert.ok(areaFile, "細分区域のデータファイルがある");
  const areasGeo = JSON.parse(readFileSync(join(mapDir, areaFile!), "utf-8"));
  const pipe = new AnalysisPipeline();
  pipe.setStations(allStations, false);
  const simIds = collectSimStationIds([simTest]);
  let state: any = null;
  const reports: { k: number; reasons: string[] }[] = [];
  let ticksWithEstimate = 0;
  for (let k = 0; k < 60; k++) {
    const now = T0 + k * 1000;
    const out: any = pipe.tick({
      values: valuesAt(k, false), now, sourceMode: "test", replayClock: false,
      shakeDetectionEnabled: true, gridDetectionEnabled: false, epicenterEstimationEnabled: true,
    } as AnalysisTickInput);
    if (!out.estimates) continue;
    const byId = new Map(out.shakeEvents.map((e: any) => [e.id, e]));
    for (const [eventId, est] of out.estimates as Map<unknown, any>) {
      if (!canIssueFromEstimate(est) || !isSimulationOnlyEvent(byId.get(eventId), simIds) || !findOwnerTest(est, [simTest], now)) continue;
      ticksWithEstimate++;
      const att = calcTestEewAreasByAttenuation(areasGeo, est.lat, est.lon, publishedMagnitude(est.magnitude), publishedDepthKm(est.depthKm), false);
      const ev = evaluateReport(state, {
        raw: { lat: est.lat, lon: est.lon, depthKm: est.depthKm, magnitude: est.magnitude },
        stationCount: est.pointCount ?? 0, inland: false, forecast: buildForecast(att, new Map()),
      });
      if (!ev) continue;
      state = ev.state;
      reports.push({ k, reasons: ev.reasons });
    }
  }
  assert.ok(reports.length >= 1, "第1報が出る");
  assert.deepEqual(reports[0].reasons.slice(0, 1), ["発表"]);
  assert.ok(reports.slice(1).every(r => !r.reasons.includes("発表")), "第1報以外に「発表」は出ない");
  assert.ok(reports.length < ticksWithEstimate, `毎回は出ない(報${reports.length}件/推定${ticksWithEstimate}回)`);
  console.log("報の列:", reports.map(r => `${r.k}s:${r.reasons.join("+")}`).join(" | "));
});

// ── レベル法の通し確認: 実際の細分区域データで、観測点が属する地域を引け、通常方式の第1報より前に出るか ──
import { areaNameForStation } from "../src/app/simEew.js";
import { levelTriggerStations } from "../src/app/simEewRules.js";

test("通し(レベル法): 観測震度4.5以上の観測点が現れ、その観測点の地域を引ける。通常方式の第1報との前後を確認", () => {
  const mapDir = fileURLToPath(new URL("../public/map/", import.meta.url));
  const areaFile = readdirSync(mapDir).find(n => n === "細分区域.json" || n.startsWith("#U7d30"));
  const areasGeo = JSON.parse(readFileSync(join(mapDir, areaFile!), "utf-8"));
  // 観測点が陸上にある場合(関東平野)で確認する。海上の観測点は属する地域が無く、レベル法の対象にならない。
  const land = stationGrid(36.0, 139.7, 9, 0.12);
  const perLand = prepareShakeTest({ lat: 36.0, lon: 139.7, magnitude: 6.3, depth: 20 }, land);
  const landTest = { id: "t2", startedAt: T0, perStation: perLand, eewLinked: true };
  const landValues = (sec: number) => {
    const m = new Map<number, number>();
    for (const s of land) m.set(s.id, -3);
    for (const [id, v] of computeShakeTestValues(perLand, sec * 1000)) m.set(id, v);
    return m;
  };
  const pipe = new AnalysisPipeline();
  pipe.setStations(land, false);
  const simIds = collectSimStationIds([landTest]);
  let levelAt = -1;
  let firstNormalAt = -1;
  let areaName: string | null = null;
  let state: any = null;
  for (let k = 0; k < 40; k++) {
    const now = T0 + k * 1000;
    const values = landValues(k);
    if (levelAt < 0) {
      const trig = levelTriggerStations(land, values, simIds);
      if (trig.length) { levelAt = k; areaName = areaNameForStation(areasGeo, trig[0]); }
    }
    const out: any = pipe.tick({
      values, now, sourceMode: "test", replayClock: false,
      shakeDetectionEnabled: true, gridDetectionEnabled: false, epicenterEstimationEnabled: true,
    } as AnalysisTickInput);
    if (!out.estimates || firstNormalAt >= 0) continue;
    const byId = new Map(out.shakeEvents.map((e: any) => [e.id, e]));
    for (const [eventId, est] of out.estimates as Map<unknown, any>) {
      if (!canIssueFromEstimate(est) || !isSimulationOnlyEvent(byId.get(eventId), simIds) || !findOwnerTest(est, [landTest], now)) continue;
      const att = calcTestEewAreasByAttenuation(areasGeo, est.lat, est.lon, publishedMagnitude(est.magnitude), publishedDepthKm(est.depthKm), false);
      const ev = evaluateReport(state, {
        raw: { lat: est.lat, lon: est.lon, depthKm: est.depthKm, magnitude: est.magnitude },
        stationCount: est.pointCount ?? 0, inland: false, forecast: buildForecast(att, new Map()),
      });
      if (ev) { state = ev.state; firstNormalAt = k; }
    }
  }
  assert.ok(levelAt >= 0, "観測震度4.5以上の観測点が現れる");
  assert.ok(areaName, "その観測点の地域を引ける");
  console.log(`レベル法: ${levelAt}秒(${areaName}) / 通常方式の第1報: ${firstNormalAt}秒`);
});
