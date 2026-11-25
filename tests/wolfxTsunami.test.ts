import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWolfxTsunami, utcIsoToJstSlash, mergeWolfxObservations, matchTideStationByName } from "../src/wolfxTsunami.ts";

const expired = JSON.parse(readFileSync(new URL("./fixtures/wolfx_tsunami_expired.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-20T10:00:00Z");

test("expired sample is untrusted, never 'clear'", () => {
  const r = parseWolfxTsunami(expired, NOW);
  assert.equal(r.state, "untrusted");
  assert.equal(r.card, null);
  assert.deepEqual(r.eventIds, ["20261106193937"]);
});

const active = {
  status: "active", trusted: true, validUntil: "2026-11-20T12:00:00Z",
  report: { id: "R1", time: "2026-11-20T09:00:00Z", eventIds: ["E1"] },
  areas: [
    { code: "100", name: "北海道太平洋沿岸東部", level: "advisory", firstWave: { time: "2026-11-20T09:30:00Z" }, maxWave: { height: 1, text: "1m" } },
    { code: "101", name: "青森県太平洋沿岸", level: "warning", firstWave: { condition: "ただちに津波来襲と予測" }, maxWave: { text: "高い" } },
    { code: "102", name: "x", level: "cleared" },
  ],
  comments: { warning: "警報です" },
};

test("active maps levels to grades and picks max", () => {
  const r = parseWolfxTsunami(active, NOW);
  assert.equal(r.state, "active");
  assert.equal(r.card!.areas.length, 2);
  assert.equal(r.card!.maxGrade, "Warning");
  assert.equal(r.card!.areas[0].grade, "Watch");
  assert.equal(r.card!.areas[0].firstHeightTime, "2026/11/20 18:30:00");
  assert.equal(r.card!.areas[1].firstHeightCondition, "ただちに津波来襲と予測");
  assert.equal(r.card!.time, "2026/11/20 18:00:00");
});

test("validUntil enforced locally", () => {
  assert.equal(parseWolfxTsunami(active, Date.parse("2026-11-20T12:00:01Z")).state, "untrusted");
});

test("active with empty areas is untrusted", () => {
  assert.equal(parseWolfxTsunami({ ...active, areas: [] }, NOW).state, "untrusted");
});

test("cleared and none_reported -> clear with cancelled card", () => {
  for (const s of ["cleared", "none_reported"]) {
    const r = parseWolfxTsunami({ ...active, status: s, areas: [] }, NOW);
    assert.equal(r.state, "clear");
    assert.equal(r.card!.cancelled, true);
  }
});

test("garbage input is untrusted", () => {
  assert.equal(parseWolfxTsunami(null, NOW).state, "untrusted");
  assert.equal(utcIsoToJstSlash("bad"), null);
});

test("'ただちに' in firstWave text sets immediate", () => {
  const r = parseWolfxTsunami(active, NOW);
  assert.equal(r.card!.areas[0].immediate, false);
  assert.equal(r.card!.areas[1].immediate, true);
});

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));

test("real warning sample: 'ただちに' and wave text come from firstWave.condition / maxWave.text", () => {
  const d = fx("wolfx_tsunami_warning.json");
  const r = parseWolfxTsunami(d, Date.parse(d.validUntil) - 60_000);
  assert.equal(r.state, "active");
  const a = r.card!.areas.find(x => x.name === "宮古島・八重山地方")!;
  assert.equal(a.immediate, true);
  assert.equal(a.firstHeightCondition, "ただちに津波来襲と予測");
  assert.equal(a.maxHeightDescription, "３ｍ");
  assert.deepEqual(r.card!.observations, []);
});

test("real with_observations sample: observed stations and flat estimated points", () => {
  const d = fx("wolfx_tsunami_with_observations.json");
  const r = parseWolfxTsunami(d, Date.parse(d.validUntil) - 60_000);
  assert.equal(r.state, "active");
  const obs = r.card!.observations;
  assert.ok(obs.length > 0);
  const observed = obs.flatMap(o => o.observed);
  const estimated = obs.flatMap(o => o.estimated);
  assert.ok(observed.length > 0 && estimated.length > 0);
  // 沿岸の観測点は予報区名を持ち、沖合(GPS波浪計など)の観測点は予報区名の代わりに観測機器を持つ。推定点は区域なし。
  assert.ok(observed.every(s => s.areaName !== "" || s.sensor));
  assert.ok(observed.some(s => s.areaName !== "") && observed.some(s => s.sensor));
  assert.ok(estimated.every(s => s.areaName === ""));
  // 最大波の値か状態文言(観測中・推定中・重要など)のどちらかが必ず出る
  assert.ok(observed.every(s => s.maxText || s.maxTime || s.firstTime));
  // 取消状態の報や波情報なしの点は含まれない
  assert.ok(obs.every(o => !o.cancelled));
});

test("real forecast_only / cleared / cancelled samples", () => {
  const f = fx("wolfx_tsunami_forecast_only.json");
  assert.equal(parseWolfxTsunami(f, Date.parse(f.validUntil) - 1000).card!.maxGrade, "NonEffective");
  const c = fx("wolfx_tsunami_cleared.json");
  assert.equal(parseWolfxTsunami(c, Date.parse(c.validUntil) - 1000).state, "clear");
  const x = fx("wolfx_tsunami_cancelled.json");
  assert.equal(parseWolfxTsunami(x, Date.parse(x.report.time)).state, "untrusted");
});

test("mergeWolfxObservations: newer report wins per station; cancelled reports ignored", () => {
  const st = (name: string, h: number | null, text: string | null) => ({
    areaName: "岩手県", name, code: "c-" + name, sensor: null, maxHeightM: h, maxText: text, maxTime: null, maxTimeMs: null, firstTime: null,
  });
  const merged = mergeWolfxObservations([
    { reportId: "new", time: "2026/11/20 19:00:00", cancelled: false, observed: [st("宮古", 1.2, "１．２ｍ")], estimated: [] },
    { reportId: "old", time: "2026/11/20 18:00:00", cancelled: false, observed: [st("宮古", null, "観測中"), st("釜石", 0.5, "０．５ｍ")], estimated: [] },
    { reportId: "x", time: "2026/11/20 20:00:00", cancelled: true, observed: [st("宮古", 9, "９ｍ")], estimated: [] },
  ]);
  assert.equal(merged.observed.length, 2);
  assert.equal(merged.observed.find(s => s.name === "宮古")!.maxHeightM, 1.2);
});

test("matchTideStationByName: exact first, then partial within the same area", () => {
  const tide = [
    { name: "関根浜", tsunamiAreaName: "青森県太平洋沿岸" },
    { name: "八戸", tsunamiAreaName: "青森県太平洋沿岸" },
    { name: "八戸", tsunamiAreaName: "別の予報区" },
  ];
  assert.equal(matchTideStationByName(tide, "青森県太平洋沿岸", "むつ市関根浜")!.name, "関根浜");
  assert.equal(matchTideStationByName(tide, "別の予報区", "八戸")!.tsunamiAreaName, "別の予報区");
  assert.equal(matchTideStationByName(tide, "青森県太平洋沿岸", "宮古"), null);
});

test("real with_observations sample: every coastal observed station belongs to a forecast area of the card", () => {
  const d = fx("wolfx_tsunami_with_observations.json");
  const r = parseWolfxTsunami(d, Date.parse(d.validUntil) - 60_000);
  const areaNames = new Set(r.card!.areas.map(a => a.name));
  const { observed } = mergeWolfxObservations(r.card!.observations);
  const coastal = observed.filter(s => s.areaName);
  assert.ok(coastal.length > 0);
  assert.ok(coastal.every(s => areaNames.has(s.areaName)));
});

// 実際のWolfx応答(trusted=true・信頼期限内・最後の発表だけが期限切れ)。
const expiredTrusted = JSON.parse(readFileSync(new URL("./fixtures/wolfx_tsunami_expired_trusted.json", import.meta.url), "utf8"));
const NOW_LIVE = Date.parse("2026-11-25T03:43:20Z");

test("trusted な expired は『失効』になる(clear・untrusted にはならず、カードも出さない)", () => {
  const r = parseWolfxTsunami(expiredTrusted, NOW_LIVE);
  assert.equal(r.state, "expired");
  assert.equal(r.card, null);
  assert.deepEqual(r.lastReport, { title: "津波予報", time: "2026/11/06 19:53:00" });
  assert.deepEqual(r.eventIds, ["20261106193937"]);
});

test("expired でも、信頼期限切れ・trusted でない場合は『失効』にせず untrusted のまま", () => {
  // Wolfx自体の更新が止まった場合を、失効と取り違えない
  assert.equal(parseWolfxTsunami(expiredTrusted, Date.parse("2026-11-25T03:45:00Z")).state, "untrusted");
  assert.equal(parseWolfxTsunami({ ...expiredTrusted, trusted: false }, NOW_LIVE).state, "untrusted");
  assert.equal(parseWolfxTsunami({ ...expiredTrusted, validUntil: null }, NOW_LIVE).state, "untrusted");
});
