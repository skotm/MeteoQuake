import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore (JS module)
import { buildCityFillData, resolveCityPolygonCodes, aggregateByCity, cityFillOpacityExpr } from "../src/app/cityFill.js";

const raw = JSON.parse(readFileSync(new URL("../public/map/warning_areas.json", import.meta.url), "utf8"));
const stations = JSON.parse(readFileSync(new URL("../public/map/stations_with_amp_revised.json", import.meta.url), "utf8"));
const { index, collection } = buildCityFillData(raw);

test("collection keeps only code+geometry, drops code-less polygons", () => {
  assert.ok(collection.features.length > 1700 && collection.features.length <= raw.features.length);
  assert.deepEqual(Object.keys(collection.features[0].properties), ["regioncode"]);
});

test("every station city code maps to at least one polygon", () => {
  const seen = new Map<string, string>();
  for (const s of stations) if (s.city?.code) seen.set(s.city.code, s.city.name);
  const missing = [...seen].filter(([c, n]) => resolveCityPolygonCodes(index, c, n).length === 0);
  assert.deepEqual(missing, []);
});

test("every designated-city ward maps to a polygon of its own city (not another city)", () => {
  const seen = new Map<string, string>();
  for (const s of stations) if (s.city?.code && s.city.name.endsWith("区")) seen.set(s.city.code, s.city.name);
  const names = new Map<string, string>();
  for (const f of raw.features) if (f.properties.regioncode) names.set(f.properties.regioncode, f.properties.name);
  for (const [code, name] of seen) {
    if (index.exact.has(code)) continue; // 東京23区などは区ごとのポリゴンがある
    const polys = resolveCityPolygonCodes(index, code, name);
    assert.ok(polys.length > 0, `${name} unresolved`);
    for (const pc of polys) {
      const pn = names.get(pc)!;
      assert.ok(name.includes(pn.slice(0, pn.indexOf("市"))), `${name} (${code}) -> wrong parent ${pn} (${pc})`);
    }
  }
});

test("Fukuoka / Hamamatsu / Kita-Kyushu wards go to their own city", () => {
  assert.deepEqual(resolveCityPolygonCodes(index, "4013200", "福岡博多区"), ["4013000"]);
  assert.deepEqual(resolveCityPolygonCodes(index, "4013700", "福岡早良区"), ["4013000"]);
  assert.deepEqual(resolveCityPolygonCodes(index, "4010100", "北九州門司区"), ["4010000"]);
  assert.deepEqual([...resolveCityPolygonCodes(index, "2214000", "浜松天竜区")].sort(), ["2213001", "2213002"]);
  assert.deepEqual([...resolveCityPolygonCodes(index, "2210100", "静岡葵区")].sort(), ["2210001", "2210002"]);
});

test("exact / split city / designated-city ward", () => {
  assert.deepEqual(resolveCityPolygonCodes(index, "1310300", "港区"), ["1310300"]);
  assert.deepEqual([...resolveCityPolygonCodes(index, "1620100", "富山市")].sort(), ["1620111", "1620112", "1620113"]);
  assert.deepEqual([...resolveCityPolygonCodes(index, "1410100", "横浜鶴見区")].sort(), ["1410011", "1410012"]);
  assert.deepEqual(resolveCityPolygonCodes(index, "0110200", "札幌北区"), ["0110000"]);
  assert.deepEqual(resolveCityPolygonCodes(index, null, null), []);
});

test("aggregateByCity takes max per polygon; area points and code-less points ignored", () => {
  const pts = [
    { cityCode: "1410100", city: "横浜鶴見区", intensityKey: "3" },
    { cityCode: "1410200", city: "横浜神奈川区", intensityKey: "5-" },
    { cityCode: "1310300", city: "港区", intensityKey: "2" },
    { cityCode: null, city: null, intensityKey: "7" },
    { isArea: true, cityCode: "1310300", intensityKey: "7" },
  ];
  const m = aggregateByCity(pts, index);
  assert.equal(m.get("1410011"), "5-");
  assert.equal(m.get("1410012"), "5-");
  assert.equal(m.get("1310300"), "2");
  assert.equal(m.size, 3);
});

test("opacity expressions crossfade around the zoom", () => {
  assert.deepEqual(cityFillOpacityExpr(7.5, true, 0.75), ["interpolate", ["linear"], ["zoom"], 7.35, 0, 7.65, 0.75]);
  assert.deepEqual(cityFillOpacityExpr(7.5, false, 0.75), ["interpolate", ["linear"], ["zoom"], 7.35, 0.75, 7.65, 0]);
});
