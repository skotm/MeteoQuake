import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLongPeriodPayload, cityNameFromStationName, attachLongPeriod, findLongPeriodFor, eventIdMinuteKey, buildTestLongPeriodInfo } from "../src/longPeriod.ts";

const ev = {
  eventId: "20261119022225", hypocenters: [{ name: "熊本県天草・芦北地方" }],
  reports: [
    { product: "VXSE53", status: "issued" },
    { product: "VXSE62", status: "issued", issuedAt: "2026-11-18T17:31:54.000Z", observation: {
      maxLongPeriod: "2",
      areas: [
        { name: "熊本県熊本", lg: "2", stations: [
          { code: "4320200", name: "八代市平山新町", lg: "2" },
          { code: "4320201", name: "八代市千丁町", lg: "1" },
        ] },
        { name: "宮崎県北部山沿い", lg: "0", stations: [{ code: "4521100", name: "西米良村村所", lg: "0" }] },
        { name: "熊本県天草・芦北", lg: "2", stations: [{ code: "4348201", name: "芦北町芦北", lg: "2" }] },
      ] } },
  ],
};

test("VXSE62から市区町村ごとの最大階級を作る", () => {
  const [e] = parseLongPeriodPayload({ events: [ev, { eventId: "x", reports: [{ product: "VXSE53" }] }] });
  assert.equal(e.maxLg, 2);
  assert.deepEqual(e.cities.map((c) => [c.name, c.lg]).sort(), [["八代市", 2], ["芦北町", 2]].sort());
  assert.deepEqual(e.areas.map((a) => a.name).sort(), ["熊本県天草・芦北", "熊本県熊本"]);
  assert.equal(e.issuedAtMs, Date.parse("2026-11-18T17:31:54.000Z"));
});

test("市区町村名の取り出し", () => {
  assert.equal(cityNameFromStationName("名古屋市中区栄"), "名古屋市中区");
  assert.equal(cityNameFromStationName("東村山市本町"), "東村山市");
  assert.equal(cityNameFromStationName("新宿区歌舞伎町"), "新宿区");
});

test("カードとの対応づけとリプレイでの発表前除外", () => {
  const events = new Map(parseLongPeriodPayload([ev]).map((e) => [e.eventId, e]));
  const card = { time: "2026/11/19 02:22:00", place: "熊本県天草・芦北地方" };
  assert.equal(eventIdMinuteKey("20261119022225"), "2026/11/19 02:22");
  assert.ok(findLongPeriodFor(card, events.values()));
  const [a] = attachLongPeriod([card], events);
  assert.equal((a as any).longPeriod, 2);
  const [b] = attachLongPeriod([card], events, Date.parse("2026-11-18T17:25:00Z"));
  assert.equal((b as any).longPeriod, undefined);
  const [c] = attachLongPeriod([{ time: "2026/11/19 03:00:00", place: "x" }], events);
  assert.equal((c as any).longPeriod, undefined);
});

test("テスト用の長周期の情報を作る", () => {
  const pts = [
    { addr: "八代市平山新町", scale: 45, isArea: false }, { addr: "八代市千丁町", scale: 40, isArea: false },
    { addr: "芦北町芦北", scale: 30, isArea: false }, { addr: "天草市本渡", scale: 20, isArea: false },
    { addr: "水俣市牧ノ内", scale: 10, isArea: false }, { addr: "球磨村渡", scale: 10, isArea: false },
  ];
  const info = buildTestLongPeriodInfo({ points: pts }, 3);
  assert.equal(info.maxLg, 3);
  assert.equal(info.cities[0].lg, 3);
  assert.ok(info.cities.every((c) => c.lg >= 1 && c.lg <= 3));
  const lgs = info.cities.map((c) => c.lg);
  assert.deepEqual([...lgs].sort((a, b) => b - a), lgs);
  const area = buildTestLongPeriodInfo({ points: [{ addr: "熊本県球磨", scale: 30, isArea: true }] }, 2);
  assert.deepEqual(area.areas, [{ name: "熊本県球磨", lg: 2 }]);
});
