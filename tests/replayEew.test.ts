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

test("警報の対象地域: 予報の段階は対象地域なし。警報になる報で震度4以上の地域がまとめて入る", () => {
  const j = JSON.parse(sampleJson());
  const area = (name: string, k: string) => ({ name, minIntensityKey: k, maxIntensityKey: k, openEnded: false });
  j.normalized.reports = [
    { serial: 1, issuedAtMs: ORIGIN + 10_000, maxIntensityKey: "1", maxIntensityOpenEnded: true, areas: [] },
    { serial: 2, issuedAtMs: ORIGIN + 20_000, maxIntensityKey: "4", areas: [area("A", "4"), area("B", "3")] },
    { serial: 3, issuedAtMs: ORIGIN + 30_000, maxIntensityKey: "5-", areas: [area("A", "4"), area("C", "5-"), area("D", "4"), area("B", "3")] },
    // 震度4の地域だけが増える続報: 対象地域は増えない
    { serial: 4, issuedAtMs: ORIGIN + 40_000, maxIntensityKey: "5-", areas: [area("A", "4"), area("C", "5-"), area("E", "4")] },
    // 新たに震度5弱以上の地域が出る続報: その時点の震度4の地域(E, F)もまとめて加わる
    { serial: 5, issuedAtMs: ORIGIN + 50_000, maxIntensityKey: "5+", areas: [area("C", "5-"), area("G", "5+"), area("E", "4"), area("F", "4")] },
  ];
  const d = parseReplayEewJson(JSON.stringify(j));
  const at = (sec: number) => buildReplayEewAt(d, ORIGIN + sec * 1000)[0];
  const names = (c: any) => c.areas.map((a: any) => a.name).sort();
  assert.equal(at(10).isWarnLevel, false);
  assert.deepEqual(at(10).areas, []);
  assert.equal(at(10).maxIntensityKey, "1");
  assert.equal(at(20).isWarnLevel, false);
  assert.deepEqual(at(20).areas, []);
  assert.equal(at(30).isWarnLevel, true);
  assert.deepEqual(names(at(30)), ["A", "C", "D"]); // Bは震度3なので入らない
  assert.deepEqual(names(at(40)), ["A", "C", "D"]); // Eは震度4だけの増加なので入らない
  assert.deepEqual(names(at(50)), ["A", "C", "D", "E", "F", "G"]);
});

test("発生時刻が分単位の履歴は、検知時刻の少し前と推定する", async () => {
  const { ORIGIN_BEFORE_DETECTION_MS } = await import("../src/replayEew.ts");
  const minuteStart = Date.UTC(2026, 10, 6, 10, 39, 0);
  const detection = minuteStart + 37_900;
  const j = JSON.parse(sampleJson());
  j.normalized.event.originTimeMs = minuteStart;
  j.normalized.event.originTimePrecision = "minute";
  j.normalized.event.detectionTimeMs = detection;
  j.normalized.reports = [{ serial: 1, issuedAtMs: detection + 4700, maxIntensityKey: "2", maxIntensityOpenEnded: true, areas: [] }];
  const d = parseReplayEewJson(JSON.stringify(j));
  assert.equal(d.originTimeMs, detection - ORIGIN_BEFORE_DETECTION_MS);
  assert.equal(replayStartMs0(d), detection - ORIGIN_BEFORE_DETECTION_MS);
  assert.ok(d.warnings.some((w) => /推定/.test(w)));
  // 検知が分の先頭に近い時は、分の先頭より前にしない
  j.normalized.event.detectionTimeMs = minuteStart + 3000;
  const d2 = parseReplayEewJson(JSON.stringify(j));
  assert.equal(d2.originTimeMs, minuteStart);
  // 秒まである発生時刻は、そのまま使う
  j.normalized.event.originTimePrecision = "second";
  j.normalized.event.originTimeMs = minuteStart + 12_300;
  assert.equal(parseReplayEewJson(JSON.stringify(j)).originTimeMs, minuteStart + 12_300);
});
import { replayStartMs as replayStartMs0 } from "../src/replayEew.ts";

test("複数のEEW: 同時に出し、新しい地震を先頭に。震度ファイルと重なるものだけ範囲を延ばす", async () => {
  const { buildReplayEewsAt, extendFramesForEews, replayStartForList, eewListRange, buildEewOnlyFramesFor, eewOverlapsRange } = await import("../src/replayEew.ts");
  const mk = (id: string, origin: number, name: string) => {
    const j = JSON.parse(sampleJson());
    j.normalized.event.eventId = id;
    j.normalized.event.originTimeMs = origin;
    j.normalized.event.hypocenterName = name;
    j.normalized.reports = [
      { serial: 1, issuedAtMs: origin + 5_000, maxIntensityKey: "5-", areas: [{ name: "A", minIntensityKey: "5-", maxIntensityKey: "5-", openEnded: false }] },
      { serial: 2, issuedAtMs: origin + 12_000, maxIntensityKey: "5-", areas: [{ name: "A", minIntensityKey: "5-", maxIntensityKey: "5-", openEnded: false }] },
    ];
    return parseReplayEewJson(JSON.stringify(j));
  };
  const a = mk("a", ORIGIN, "地震A");
  const b = mk("b", ORIGIN + 20_000, "地震B"); // Aの最終報の後(90秒は表示が残る)に始まる
  // 同時に出ている間は、新しい地震が先頭
  const both = buildReplayEewsAt([a, b], ORIGIN + 30_000);
  assert.deepEqual(both.map((c: any) => c.place), ["地震B", "地震A"]);
  assert.equal(both[0].eventId, "replay_b");
  // Aが消えた後はBだけ
  assert.deepEqual(buildReplayEewsAt([a, b], ORIGIN + 12_000 + REPLAY_EEW_KEEP_MS + 1).map((c: any) => c.place), ["地震B"]);
  assert.deepEqual(buildReplayEewsAt([], ORIGIN), []);
  // 始まりは、範囲内で最も早い発生時刻
  assert.equal(replayStartForList([a, b], ORIGIN - 1000, ORIGIN + 1_000_000), ORIGIN);
  assert.equal(replayStartForList([a, b], ORIGIN + 10_000, ORIGIN + 1_000_000), ORIGIN + 20_000);
  assert.equal(replayStartForList([a, b], ORIGIN + 500_000, ORIGIN + 1_000_000), null);
  // 震度ファイル(発生の30秒後から10分間)と重なるのはBだけ、のような時、重なるものの範囲まで延ばす
  const frameAt = (ms: number) => ({ dataTime: new Date(ms), entries: [] });
  const bin = [frameAt(ORIGIN + 20_000), frameAt(ORIGIN + 600_000)];
  assert.equal(eewOverlapsRange(a, bin[0].dataTime.getTime(), bin[1].dataTime.getTime()), false);
  assert.equal(eewOverlapsRange(b, bin[0].dataTime.getTime(), bin[1].dataTime.getTime()), true);
  const ext = extendFramesForEews(bin, [a, b]);
  assert.ok(ext[0].dataTime.getTime() <= ORIGIN + 20_000 - 1000 || ext[0].dataTime.getTime() === ORIGIN + 20_000);
  // Aだけなら範囲外なのでそのまま
  assert.equal(extendFramesForEews(bin, [a]), bin);
  // EEWだけの再生: 全ファイルの範囲を1つの時計で
  const r = eewListRange([a, b]);
  assert.equal(r.startMs, a.startMs);
  assert.equal(r.endMs, b.endMs);
  const frames = buildEewOnlyFramesFor([a, b]);
  assert.equal(frames[0].dataTime.getTime(), Math.floor(a.startMs / 1000) * 1000);
  assert.ok(frames[frames.length - 1].dataTime.getTime() >= b.endMs);
});
