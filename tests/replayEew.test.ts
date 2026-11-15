import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEewOnlyFrames, buildReplayEewAt, eewRangeNote, parseReplayEewJson, REPLAY_EEW_CANCEL_KEEP_MS, REPLAY_EEW_KEEP_MS } from "../src/replayEew.ts";

// JmaEewParser(v0.4.0)の .eew.json のうち、MeteoQuakeが使う normalized 部分。
const ORIGIN = Date.UTC(2026, 7, 22, 17, 0, 0); // 2026-08-23 02:00:00 JST
function sampleJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: "1.2.0",
    normalized: {
      formatVersion: 1,
      event: { eventId: "jma-1", originTimeMs: ORIGIN, hypocenterName: "茨城県南部", latitude: 36.1, longitude: 139.9, depthKm: 50, magnitude: 5.9 },
      reports: [
        { serial: 2, issuedAtMs: ORIGIN + 56_000, isFinal: true, maxIntensityKey: "5+", areas: [{ name: "茨城県南部", minIntensityKey: "5-", maxIntensityKey: "5+", openEnded: false }] },
        { serial: 1, issuedAtMs: ORIGIN + 50_000, isFinal: false, maxIntensityKey: "5-", areas: [{ name: "茨城県南部", minIntensityKey: "4", maxIntensityKey: "5-", openEnded: false }] },
      ],
      warnings: [],
      ...overrides,
    },
  });
}
const data = parseReplayEewJson(sampleJson());

test("報を発表時刻順に並べ、最後を最終報にする", () => {
  assert.deepEqual(data.reports.map((r) => r.serial), [1, 2]);
  assert.equal(data.reports[1].isFinal, true);
  assert.equal(data.endMs, ORIGIN + 56_000 + REPLAY_EEW_KEEP_MS);
});

test("normalizedが無い古いJSONは分かりやすいエラー", () => {
  assert.throws(() => parseReplayEewJson(JSON.stringify({ schemaVersion: "1.1.0", event: {}, reports: [] })), /v0\.4\.0/);
});

test("JSONでないものはエラー", () => {
  assert.throws(() => parseReplayEewJson("not json"));
});

test("事例の緯度経度が無くても、各報に震源があれば再生できる。どちらも無ければエラー", () => {
  const j = JSON.parse(sampleJson());
  j.normalized.event.latitude = null;
  assert.throws(() => parseReplayEewJson(JSON.stringify(j)), /緯度・経度/);
  // サンプルは配列の先頭が第2報、2番目が第1報
  j.normalized.reports[0].hypocenter = { latitude: 35.5, longitude: 140.5, depthKm: null, magnitude: null };
  j.normalized.reports[1].hypocenter = { latitude: 35, longitude: 140, depthKm: 10, magnitude: 6 };
  const d = parseReplayEewJson(JSON.stringify(j));
  const c = buildReplayEewAt(d, ORIGIN + 80_000)[0];
  assert.equal(c.latitude, 35.5);
  assert.equal(c.depth, 50); // 報側の深さが無い時は事例全体の値で補う
  assert.equal(buildReplayEewAt(d, ORIGIN + 50_000)[0].latitude, 35);
});

test("キャンセル報は取消として出し、短い時間で消える", () => {
  const j = JSON.parse(sampleJson());
  j.normalized.reports.push({ serial: 3, issuedAtMs: ORIGIN + 80_000, isFinal: true, isCancel: true, maxIntensityKey: null, areas: [] });
  const d = parseReplayEewJson(JSON.stringify(j));
  assert.equal(buildReplayEewAt(d, ORIGIN + 70_000)[0].cancelled, false);
  assert.equal(buildReplayEewAt(d, ORIGIN + 80_000)[0].cancelled, true);
  assert.equal(buildReplayEewAt(d, ORIGIN + 80_000 + REPLAY_EEW_CANCEL_KEEP_MS - 1).length, 1);
  assert.deepEqual(buildReplayEewAt(d, ORIGIN + 80_000 + REPLAY_EEW_CANCEL_KEEP_MS), []);
});

test("発表時刻のある報が無ければエラー", () => {
  assert.throws(() => parseReplayEewJson(sampleJson({ reports: [{ serial: 1, issuedAtMs: null, areas: [] }] })), /1件もありません/);
});

test("最初の報の前は出さない", () => {
  assert.deepEqual(buildReplayEewAt(data, ORIGIN + 49_999), []);
});

test("再生時刻までの最新の報を出す(続報は同じeventId)", () => {
  const first = buildReplayEewAt(data, ORIGIN + 50_000)[0];
  assert.equal(first.serial, "1");
  assert.equal(first.isFinal, false);
  assert.equal(first.maxIntensityKey, "5-");
  const second = buildReplayEewAt(data, ORIGIN + 70_000)[0];
  assert.equal(second.serial, "2");
  assert.equal(second.isFinal, true);
  assert.equal(second.eventId, first.eventId);
});

test("カードの形がライブのEEWと同じ", () => {
  const c = buildReplayEewAt(data, ORIGIN + 60_000)[0];
  assert.equal(c.cancelled, false);
  assert.equal(c.isTraining, false);
  assert.equal(c.isWarnLevel, true);
  assert.equal(c.isPlum, false);
  assert.equal(c.source, "replay");
  assert.equal(c.originTime, "2026/08/23 02:00:00");
  assert.equal(c.originTimeMs, ORIGIN);
  assert.equal(c.place, "茨城県南部");
  assert.equal(c.depth, 50);
  assert.equal(c.magnitude, 5.9);
  assert.equal(c.areas[0].name, "茨城県南部");
  assert.equal(c.areas[0].maxIntensityKey, "5+");
});

test("最終報から一定時間たつと消える", () => {
  const last = ORIGIN + 56_000;
  assert.equal(buildReplayEewAt(data, last + REPLAY_EEW_KEEP_MS - 1).length, 1);
  assert.deepEqual(buildReplayEewAt(data, last + REPLAY_EEW_KEEP_MS), []);
});

test("データなし・時刻なしは空", () => {
  assert.deepEqual(buildReplayEewAt(null, ORIGIN), []);
  assert.deepEqual(buildReplayEewAt(data, null), []);
});

test("EEWだけの再生: 1秒刻みで値が空のフレームを範囲全体に作る", () => {
  const frames = buildEewOnlyFrames(data);
  assert.equal(frames[0].dataTime.getTime(), Math.floor(data.startMs / 1000) * 1000);
  assert.equal(frames[1].dataTime.getTime() - frames[0].dataTime.getTime(), 1000);
  assert.ok(frames[frames.length - 1].dataTime.getTime() >= data.endMs);
  assert.ok(frames.every((f) => f.entries.length === 0));
});

test("震度ファイルの範囲との照合", () => {
  const frameAt = (ms: number) => ({ dataTime: new Date(ms), entries: [] });
  assert.equal(eewRangeNote([frameAt(ORIGIN - 60_000), frameAt(ORIGIN + 600_000)], data), null);
  assert.match(eewRangeNote([frameAt(ORIGIN + 600_000), frameAt(ORIGIN + 700_000)], data) ?? "", /範囲外/);
  assert.match(eewRangeNote([frameAt(ORIGIN + 53_000), frameAt(ORIGIN + 700_000)], data) ?? "", /一部/);
});

test("再生の開始は地震の発生時刻", async () => {
  const { replayStartMs } = await import("../src/replayEew.ts");
  const d = parseReplayEewJson(sampleJson());
  assert.equal(replayStartMs(d), ORIGIN);
  // 発生時刻が無いファイルは、第1報の発表時刻で補う
  const j = JSON.parse(sampleJson());
  j.normalized.event.originTimeMs = null;
  assert.equal(replayStartMs(parseReplayEewJson(JSON.stringify(j))), ORIGIN + 50_000);
  // フレームの範囲の先頭は、発生時刻より前から始まる
  assert.ok(d.startMs < ORIGIN);
});

test("対象地域にページの案内文が混ざっていても除く(古いファイル対策)", () => {
  const j = JSON.parse(sampleJson());
  j.normalized.reports[0].areas = [
    { name: "東北", minIntensityKey: "6-", maxIntensityKey: "6-", openEnded: false },
    { name: "このページのトップへ", minIntensityKey: "6-", maxIntensityKey: "6-", openEnded: false },
    { name: "気象庁ホームページについて", minIntensityKey: "6-", maxIntensityKey: "6-", openEnded: false },
  ];
  const d = parseReplayEewJson(JSON.stringify(j));
  const card = buildReplayEewAt(d, ORIGIN + 70_000)[0];
  // 対象地域は累積するため、第1報の茨城県南部も残る
  assert.deepEqual(card.areas.map((a: any) => a.name).sort(), ["東北", "茨城県南部"].sort());
});

test("警報の対象地域は続報で広がるだけで、狭まらない", () => {
  const j = JSON.parse(sampleJson());
  const area = (name: string, k: string) => ({ name, minIntensityKey: k, maxIntensityKey: k, openEnded: false });
  // サンプルは配列の先頭が第2報
  j.normalized.reports[1].areas = [area("茨城県南部", "5-")];
  j.normalized.reports[0].areas = [area("千葉県北西部", "5-"), area("茨城県南部", "4")];
  const d = parseReplayEewJson(JSON.stringify(j));
  const c1 = buildReplayEewAt(d, ORIGIN + 50_000)[0];
  assert.deepEqual(c1.areas.map((a: any) => a.name), ["茨城県南部"]);
  const c2 = buildReplayEewAt(d, ORIGIN + 60_000)[0];
  assert.deepEqual(c2.areas.map((a: any) => a.name).sort(), ["千葉県北西部", "茨城県南部"]);
  // 地域ごとの予想震度は、最後に出た報の値
  assert.equal(c2.areas.find((a: any) => a.name === "茨城県南部").maxIntensityKey, "4");
  // 後の報で地域が欠けても、対象のまま残る
  j.normalized.reports[0].areas = [area("千葉県北西部", "5-")];
  const d2 = parseReplayEewJson(JSON.stringify(j));
  const c3 = buildReplayEewAt(d2, ORIGIN + 60_000)[0];
  assert.deepEqual(c3.areas.map((a: any) => a.name).sort(), ["千葉県北西部", "茨城県南部"]);
});

test("EEWの一部が震度ファイルの範囲外でも、フレームを延ばして発生時刻から始められる", async () => {
  const { extendFramesForEew } = await import("../src/replayEew.ts");
  const frameAt = (ms: number) => ({ dataTime: new Date(ms), entries: [] });
  // 震度ファイルは発生の20秒後から始まる
  const bin = [frameAt(ORIGIN + 20_000), frameAt(ORIGIN + 53_000)];
  const out = extendFramesForEew(bin, data);
  assert.ok(out[0].dataTime.getTime() <= ORIGIN);
  assert.ok(out[out.length - 1].dataTime.getTime() >= data.endMs - 1000);
  assert.ok(out.includes(bin[0]) && out.includes(bin[1]));
  assert.equal(out.filter((f) => f.dataTime.getTime() === bin[0].dataTime.getTime()).length, 1);
  // 全く重ならないなら、そのまま
  const far = [frameAt(ORIGIN + 9_000_000)];
  assert.equal(extendFramesForEew(far, data), far);
});

test("M1.0・深さ10kmの報はPLUM法として扱う", () => {
  const j = JSON.parse(sampleJson());
  // サンプルは配列の先頭が第2報
  j.normalized.reports[1].hypocenter = { latitude: 36.1, longitude: 139.9, depthKm: 10, magnitude: 1.0 };
  const d = parseReplayEewJson(JSON.stringify(j));
  const plum = buildReplayEewAt(d, ORIGIN + 50_000)[0];
  assert.equal(plum.isPlum, true);
  assert.equal(plum.areas.every((a: any) => a.isPlum), true);
  // 続報で通常の震源に変われば、PLUM法ではなくなる
  const normal = buildReplayEewAt(d, ORIGIN + 60_000)[0];
  assert.equal(normal.isPlum, false);
  assert.equal(normal.areas.some((a: any) => a.isPlum), false);
});
