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
