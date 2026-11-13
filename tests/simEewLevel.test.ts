import { test } from "node:test";
import assert from "node:assert/strict";
import {
  areaNameForStation, buildSimEewCard, buildSimEewFollowUp, buildSimLevelCard, buildSimLevelFollowUp, isSimEew, simLevelEewId,
} from "../src/app/simEew.js";
import { EEW_RULES, buildForecast, describeChanges, evaluateReport, levelTriggerStations } from "../src/app/simEewRules.js";
import { formatSimLog, makeSimLogEntry } from "../src/app/simEewLog.js";
import { findAreaNameByPoint } from "../src/app/geo.js";

const T0 = 1_800_000_000_000;
function square(name: string, lat: number, lon: number) {
  const d = 0.1;
  return { type: "Feature", properties: { name }, geometry: { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] } };
}
const areas = { type: "FeatureCollection", features: [square("A地域", 35.0, 139.0), square("B地域", 36.0, 139.0)] };

test("点を含む細分区域の名前を返す。含む区域が無ければnull", () => {
  assert.equal(findAreaNameByPoint(areas, 35.0, 139.0), "A地域");
  assert.equal(findAreaNameByPoint(areas, 36.05, 139.05), "B地域");
  assert.equal(findAreaNameByPoint(areas, 40.0, 130.0), null);
});

test("観測点の属する区域: 区域内ならその区域。区域外でも30km以内の重心の区域なら、その区域", () => {
  assert.equal(areaNameForStation(areas, { lat: 35.0, lon: 139.0 }), "A地域");
  assert.equal(areaNameForStation(areas, { lat: 35.2, lon: 139.0 }), "A地域"); // 区域の北端(35.1)から約11km
  assert.equal(areaNameForStation(areas, { lat: 38.0, lon: 139.0 }), null);
});

test("レベル法の対象: 観測震度4.5以上のシミュレーション観測点だけ(観測震度の大きい順)。シミュレーション外は対象外", () => {
  assert.equal(EEW_RULES.LEVEL_INTENSITY, 4.5);
  const stations = [{ id: 1, lat: 35, lon: 139 }, { id: 2, lat: 35, lon: 139 }, { id: 3, lat: 35, lon: 139 }, { id: 4, lat: 35, lon: 139 }];
  const values = new Map([[1, 4.4], [2, 4.5], [3, 6.0], [4, 7.0]]);
  const hit = levelTriggerStations(stations, values, new Set([1, 2, 3]));
  assert.deepEqual(hit.map(h => h.id), [3, 2]);
});

test("レベル法のカード: 震源・Mを持たず、予報(警報でない)。シミュレーションと分かり、震源なしの表示(PLUM法の表示)を使う", () => {
  const c = buildSimLevelCard({ simTestId: "t1", station: { lat: 35.1, lon: 139.2 }, areaNames: ["A地域", "B地域"], nowMs: T0 });
  assert.equal(c.id, simLevelEewId("t1"));
  assert.equal(c.isLevel, true);
  assert.equal(c.isPlum, true);
  assert.equal(c.isWarnLevel, false);
  assert.equal(c.magnitude, null);
  assert.equal(c.depth, null);
  assert.equal(c.maxIntensityKey, "5-");
  assert.deepEqual(c.areas.map((a: any) => a.name), ["A地域", "B地域"]);
  assert.equal(c.isTest, true);
  assert.equal(c.isSimulation, true);
  assert.equal(isSimEew(c), true);
});

test("レベル法の続報: 新しい地域だけを加え、報番号+1。既にある地域は重複させない", () => {
  const c = buildSimLevelCard({ simTestId: "t1", station: { lat: 35.1, lon: 139.2 }, areaNames: ["A地域"], nowMs: T0 });
  const f = buildSimLevelFollowUp(c, { areaNames: ["A地域", "B地域"], nowMs: T0 + 1000 });
  assert.equal(f.serial, "2");
  assert.deepEqual(f.areas.map((a: any) => a.name), ["A地域", "B地域"]);
});

test("レベル法 → 通常方式: レベル法の報を、通常方式の続報として引き継げる(震源・M・深さが入り、レベル法の表示が外れる)", () => {
  const lv = buildSimLevelCard({ simTestId: "t1", station: { lat: 35.1, lon: 139.2 }, areaNames: ["A地域"], nowMs: T0 });
  const evaluated = evaluateReport(null, {
    raw: { lat: 35.2, lon: 139.3, depthKm: 20, magnitude: 5.8 }, stationCount: 6, inland: false,
    forecast: buildForecast({ areaValues: new Map([["A地域", 4.6]]) }, new Map()),
  })!;
  const est = { lat: 35.2, lon: 139.3, depthKm: 20, magnitude: 5.8, originTime: T0 };
  const f = buildSimEewFollowUp(lv, { est, evaluated, place: "相模湾", nowMs: T0 + 3000 });
  assert.equal(f.serial, "2");
  assert.equal(f.isLevel, false);
  assert.equal(f.isPlum, false);
  assert.equal(f.magnitude, 5.8);
  assert.equal(f.depth, 20);
  assert.equal(f.place, "相模湾");
  assert.equal(f.id, lv.id); // 同じカードを更新する
});

test("1観測点だけの結果による報は、予測震度を載せない(気象庁)。2観測点以上なら載せる", () => {
  const mk = (stationCount: number) => evaluateReport(null, {
    raw: { lat: 35, lon: 139, depthKm: 20, magnitude: 5.0 }, stationCount, inland: true,
    forecast: buildForecast({ areaValues: new Map([["A地域", 4.0]]) }, new Map()),
  })!;
  const one = mk(1);
  assert.deepEqual(one.display.areas, []);
  assert.equal(one.display.maxKey, "?");
  assert.equal(one.display.intensityHidden, true);
  const two = mk(2);
  assert.equal(two.display.areas.length, 1);
  assert.equal(two.display.intensityHidden, false);
  const card = buildSimEewCard({ eventId: "e", est: { lat: 35, lon: 139, depthKm: 20, magnitude: 5, originTime: T0 }, evaluated: one, place: "X", simTestId: "t1", nowMs: T0 });
  assert.equal(card.intensityHidden, true);
});

test("ログ: 更新前後の値と更新理由を文にする。複数行で、時刻・報番号・種別・理由・差が読める", () => {
  const f1 = evaluateReport(null, {
    raw: { lat: 35.0, lon: 139.0, depthKm: 20, magnitude: 5.0 }, stationCount: 5, inland: true,
    forecast: buildForecast({ areaValues: new Map([["A地域", 3.6]]) }, new Map()),
  })!;
  const f2 = evaluateReport(f1.state, {
    raw: { lat: 35.0, lon: 139.0, depthKm: 30, magnitude: 5.2 }, stationCount: 5, inland: true,
    forecast: buildForecast({ areaValues: new Map([["A地域", 4.6], ["B地域", 3.7]]) }, new Map()),
  })!;
  const changes = describeChanges(f1.state, f2);
  assert.ok(changes.some(c => c.startsWith("M 5.00→5.20(発表 5.0→5.2)")));
  assert.ok(changes.some(c => c.includes("深さ 20.0→30.0km(発表 20→30km)")));
  assert.ok(changes.some(c => c.includes("新しい予報区: B地域(4)")));
  assert.ok(changes.some(c => c.includes("A地域(4→5弱)")));
  const text = formatSimLog([makeSimLogEntry({ at: T0, kind: "更新", method: "通常", serial: 2, state: f2.state, reasons: f2.reasons, changes })]);
  assert.ok(text.includes("#2 更新(通常) M5.2 深さ30km 最大予測震度5弱"));
  assert.ok(text.includes("理由: マグニチュードの変化"));
  assert.ok(text.split("\n").length >= 4);
  assert.deepEqual(describeChanges(null, f2), []);
});

test("ログ: 報ではないログ(開始・中止など)も書式化でき、レベル法の表記を持つ", () => {
  const t = formatSimLog([
    makeSimLogEntry({ at: T0, kind: "開始", note: "連動シミュレーション開始" }),
    makeSimLogEntry({ at: T0 + 1000, kind: "発表", method: "レベル法", serial: 1, reasons: ["レベル法による発表"], warn: false, note: "対象: A地域" }),
  ]);
  assert.ok(t.includes("開始"));
  assert.ok(t.includes("発表(レベル法)"));
  assert.ok(t.includes("対象: A地域"));
});
