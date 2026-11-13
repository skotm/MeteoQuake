import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIM_EEW_SOURCE, SIM_EEW_ORIGIN_SLACK_MS,
  isSimEew, isRealEewActive, collectSimStationIds, isSimulationOnlyEvent,
  findOwnerTest, canIssueFromEstimate,
  buildSimEewCard, buildSimEewFollowUp,
  calcPlumAreaIntensities, holdPlum, PLUM_RADIUS_KM,
} from "../src/app/simEew.js";
import { buildForecast, evaluateReport } from "../src/app/simEewRules.js";
import { filterEstimatesNearEew, isSuppressingEew } from "../src/app/eewEstimateFilter.js";

const T0 = 1_800_000_000_000;
const test1 = { id: "t1", startedAt: T0, perStation: new Map([[1, {}], [2, {}], [3, {}]]) };
const est = { lat: 35.2, lon: 139.3, depthKm: 20, magnitude: 5.8, originTime: T0 + 500 };

test("R2(a): 検知点が全てシミュレーション観測点のイベントだけ許可。実観測点が1つでも混ざれば不可", () => {
  const ids = collectSimStationIds([test1]);
  assert.equal(isSimulationOnlyEvent({ detections: [{ id: 1 }, { id: 2 }] }, ids), true);
  assert.equal(isSimulationOnlyEvent({ detections: [{ id: 1 }, { id: 999 }] }, ids), false);
  assert.equal(isSimulationOnlyEvent({ detections: [] }, ids), false);
  assert.equal(isSimulationOnlyEvent(undefined, ids), false);
  assert.equal(isSimulationOnlyEvent({ detections: [{ id: 1 }] }, new Set()), false);
});

test("R2(b): 発生時刻がシミュレーション開始の許容外(古い・未来)の推定は対象外", () => {
  assert.equal(findOwnerTest(est, [test1], T0 + 5000)?.id, "t1");
  const tooOld = { ...est, originTime: T0 - SIM_EEW_ORIGIN_SLACK_MS - 1 };
  assert.equal(findOwnerTest(tooOld, [test1], T0 + 5000), null);
  const future = { ...est, originTime: T0 + 60000 };
  assert.equal(findOwnerTest(future, [test1], T0 + 5000), null);
  assert.equal(findOwnerTest({ ...est, originTime: NaN }, [test1], T0 + 5000), null);
});

test("R2(b): 複数のシミュレーションでは開始時刻が最も近いものが所有者", () => {
  const t2 = { id: "t2", startedAt: T0 + 20000, perStation: new Map([[4, {}]]) };
  const e2 = { ...est, originTime: T0 + 20500 };
  assert.equal(findOwnerTest(e2, [test1, t2], T0 + 25000)?.id, "t2");
});

test("R3: 本物のEEWだけが「実EEW発表中」。テスト・シミュレーション・訓練・取消は数えない", () => {
  assert.equal(isRealEewActive([]), false);
  assert.equal(isRealEewActive([{ cancelled: false }]), true);
  assert.equal(isRealEewActive([{ cancelled: true }]), false);
  assert.equal(isRealEewActive([{ cancelled: false, isTest: true }]), false);
  assert.equal(isRealEewActive([{ cancelled: false, isTraining: true }]), false);
  assert.equal(isRealEewActive([{ cancelled: false, source: SIM_EEW_SOURCE }]), false);
});

// 報の評価結果を作る小さなヘルパー(評価ロジック自体は simEewRules.test.ts で検証する)。
const evaluated = (() => {
  const forecast = buildForecast({ areaValues: new Map([["相模湾地域", 4.6]]) }, new Map());
  return evaluateReport(null, { raw: { lat: 35.2, lon: 139.3, depthKm: 20, magnitude: 5.8 }, stationCount: 5, inland: false, forecast })!;
})();

test("R4: シミュレーションEEWカードは常にisTest/isSimulation/sourceで識別でき、PLUM法の報ではない", () => {
  const c = buildSimEewCard({ eventId: "e1", est, evaluated, place: "相模湾", simTestId: "t1", nowMs: T0 });
  assert.equal(c.isTest, true);
  assert.equal(c.isSimulation, true);
  assert.equal(isSimEew(c), true);
  assert.ok(c.id.startsWith("simeew_"));
  assert.equal(c.isPlum, false);
  assert.equal(c.serial, "1");
  assert.equal(c.magnitude, 5.8);
  assert.equal(c.depth, 20);
  assert.equal(c.isLevel, false);
  // 更新理由や履歴は、カードには持たせない(ログにまとめる)
  assert.equal("simReasons" in c, false);
  assert.equal("simHistory" in c, false);
});

test("続報: 報番号+1、警報は予報に戻さない", () => {
  const c = buildSimEewCard({ eventId: "e1", est, evaluated, place: "A", simTestId: "t1", nowMs: T0 });
  const lower = evaluateReport(evaluated.state, {
    raw: { lat: 35.2, lon: 139.3, depthKm: 20, magnitude: 5.2 }, stationCount: 5, inland: false,
    forecast: buildForecast({ areaValues: new Map([["相模湾地域", 3.8]]) }, new Map()),
  })!;
  const f = buildSimEewFollowUp(c, { est, evaluated: lower, place: "A", nowMs: T0 + 2000 });
  assert.equal(f.serial, "2");
  assert.equal(f.isWarnLevel, true);
  assert.equal(f.magnitude, 5.2);
  assert.equal("simReasons" in f, false);
  assert.equal("simHistory" in f, false);
});

test("発報条件: 位置・深さ・Mのどれかが欠けた推定は発報しない", () => {
  assert.equal(canIssueFromEstimate(est), true);
  assert.equal(canIssueFromEstimate({ ...est, magnitude: null }), false);
  assert.equal(canIssueFromEstimate({ ...est, lat: undefined }), false);
  assert.equal(canIssueFromEstimate(null), false);
});

test("R5: テスト(シミュレーション含む)のEEWは、実地震の推定を隠さない", () => {
  const simEew = { cancelled: false, isPlum: false, isTest: true, source: SIM_EEW_SOURCE, latitude: 35.2, longitude: 139.3, originTime: "2026/11/12 10:00:00" };
  assert.equal(isSuppressingEew(simEew), false);
  const originMs = new Date("2026/11/12 10:00:00").getTime();
  const estimates = new Map([["real", { lat: 35.25, lon: 139.3, originTime: originMs }]]);
  assert.equal(filterEstimatesNearEew(estimates, [simEew]).has("real"), true);
  // 本物のEEWは従来どおり抑制する
  const realEew = { ...simEew, isTest: false, source: "wolfx" };
  assert.equal(filterEstimatesNearEew(estimates, [realEew]).has("real"), false);
});

// ── 通常方式とPLUM法のハイブリッド ──
// 一辺0.02度の小さな正方形(重心がほぼ中心)を、細分区域に見立てる。
function square(name: string, lat: number, lon: number) {
  const d = 0.01;
  return { type: "Feature", properties: { name }, geometry: { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d]]] } };
}
const geo = { type: "FeatureCollection", features: [square("近い地域", 35.0, 139.0), square("遠い地域", 36.0, 139.0), square("やや近い地域", 35.15, 139.0)] };
const stations = [{ id: 1, lat: 35.0, lon: 139.0 }, { id: 2, lat: 35.0, lon: 139.0 }];
const simIds = new Set([1]);

test("PLUM: 観測震度5弱以上の観測点から半径30km以内の地域だけが対象(5弱未満・シミュレーション外の観測点は使わない)", () => {
  assert.equal(PLUM_RADIUS_KM, 30);
  const hit = calcPlumAreaIntensities(geo, stations, new Map([[1, 5.2]]), simIds);
  assert.equal(hit.get("近い地域")?.key, "5+");
  assert.equal(hit.get("やや近い地域")?.key, "5+"); // 約17km
  assert.equal(hit.has("遠い地域"), false);          // 約111km
  assert.equal(calcPlumAreaIntensities(geo, stations, new Map([[1, 4.4]]), simIds).size, 0);
  assert.equal(calcPlumAreaIntensities(geo, stations, new Map([[2, 6.0]]), simIds).size, 0); // 観測点2はシミュレーション外
});

test("ハイブリッド合成: 地域ごとに大きい方を採用(平均ではない)。PLUM法が大きい地域だけplumWonになる", () => {
  const att = { areaValues: new Map([["近い地域", 3.6], ["やや近い地域", 5.8]]) };
  const plum = calcPlumAreaIntensities(geo, stations, new Map([[1, 5.2]]), simIds);
  const f = buildForecast(att, plum);
  assert.equal(f.areaValues.get("近い地域"), 5.2);
  assert.equal(f.areaValues.get("やや近い地域"), 5.8);
  assert.deepEqual([...f.plumWon], ["近い地域"]);
  assert.equal(att.areaValues.get("近い地域"), 3.6); // 元のデータは変更しない
  // 通常方式に無い地域もPLUM法で加わる
  assert.equal(buildForecast({ areaValues: new Map() }, plum).areaValues.size, 2);
});

test("PLUM: 一度出た予想震度は、揺れが収まっても下げない", () => {
  const hold = new Map();
  holdPlum(hold, calcPlumAreaIntensities(geo, stations, new Map([[1, 5.2]]), simIds));
  holdPlum(hold, calcPlumAreaIntensities(geo, stations, new Map([[1, 2.0]]), simIds));
  assert.equal(hold.get("近い地域").key, "5+");
  holdPlum(hold, calcPlumAreaIntensities(geo, stations, new Map([[1, 6.2]]), simIds));
  assert.equal(hold.get("近い地域").key, "6+");
});
