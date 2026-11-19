import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wolfxPayloadToQuakeCards, tsunamiFromForecast, intToIntensityKey, isoToJstDisplay } from "../src/wolfxQuakes.ts";

const sample = JSON.parse(readFileSync(new URL("./fixtures/wolfx_detail_sample.json", import.meta.url), "utf8"));

test("実データのeventを地震カードにできる", () => {
  const cards = wolfxPayloadToQuakeCards(sample);
  assert.ok(cards.length >= 2);
  const c = cards.find((x) => x.id === "wolfx_20261119022225")!;
  assert.equal(c.stage, "detail");
  assert.equal(c.place, "熊本県天草・芦北地方");
  assert.equal(c.maxIntensity, "5-");
  assert.equal(c.magnitude, 5.7);
  assert.equal(c.depth, 10);
  assert.equal(c.time, "2026/11/19 02:22:00");
  assert.equal(c.domesticTsunami, "None");
  assert.ok(c.points.length > 300 && c.points.every((p) => !p.isArea));
  assert.ok(c.points.some((p) => p.addr === "球磨村渡*" && p.pref === "熊本県" && p.scale === 45));
  // 新しい順
  assert.ok(cards.every((x, i) => i === 0 || cards[i - 1].time >= x.time));
});

test("電文が少ない段階の扱い", () => {
  const ev = { eventId: "20261119020000", hypocenters: [], reports: [{ product: "VXSE51", status: "issued", issuedAt: "2026-11-18T17:01:00Z", observation: { maxIntensity: "3", prefs: [{ name: "熊本県", int: "3" }], areas: [{ name: "熊本県球磨", int: "3", pref: 0 }] } }] };
  const [c] = wolfxPayloadToQuakeCards([ev]);
  assert.equal(c.stage, "prompt");
  assert.equal(c.place, "震源調査中");
  assert.deepEqual(c.points, [{ pref: "熊本県", addr: "熊本県球磨", scale: 30, isArea: true }]);
  assert.equal(c.maxIntensity, "3");
  assert.equal(wolfxPayloadToQuakeCards([{ eventId: "x", reports: [{ product: "VXSE62", status: "issued" }] }]).length, 0);
});

test("変換ヘルパー", () => {
  assert.equal(tsunamiFromForecast("この地震による津波の心配はありません。"), "None");
  assert.equal(tsunamiFromForecast("津波注意報を発表"), "Watch");
  assert.equal(tsunamiFromForecast("今後の情報に注意してください。"), "Unknown");
  assert.equal(intToIntensityKey("5-"), "5-");
  assert.equal(intToIntensityKey("5弱以上未入電"), "5u");
  assert.equal(intToIntensityKey(null), "?");
  assert.equal(isoToJstDisplay("2026-11-18T17:22:00.000Z"), "2026/11/19 02:22:00");
});
