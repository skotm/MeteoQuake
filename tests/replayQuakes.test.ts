import test from "node:test";
import assert from "node:assert/strict";
import { parseQuakeTimeMs, quakeStageAt, replayQuakesAt, toJstDateAndTime } from "../src/replayQuakes.ts";

const T0 = parseQuakeTimeMs("2022/03/16 23:36:33")!;
const range = { startMs: T0 - 60_000, endMs: T0 + 600_000 };
const mk = (id: string, time: string, maxIntensity: string) => ({ id, time, maxIntensity, place: "X", magnitude: 7.4, depth: 57, latitude: 37, longitude: 141, points: [{ a: 1 }] });

test("時刻の解釈と整形(日本時間)", () => {
  assert.equal(new Date(T0).toISOString(), "2022-03-16T14:36:33.000Z");
  assert.deepEqual(toJstDateAndTime(T0), { date: "2022-03-16", time: "23:36" });
});

test("震度3以上: +1:30 震度速報, +2:30 震源情報, +3:30 詳細", () => {
  assert.equal(quakeStageAt(T0, "6+", T0 + 89_999), null);
  assert.equal(quakeStageAt(T0, "6+", T0 + 90_000), "prompt");
  assert.equal(quakeStageAt(T0, "6+", T0 + 149_999), "prompt");
  assert.equal(quakeStageAt(T0, "6+", T0 + 150_000), "destination");
  assert.equal(quakeStageAt(T0, "6+", T0 + 209_999), "destination");
  assert.equal(quakeStageAt(T0, "6+", T0 + 210_000), "detail");
});

test("震度2以下: +3:30 に詳細のみ", () => {
  assert.equal(quakeStageAt(T0, "2", T0 + 100_000), null);
  assert.equal(quakeStageAt(T0, "2", T0 + 210_000), "detail");
});

test("一覧: 段階ごとの中身と、リプレイ開始前の地震は最終形", () => {
  const old = mk("old", "2022/03/10 12:00:00", "3");
  const q = mk("q", "2022/03/16 23:36:33", "6+");
  const at = (ms: number) => replayQuakesAt([q, old], ms, range);
  assert.deepEqual(at(T0 + 10_000).map(x => x.id), ["old"]);
  const p = at(T0 + 100_000);
  assert.deepEqual(p.map(x => x.id), ["q", "old"]);
  assert.equal(p[0].place, "震源調査中");
  assert.equal(p[0].maxIntensity, "6+");
  assert.equal(p[0].latitude, null);
  const d = at(T0 + 160_000)[0];
  assert.equal(d.stage, "destination");
  assert.equal(d.maxIntensity, "?");
  assert.equal(d.latitude, 37);
  assert.deepEqual(d.points, []);
  const f = at(T0 + 220_000)[0];
  assert.equal(f.stage, "detail");
  assert.equal(f.points.length, 1);
  assert.equal(at(T0 + 220_000)[1].stage, undefined); // 開始前の地震は加工しない
});

test("未来の地震は出さない", () => {
  const future = mk("f", "2022/03/16 23:40:00", "4");
  assert.deepEqual(replayQuakesAt([future], T0 + 100_000, range), []);
});
