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
