/**
 * 気象庁「長周期地震動に関する観測情報(過去の地震)」からの長周期地震動階級の取得。
 *   一覧: https://www.data.jma.go.jp/eew/data/ltpgm_explain/data/past/past_list.html
 *     行ごとに event.php?eventId=<14桁(発生時刻JST・秒まで)>&dir1=data/past&past=1 へのリンクがある。
 *   データ: https://www.data.jma.go.jp/eew/data/ltpgm_explain/data/past/<eventId>/data/level.csv
 *     観測点ごとの階級(都道府県・地域・観測点名・震度・階級の表)。
 * level.csvの列の並び・文字コードは実物で確認できていないため、見出し行(「階級」「地域」「観測点」など)から
 * 列を推定し、見出しが無い場合は値の形から推定する。推定できなければnull(=階級を付けない)を返す。
 */
import { cityNameFromStationName, parseLg, type LongPeriodEvent } from "./longPeriod.ts";

export const JMA_LP_BASE = "https://www.data.jma.go.jp/eew/data/ltpgm_explain/";
export const JMA_LP_PAST_LIST_URL = `${JMA_LP_BASE}data/past/past_list.html`;
export const jmaLpLevelCsvUrl = (eventId: string) => `${JMA_LP_BASE}data/past/${eventId}/data/level.csv`;

/** 一覧HTMLから14桁のeventIdを重複なく取り出す(新旧どちらのリンク形式も拾う)。 */
export function parseJmaPastList(html: string): string[] {
  const set = new Set<string>();
  for (const m of String(html).matchAll(/eventId=(\d{14})/g)) set.add(m[1]);
  for (const m of String(html).matchAll(/data\/past\/(\d{14})\//g)) set.add(m[1]);
  return [...set];
}

/** バイト列を文字列にする。UTF-8で化けたらShift_JISとして読み直す。 */
export function decodeCsvBytes(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  try { return new TextDecoder("shift_jis").decode(buf); } catch { return utf8; }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const clean = (s: string) => s.replace(/[*＊]/g, "").trim();

/** level.csvを、長周期の情報(LongPeriodEvent)にする。階級1以上が1つも無い/列が推定できない時はnull。 */
export function parseJmaLevelCsv(text: string, eventId: string): LongPeriodEvent | null {
  const rows = String(text).replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "").map(splitCsvLine);
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length));

  let header: string[] | null = null;
  let dataRows = rows;
  if (rows[0].some((c) => /[^\d.\-+\s]/.test(c) && /階級|地域|観測点|地点|level|station|area/i.test(c))) {
    header = rows[0];
    dataRows = rows.slice(1);
  }

  let lgCol = -1, stCol = -1, areaCol = -1, prefCol = -1;
  if (header) {
    header.forEach((h, i) => {
      if (lgCol < 0 && /階級|level|lg|lpgm/i.test(h) && !/震度/.test(h)) lgCol = i;
      else if (stCol < 0 && /観測点|地点|station|name/i.test(h)) stCol = i;
      else if (areaCol < 0 && /地域|区域|area|region/i.test(h)) areaCol = i;
      else if (prefCol < 0 && /都道府県|府県|pref/i.test(h)) prefCol = i;
    });
  }
  // 見出しで決まらない列は、値の形から推定する。
  if (lgCol < 0) {
    for (let c = width - 1; c >= 0; c--) {
      const vals = dataRows.map((r) => r[c]).filter((v) => v != null && v !== "");
      if (vals.length > 0 && vals.every((v) => /^[0-4]$/.test(v))) { lgCol = c; break; }
    }
  }
  if (stCol < 0) {
    for (let c = 0; c < width; c++) {
      const vals = dataRows.map((r) => r[c] ?? "");
      if (vals.filter((v) => /[市町村区]/.test(v)).length >= vals.length * 0.6) { stCol = c; break; }
    }
  }
  if (lgCol < 0) return null;

  const areaMax = new Map<string, number>();
  const cityMax = new Map<string, number>();
  let maxLg = 0;
  for (const r of dataRows) {
    const lg = parseLg(r[lgCol]);
    if (lg == null || lg < 1) continue;
    maxLg = Math.max(maxLg, lg);
    if (areaCol >= 0 && r[areaCol]) {
      const pref = prefCol >= 0 ? r[prefCol] ?? "" : "";
      let area = clean(r[areaCol]);
      if (pref && !area.startsWith(pref)) area = pref + area; // 「熊本県」+「熊本」のように分かれている場合
      areaMax.set(area, Math.max(areaMax.get(area) ?? 0, lg));
    }
    if (stCol >= 0 && r[stCol]) {
      const city = cityNameFromStationName(clean(r[stCol]));
      cityMax.set(city, Math.max(cityMax.get(city) ?? 0, lg));
    }
  }
  if (maxLg < 1) return null;
  const byLgThenName = (a: { lg: number; name: string }, b: { lg: number; name: string }) =>
    b.lg - a.lg || a.name.localeCompare(b.name, "ja");
  return {
    eventId,
    maxLg,
    issuedAtMs: null,
    cities: [...cityMax].map(([name, lg], i) => ({ code: `jma${i}`, name, lg })).sort(byLgThenName),
    areas: [...areaMax].map(([name, lg]) => ({ name, lg })).sort(byLgThenName),
    hypocenterName: null,
  };
}
