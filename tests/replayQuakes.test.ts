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

test("全ての地震: 発生の3分30秒後に詳細のみ", () => {
  for (const k of ["6+", "3", "2", "?"]) {
    assert.equal(quakeStageAt(T0, k, T0 + 90_000), null);
    assert.equal(quakeStageAt(T0, k, T0 + 150_000), null);
    assert.equal(quakeStageAt(T0, k, T0 + 209_999), null);
    assert.equal(quakeStageAt(T0, k, T0 + 210_000), "detail");
  }
});

test("一覧: 3分30秒後に詳細で出る。リプレイ開始前の地震は最終形", () => {
  const old = mk("old", "2022/03/10 12:00:00", "3");
  const q = mk("q", "2022/03/16 23:36:33", "6+");
  const at = (ms: number) => replayQuakesAt([q, old], ms, range);
  assert.deepEqual(at(T0 + 209_000).map(x => x.id), ["old"]);
  const f = at(T0 + 210_000);
  assert.deepEqual(f.map(x => x.id), ["q", "old"]);
  assert.equal(f[0].stage, "detail");
  assert.equal(f[0].points.length, 1);
  assert.equal(f[1].stage, undefined);
});

test("未来の地震は出さない", () => {
  const future = mk("f", "2022/03/16 23:40:00", "4");
  assert.deepEqual(replayQuakesAt([future], T0 + 100_000, range), []);
});
