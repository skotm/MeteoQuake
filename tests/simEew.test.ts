import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIM_EEW_SOURCE, SIM_EEW_ORIGIN_SLACK_MS, SIM_EEW_MIN_UPDATE_INTERVAL_MS,
  isSimEew, isRealEewActive, collectSimStationIds, isSimulationOnlyEvent,
  findOwnerTest, canIssueFromEstimate, shouldIssueFollowUp,
  buildSimEewCard, buildSimEewFollowUp,
  calcPlumAreaIntensities, holdPlum, mergePlumIntoAreas, PLUM_RADIUS_KM,
} from "../src/app/simEew.js";
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

test("R4: シミュレーションEEWカードは常にisTest/isSimulation/sourceで識別でき、PLUM法ではない", () => {
  const c = buildSimEewCard({ eventId: "e1", est, place: "相模湾", areas: [], maxIntensityKey: "5-", isWarnLevel: true, simTestId: "t1", nowMs: T0 });
  assert.equal(c.isTest, true);
  assert.equal(c.isSimulation, true);
  assert.equal(isSimEew(c), true);
  assert.ok(c.id.startsWith("simeew_"));
  assert.equal(c.isPlum, false);
  assert.equal(c.serial, "1");
});

test("続報: 報番号+1、警報は予報に戻さない", () => {
  const c = buildSimEewCard({ eventId: "e1", est, place: "A", areas: [], maxIntensityKey: "5-", isWarnLevel: true, simTestId: "t1", nowMs: T0 });
  const f = buildSimEewFollowUp(c, { est: { ...est, magnitude: 5.2 }, place: "A", areas: [], maxIntensityKey: "4", isWarnLevel: false, nowMs: T0 + 2000 });
  assert.equal(f.serial, "2");
  assert.equal(f.isWarnLevel, true);
  assert.equal(f.magnitude, 5.2);
});

test("続報の条件: 最小間隔未満は出さない。位置・M・深さのいずれかが閾値以上変われば出す", () => {
  const rec = { lat: 35.2, lon: 139.3, depthKm: 20, magnitude: 5.8, issuedAt: T0 };
  const moved = { ...est, lat: 35.3 }; // 約11km
  assert.equal(shouldIssueFollowUp(rec, moved, T0 + SIM_EEW_MIN_UPDATE_INTERVAL_MS - 1), false);
  assert.equal(shouldIssueFollowUp(rec, moved, T0 + SIM_EEW_MIN_UPDATE_INTERVAL_MS), true);
  assert.equal(shouldIssueFollowUp(rec, { ...est, magnitude: 6.0 }, T0 + 5000), true);
  assert.equal(shouldIssueFollowUp(rec, { ...est, depthKm: 40 }, T0 + 5000), true);
  assert.equal(shouldIssueFollowUp(rec, est, T0 + 5000), false);
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

test("ハイブリッド合成: 大きい方を採用。PLUM法で上振れした地域だけisPlum、通常方式が大きい地域はそのまま", () => {
  const base = {
    areas: [
      { pref: "", name: "近い地域", scaleFrom: 40, scaleTo: 40, maxIntensityKey: "4", isPlum: false },
      { pref: "", name: "やや近い地域", scaleFrom: 60, scaleTo: 60, maxIntensityKey: "6-", isPlum: false },
    ],
    maxIntensityKey: "6-",
  };
  const plum = calcPlumAreaIntensities(geo, stations, new Map([[1, 5.2]]), simIds);
  const m = mergePlumIntoAreas(base, plum);
  const near = m.areas.find((a: any) => a.name === "近い地域");
  assert.equal(near.maxIntensityKey, "5+");
  assert.equal(near.isPlum, true);
  assert.equal(m.areas.find((a: any) => a.name === "やや近い地域").isPlum, false);
  assert.equal(m.plumSig, "近い地域=5+");
  assert.equal(m.maxIntensityKey, "6-");
  // 通常方式に無い地域は追加され、全体の最大震度も更新される
  const m2 = mergePlumIntoAreas({ areas: [], maxIntensityKey: "3" }, plum);
  assert.equal(m2.areas.length, 2);
  assert.equal(m2.maxIntensityKey, "5+");
  assert.equal(base.areas[0].maxIntensityKey, "4"); // 元のデータは変更しない
});

test("PLUM: 一度出た予想震度は、揺れが収まっても下げない", () => {
  const hold = new Map();
  holdPlum(hold, calcPlumAreaIntensities(geo, stations, new Map([[1, 5.2]]), simIds));
  holdPlum(hold, calcPlumAreaIntensities(geo, stations, new Map([[1, 2.0]]), simIds));
  assert.equal(hold.get("近い地域").key, "5+");
  holdPlum(hold, calcPlumAreaIntensities(geo, stations, new Map([[1, 6.2]]), simIds));
  assert.equal(hold.get("近い地域").key, "6+");
});
