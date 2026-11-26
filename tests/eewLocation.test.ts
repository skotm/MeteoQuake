import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JSモジュール
import { parseJstTimeToMs, resolveMyEewForecast, sanitizeArrivalMs } from "../src/app/eewLocation.js";

test("Wolfxの時刻は端末のタイムゾーンに関わらず日本時間として解釈する", () => {
  assert.equal(parseJstTimeToMs("2026-11-24 23:09:09"), Date.parse("2026-11-24T23:09:09+09:00"));
  assert.equal(parseJstTimeToMs("2026/11/24 23:09:09"), Date.parse("2026-11-24T14:09:09Z"));
  assert.equal(parseJstTimeToMs(""), null);
  assert.equal(parseJstTimeToMs(undefined), null);
});

const eew = {
  cancelled: false,
  areas: [
    { name: "宮城県中部", maxIntensityKey: "5+", arrivalMs: 1000, arrived: false },
    { name: "東京都２３区", maxIntensityKey: "4", arrivalMs: null, arrived: true },
  ],
};

test("現在地の細分区域に一致する対象地域の予測震度・到達時刻を返す", () => {
  const r = resolveMyEewForecast(eew, "宮城県中部");
  assert.deepEqual(r, { areaName: "宮城県中部", inWarnArea: true, intensityKey: "5+", arrivalMs: 1000, arrived: false });
});

test("全角・半角の表記ゆれを吸収する", () => {
  const r = resolveMyEewForecast(eew, "東京都23区");
  assert.equal(r?.inWarnArea, true);
  assert.equal(r?.arrived, true);
});

test("対象地域外・取消済み・区域不明では予測震度も到達時刻も出さない", () => {
  assert.equal(resolveMyEewForecast(eew, "大阪府北部")?.inWarnArea, false);
  assert.equal(resolveMyEewForecast(eew, "大阪府北部")?.intensityKey, null);
  assert.equal(resolveMyEewForecast({ ...eew, cancelled: true }, "宮城県中部"), null);
  assert.equal(resolveMyEewForecast(eew, null), null);
});

test("到達時刻の不正値を弾く", () => {
  const now = 1_000_000;
  assert.equal(sanitizeArrivalMs(now + 5000, NaN, now), now + 5000);
  assert.equal(sanitizeArrivalMs(now + 11 * 60 * 1000, NaN, now), null);
  assert.equal(sanitizeArrivalMs(now - 1, now, now), null);
  assert.equal(sanitizeArrivalMs(null, NaN, now), null);
});

// @ts-expect-error JSモジュール
import { withSimArrivalMs } from "../src/app/simEew.js";

test("シミュレーションの報: 通常方式の地域に到達時刻を付け、PLUM法・レベル法の地域には付けない", () => {
  const sq = (lon: number, lat: number) => ({
    type: "Feature", properties: { name: `区域${lon}` },
    geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + 0.2, lat], [lon + 0.2, lat + 0.2], [lon, lat + 0.2], [lon, lat]]] },
  });
  const geo = { type: "FeatureCollection", features: [sq(139, 36), sq(140, 36)] };
  const originTime = Date.parse("2026-11-25T00:00:00Z");
  const areas = [
    { name: "区域139", maxIntensityKey: "5-" },
    { name: "区域140", maxIntensityKey: "4", isPlum: true },
    { name: "区域X", maxIntensityKey: "4" },
  ];
  const out = withSimArrivalMs(areas, { lat: 36.1, lon: 139.1, originTime }, 10, geo);
  assert.ok(out[0].arrivalMs > originTime && out[0].arrivalMs < originTime + 30_000);
  assert.equal(out[1].arrivalMs, undefined);
  assert.equal(out[2].arrivalMs, undefined);
  assert.equal(withSimArrivalMs(areas, { lat: 36, lon: 139, originTime }, 10, null), areas);
});

// @ts-expect-error JSモジュール
import { parseWolfxWarnAreaArrival } from "../src/app/eewLocation.js";
// @ts-expect-error JSモジュール
import { toEewCardFromWolfx } from "../src/app/liveFeeds.js";
// @ts-expect-error JSモジュール
import { eqlistNeedsRefetch } from "../src/app/useWolfxDetail.js";
import { readFileSync } from "node:fs";

// Wolfx公式の実データの例(2024-04-17 豊後水道の警報)。Timeは"HHMMSS"、Arriveは文字列。
const wolfxWarning = JSON.parse(readFileSync(new URL("./fixtures/wolfx_eew_warning_sample.json", import.meta.url), "utf8"));
const jst = (s: string) => Date.parse(s);

test("Wolfx実データ: 未到達の地域は、HHMMSSの到達予想時刻(日本時間)になる", () => {
  const card = toEewCardFromWolfx(wolfxWarning);
  const ehime = card.areas.find((a: any) => a.name === "愛媛県東予");
  assert.equal(ehime.arrivalMs, jst("2024-04-17T23:15:12+09:00"));
  assert.equal(ehime.arrived, false);
  assert.equal(card.areas.find((a: any) => a.name === "大阪府南部").arrivalMs, jst("2024-04-17T23:16:02+09:00"));
});

test("Wolfx実データ: 『既に到達と予測』は到達済み、PLUM法の地域は到達時刻なし(Timeが入っていても使わない)", () => {
  const card = toEewCardFromWolfx(wolfxWarning);
  const oita = card.areas.find((a: any) => a.name === "大分県南部");
  assert.equal(oita.arrived, true);
  assert.equal(oita.arrivalMs, null);
  const plum = card.areas.find((a: any) => a.name === "愛媛県南予");
  assert.equal(plum.arrived, false);
  assert.equal(plum.arrivalMs, null);
});

test("日付をまたぐ到達時刻は、翌日に繰り上げる(23:59台の発表で00:00台の到達)", () => {
  const ref = jst("2026-11-25T23:59:50+09:00");
  const r = parseWolfxWarnAreaArrival({ Time: "000012", Arrive: "未到達" }, ref);
  assert.equal(r.arrivalMs, jst("2026-11-26T00:00:12+09:00"));
  // 発表の少し前の時刻(すでに到達済み扱い)は、繰り上げない
  assert.equal(parseWolfxWarnAreaArrival({ Time: "235945", Arrive: "未到達" }, ref).arrivalMs, jst("2026-11-25T23:59:45+09:00"));
});

test("Timeが不明(//////)・空、基準時刻なしでは、到達時刻を作らない", () => {
  assert.equal(parseWolfxWarnAreaArrival({ Time: "//////", Arrive: "未到達" }, 1).arrivalMs, null);
  assert.equal(parseWolfxWarnAreaArrival({ Arrive: "未到達" }, 1).arrivalMs, null);
  assert.equal(parseWolfxWarnAreaArrival({ Time: "231512", Arrive: "未到達" }, NaN).arrivalMs, null);
});

test("jma_eqlistのWebSocket: 接続後の最初の1通も、md5が変わった時も取り直す合図になる。同じmd5は合図にしない", () => {
  assert.equal(eqlistNeedsRefetch(null, "aaa"), true); // 接続後の最初の更新(以前は捨てていた)
  assert.equal(eqlistNeedsRefetch("aaa", "bbb"), true);
  assert.equal(eqlistNeedsRefetch("aaa", "aaa"), false);
  assert.equal(eqlistNeedsRefetch("aaa", null), true); // md5が無い時は、念のため取り直す
});
