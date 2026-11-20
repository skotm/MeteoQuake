import test from "node:test";
import assert from "node:assert/strict";
import { parseJmaPastList, parseJmaLevelCsv } from "../src/jmaLongPeriod.ts";

test("一覧から新旧両方のリンクのeventIdを取り出す", () => {
  const html = `<a href="event.php?eventId=20260728162718&dir1=data/past&past=1">詳細</a>
  <a href="https://x/data/past/20220316233628/index.html">詳細</a><a href="event.php?eventId=20260728162718&dir1=data/past&past=1">重複</a>`;
  assert.deepEqual(parseJmaPastList(html).sort(), ["20220316233628", "20260728162718"]);
});

test("見出し付きCSV: 地域・市区町村ごとの最大階級", () => {
  const csv = "都道府県,地域,観測点名,震度,階級\n熊本県,熊本県熊本,熊本市中央区大江,5強,4\n熊本県,熊本県熊本,八代市平山新町,5弱,3\n熊本県,熊本県天草・芦北,芦北町芦北,5弱,3\n福岡県,福岡県福岡,福岡市中央区舞鶴,4,0\n";
  const e = parseJmaLevelCsv(csv, "20260728162718")!;
  assert.equal(e.maxLg, 4);
  assert.deepEqual(e.areas, [{ name: "熊本県熊本", lg: 4 }, { name: "熊本県天草・芦北", lg: 3 }]);
  assert.ok(e.cities.some((c) => c.name === "八代市" && c.lg === 3));
  assert.ok(!e.cities.some((c) => c.name.startsWith("福岡")));
});

test("見出しなしでも階級列を推定し、階級が読めなければnull", () => {
  const e = parseJmaLevelCsv("熊本県,熊本県熊本,八代市平山新町,5弱,2\n熊本県,熊本県熊本,芦北町芦北,4,1\n", "x")!;
  assert.equal(e.maxLg, 2);
  assert.equal(parseJmaLevelCsv("a,b\nc,d\n", "x"), null);
});

test("実物のlevel.csvの形式(先頭が#の見出し・＊付き観測点)", () => {
  const csv = "#震度計番号,観測点名称,地域名称,観測開始時刻,観測時間（分）,長周期地震動階級,長周期地震動階級データ1秒台,2秒台,3秒台,4秒台,5秒台,6秒台,7秒台,観測点緯度,観測点経度\n" +
    "47637,飯田市高羽町,長野県南部,20261108010430,1,1,1,0,0,0,0,0,0,35.5232,137.8226\n" +
    "47636,名古屋千種区日和町,愛知県西部,20261108010430,5,1,1,1,0,0,0,0,0,35.1682,136.9652\n" +
    "32309,豊田市小坂町＊,愛知県西部,20261108010430,1,1,1,0,0,0,0,0,0,35.0813,137.1466\n" +
    "47628,石岡市柿岡,茨城県南部,20261108010550,1,0,0,0,0,0,0,0,0,36.2342,140.1893\n";
  const e = parseJmaLevelCsv(csv, "20261108010430")!;
  assert.equal(e.maxLg, 1);
  assert.deepEqual(e.areas.map((a) => a.name).sort(), ["愛知県西部", "長野県南部"]);
  assert.ok(e.cities.some((c) => c.name === "豊田市") && !e.cities.some((c) => /＊/.test(c.name)));
  assert.ok(!e.areas.some((a) => a.name === "茨城県南部"));
});

test("一覧の発生日時(分)とeventIdの分が違う行でも、表示されている発生日時を使う", async () => {
  const { parseJmaPastListRows } = await import("../src/jmaLongPeriod.ts");
  const { findLongPeriodFor } = await import("../src/longPeriod.ts");
  const html = `<tr><td>2026年07月28日 16時27分</td><td>熊本県熊本地方</td><td>7.1</td><td>階級4</td><td><a href="event.php?eventId=20260728162800&dir1=data/past&past=1">詳細</a></td></tr>
  <tr><td>2016年04月16日 01時25分</td><td>熊本県熊本地方</td><td>7.3</td><td>階級4</td><td><a href="https://x/data/past/20160416012510/index.html">詳細</a></td></tr>`;
  const rows = parseJmaPastListRows(html);
  assert.deepEqual(rows, [
    { eventId: "20260728162800", minuteKey: "2026/07/28 16:27" },
    { eventId: "20160416012510", minuteKey: "2016/04/16 01:25" },
  ]);
  const ev = { eventId: "20260728162800", maxLg: 4, issuedAtMs: null, cities: [], areas: [], hypocenterName: null, originMinuteKey: rows[0].minuteKey! };
  assert.equal(findLongPeriodFor({ time: "2026/07/28 16:27:55" }, [ev]), ev);
});

test("実物(2021年・Shift_JIS)のlevel.csvを文字化けなく読める", async () => {
  const { readFileSync } = await import("node:fs");
  const { decodeCsvBytes } = await import("../src/jmaLongPeriod.ts");
  const b = readFileSync(new URL("./fixtures/jma_level_2021_sjis.csv", import.meta.url));
  const e = parseJmaLevelCsv(decodeCsvBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer), "20210213230800")!;
  assert.equal(e.maxLg, 4);
  assert.equal(e.areas[0].name, "福島県中通り");
  assert.ok(e.cities.some((c) => c.name === "福島市" && c.lg === 4 && c.pref === "福島県"));
});

test("2022年以前の相対リンク(<id>/index.html など)でも読める", async () => {
  const { parseJmaPastListRows } = await import("../src/jmaLongPeriod.ts");
  const html = `<tr><td>2022年03月16日 23時36分</td><td>福島県沖</td><td><a href="20220316233646/index.html">詳細</a></td></tr>
  <tr><td>2021年02月13日 23時07分</td><td>福島県沖</td><td><a href="../past/20210213230800/index.html">詳細</a></td></tr>
  <tr><td>2013年03月31日 16時46分</td><td>宮城県沖</td><td><a href='/eew/data/ltpgm_explain/data/past/20130331164628/index.html'>詳細</a></td></tr>`;
  assert.deepEqual(parseJmaPastListRows(html).map((r) => [r.eventId, r.minuteKey]), [
    ["20220316233646", "2022/03/16 23:36"], ["20210213230800", "2021/02/13 23:07"], ["20130331164628", "2013/03/31 16:46"],
  ]);
});
