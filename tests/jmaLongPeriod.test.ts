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
