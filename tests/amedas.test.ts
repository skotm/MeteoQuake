import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore
import * as A from "../src/app/weather/amedas.js";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; A.clearAmedasFrameCache(); });

test("時刻: JSTキーとラベル、latest_timeの10分切り下げ", () => {
  const ms = Date.parse("2026-11-22T16:13:00+09:00");
  const latest = A.parseAmedasLatestTime("2026-11-22T16:13:00+09:00\n");
  assert.equal(A.amedasTimeKey(latest), "20261122161000");
  assert.equal(A.amedasTimeLabel(latest), "16:10");
  assert.equal(latest, Math.floor(ms / 600000) * 600000);
  assert.equal(A.parseAmedasLatestTime("garbage"), null);
  assert.equal(A.amedasKeyToMs("20261122161000"), latest);
  // 日付またぎ
  assert.equal(A.amedasTimeKey(Date.parse("2026-11-22T00:00:00+09:00")), "20261122000000");
});

test("コマ: 3時間=19コマ、最後が最新", () => {
  const latest = A.parseAmedasLatestTime("2026-11-22T16:10:00+09:00")!;
  const fr = A.buildAmedasFrames(latest);
  assert.equal(fr.length, 19);
  assert.equal(fr[18].timeMs, latest);
  assert.equal(fr[0].timeMs, latest - 180 * 60000);
  assert.equal(A.buildAmedasFrames(null).length, 0);
});

test("値の取り出し: 欠測・品質・存在判定", () => {
  const e = { temp: [12.3, 0], humidity: [null, 0], wind: [3, 5], snow: [0, 0] };
  assert.equal(A.amedasPick(e, "temp"), 12.3);
  assert.equal(A.amedasPick(e, "humidity"), null);
  assert.equal(A.amedasPick(e, "wind"), null, "品質が悪い値は欠測扱い");
  assert.equal(A.amedasPick(e, "nope"), null);
  assert.equal(A.amedasObserves(e, "humidity"), true);
  assert.equal(A.amedasObserves(e, "nope"), false);
  assert.equal(A.formatAmedasValue(-0.04, 1), "0.0");
  assert.equal(A.formatAmedasValue(null), "--");
});

test("風向: 16=北、矢印は吹いていく向き", () => {
  assert.equal(A.windDirName(16), "北");
  assert.equal(A.windDirName(4), "東");
  assert.equal(A.windDirName(0), "静穏");
  assert.equal(A.windArrowRotation(16), 180); // 北風→南向き
  assert.equal(A.windArrowRotation(4), 270);  // 東風→西向き
  assert.equal(A.windArrowRotation(0), null);
});

test("色: 端・補間・文字色", () => {
  const st = A.AMEDAS_ELEMENTS.temp.stops;
  assert.equal(A.amedasColor(st, -99), st[0][1]);
  assert.equal(A.amedasColor(st, 99), st[st.length - 1][1]);
  const mid = A.amedasColor(st, 2.5);
  assert.match(mid, /^#[0-9a-f]{6}$/);
  assert.equal(A.amedasTextColor("#ffffff"), "#111111");
  assert.equal(A.amedasTextColor("#1a237e"), "#ffffff");
});

test("GeoJSON: 未観測は出さず、欠測は灰色ラベル無し", () => {
  const table = {
    "1": { code: "1", name: "A", lat: 35, lon: 139 },
    "2": { code: "2", name: "B", lat: 36, lon: 140 },
    "3": { code: "3", name: "C", lat: 37, lon: 141 },
  };
  const frame = { "1": { temp: [20.04, 0] }, "2": { temp: [null, 0] }, "3": { humidity: [50, 0] }, "9": { temp: [1, 0] } };
  const gj = A.buildAmedasGeoJson(table, frame, "temp");
  assert.equal(gj.features.length, 2);
  const a = gj.features.find((f: any) => f.properties.code === "1");
  assert.equal(a.properties.label, "20.0");
  assert.deepEqual(a.geometry.coordinates, [139, 35]);
  const b = gj.features.find((f: any) => f.properties.code === "2");
  assert.equal(b.properties.label, "");
  assert.equal(b.properties.v, null);
  // 風は矢印角を持つ
  const w = A.buildAmedasGeoJson(table, { "1": { wind: [5, 0], windDirection: [16, 0] } }, "wind");
  assert.equal(w.features[0].properties.rot, 180);
  assert.equal(A.buildAmedasGeoJson(null, frame, "temp").features.length, 0);
});

test("10分値の取得: 404はnull、LRUは6件まで・nullは保持しない", async () => {
  let calls: string[] = [];
  globalThis.fetch = (async (u: any) => { calls.push(String(u)); return String(u).includes("000000") ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => ({ x: 1 }) }; }) as any;
  const base = Date.parse("2026-11-22T10:00:00+09:00");
  assert.equal(await A.loadAmedasFrame(Date.parse("2026-11-22T00:00:00+09:00")), null);
  const n0 = calls.length;
  await A.loadAmedasFrame(Date.parse("2026-11-22T00:00:00+09:00"));
  assert.equal(calls.length, n0 + 1, "nullは保持せず再取得する");
  for (let i = 0; i < 8; i++) await A.loadAmedasFrame(base + i * 600000);
  const n1 = calls.length;
  await A.loadAmedasFrame(base + 7 * 600000); // 直近 → キャッシュ
  assert.equal(calls.length, n1);
  await A.loadAmedasFrame(base); // 追い出された → 再取得
  assert.equal(calls.length, n1 + 1);
});

test("時系列: ブロックをまたいで結合し、範囲外を除く", async () => {
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    const m = /(\d{8})_(\d{2})\.json/.exec(url)!;
    const body: any = {};
    const h = Number(m[2]);
    for (let k = 0; k < 18; k++) {
      const mins = h * 60 + k * 10;
      const key = `${m[1]}${String(Math.floor(mins / 60)).padStart(2, "0")}${String(mins % 60).padStart(2, "0")}00`;
      body[key] = { temp: [mins / 10, 0], precipitation10m: [0, 0], wind: [null, 0], windDirection: [4, 0] };
    }
    return { ok: true, status: 200, json: async () => body };
  }) as any;
  const latest = A.parseAmedasLatestTime("2026-11-22T16:10:00+09:00")!;
  const s = await A.loadAmedasSeries("44132", latest);
  assert.ok(s.length >= 18 && s.length <= 19);
  assert.ok(s.every((r: any, i: number) => i === 0 || r.timeMs > s[i - 1].timeMs));
  assert.ok(s[0].timeMs >= latest - 180 * 60000 && s[s.length - 1].timeMs <= latest);
  assert.equal(s[0].wind, null);
  assert.equal(s[0].windDir, 4);
});

test("詳細行: 観測している要素だけ", () => {
  const rows = A.buildAmedasDetailRows({ temp: [10, 0], wind: [3.2, 0], windDirection: [16, 0], humidity: [null, 0] });
  assert.deepEqual(rows.map((r: any) => r.label), ["気温", "風", "湿度"]);
  assert.equal(rows[1].text, "北 3.2m/s");
  assert.equal(rows[2].text, "--");
});

test("詳細モデル: 主役・降水・風・その他に分け、未観測は含めない", () => {
  const m = A.buildAmedasDetailModel({
    temp: [6.44, 0], precipitation10m: [0, 0], precipitation1h: [0, 0], wind: [1.0, 0], windDirection: [14, 0],
    humidity: [58, 0], sun1h: [0, 0],
  });
  assert.equal(m.temp.text, "6.4℃");
  assert.deepEqual(m.precip.map((r: any) => r.label), ["10分", "1時間"]);
  assert.equal(m.wind.dirName, "北西");
  assert.equal(m.wind.speedText, "1.0m/s");
  assert.equal(m.gust, null);
  assert.deepEqual(m.others.map((r: any) => r.label), ["湿度", "日照(1時間)"]);
  assert.equal(A.buildAmedasDetailModel(null), null);
  assert.equal(A.buildAmedasDetailModel({ wind: [null, 0] }).wind.speedText, "--");
});

test("グラフ目盛り: きりのよい刻みで範囲を覆う", () => {
  const a = A.niceTicks(-0.6, 1.4, 3);
  assert.deepEqual(a.ticks, [-1, 0, 1, 2]);
  assert.equal(a.min, -1); assert.equal(a.max, 2); assert.equal(a.decimals, 0);
  const b = A.niceTicks(0, 1, 3); // 降水量: 0〜1mm
  assert.deepEqual(b.ticks, [0, 0.5, 1]); assert.equal(b.decimals, 1);
  const c = A.niceTicks(5, 5, 3); // 一定値でも潰れない
  assert.ok(c.max > c.min);
  const d = A.niceTicks(0, 7.3, 3);
  assert.ok(d.min <= 0 && d.max >= 7.3);
  assert.ok(d.ticks.length >= 2 && d.ticks.length <= 6);
});

test("横軸の目盛り: 範囲内の正時だけ", () => {
  const t0 = A.amedasKeyToMs("20261122194000")!, t1 = A.amedasKeyToMs("20261122224000")!;
  const t = A.hourTicks(t0, t1);
  assert.deepEqual(t.map((x: number) => A.amedasTimeLabel(x)), ["20:00", "21:00", "22:00"]);
  const long = A.hourTicks(t0, t0 + 10 * 3600000);
  assert.ok(long.length <= 5);
  const day = A.hourTicks(t0, t0 + 24 * 3600000);
  assert.ok(day.length >= 3 && day.length <= 5, `24h: ${day.length}本`);
  assert.ok(day.every((x: number, i: number) => i === 0 || x - day[i - 1] === day[1] - day[0]), "等間隔");
});


test("時系列: 24時間を取得でき、ブロックはキャッシュされて範囲切替で再取得しない", async () => {
  A.clearAmedasSeriesCache();
  let calls = 0;
  globalThis.fetch = (async (u: any) => {
    calls++;
    const m = /(\d{8})_(\d{2})\.json/.exec(String(u))!;
    const body: any = {};
    for (let k = 0; k < 18; k++) {
      const mins = Number(m[2]) * 60 + k * 10;
      body[`${m[1]}${String(Math.floor(mins / 60)).padStart(2, "0")}${String(mins % 60).padStart(2, "0")}00`] = { temp: [1, 0] };
    }
    return { ok: true, status: 200, json: async () => body };
  }) as any;
  const latest = A.parseAmedasLatestTime("2026-11-23T10:00:00+09:00")!;
  const s24 = await A.loadAmedasSeries("44132", latest, 24);
  assert.ok(s24.length >= 140 && s24.length <= 145, `n=${s24.length}`);
  const n24 = calls;
  assert.ok(n24 >= 8 && n24 <= 10);
  const s6 = await A.loadAmedasSeries("44132", latest, 6);
  assert.ok(s6.length >= 35 && s6.length <= 37);
  assert.equal(calls, n24, "切り替えでは再取得しない");
  A.clearAmedasSeriesCache();
});

test("buildAmedasFrames: 範囲(時間)に応じたコマ数", async () => {
  const { buildAmedasFrames } = await import("../src/app/weather/amedas.js");
  const t = Date.UTC(2026, 10, 23, 3, 0);
  assert.equal(buildAmedasFrames(t).length, 19);
  assert.equal(buildAmedasFrames(t, 1).length, 7);
  assert.equal(buildAmedasFrames(t, 24).length, 145);
  assert.equal(buildAmedasFrames(t, 24).at(-1)!.timeMs, t);
});
