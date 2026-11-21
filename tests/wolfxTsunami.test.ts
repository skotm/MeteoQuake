import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWolfxTsunami, utcIsoToJstSlash } from "../src/wolfxTsunami.ts";

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
    { code: "100", name: "北海道太平洋沿岸東部", level: "advisory", firstWave: { time: "2026-11-20T09:30:00Z", text: "" }, maxWave: { height: 1, text: "1m" } },
    { code: "101", name: "青森県太平洋沿岸", level: "warning", firstWave: { text: "ただちに津波来襲と予測" }, maxWave: { text: "高い" } },
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
