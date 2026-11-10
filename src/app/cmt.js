


/* ─────────────────────────────────────────────────────
   発震機構解 — 「この地震の詳細」用

   気象庁の発震機構解のページ(data.jma.go.jp)は正式なJSON APIではなく、一覧のHTMLページと
   地震ごとの詳細HTMLページからなる。fetchでの取得(CORS)自体は実機で確認が必要。
     - 精査版 CMT解(国内)   eqev/data/mech/cmt/   月別一覧 cmtYYYYMM.html
     - 精査版 初動解         eqev/data/mech/ini/   月別一覧 mcYYYYMM.html と最新 top.html
     - 精査版 遠地地震CMT    eqev/data/mech/world_cmt/top.html(全件1ページ)
     - 速報値(自動解析)     eew/data/mech/top.html(最近5日間、初動/CMT国内/CMT全世界)
   どの系統も、一覧で時刻・位置が近い行を探し、その詳細ページから震源球画像や断層面解などを得る。
   さらにUSGSのモーメントテンソル解(FDSN Event API)も探す。
   ───────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────
   「この地震の詳細」(発震機構解)ボタンを出す条件
   震央地名から陸域/海域を判定する。
     - 陸域: 初動発震機構解(M3台の内陸地震にも付く)の対象になるため、Mに関わらず出す。
     - 海域・その他(海外など): 気象庁のCMT解(Mw5.0以上)とUSGS(日本周辺でM4.5以上を収録)
       の対象になるM4.5以上のときだけ出す。
   ───────────────────────────────────────────────────── */
export const MECH_BUTTON_MIN_MAGNITUDE_NON_LAND = 4.5;

// 震央地域名("千葉県北東部"・"三陸沖"・"相模湾"など)から "land" | "sea" | "other" を返す。
//   sea  : 沖・近海・湾・灘・海・海峡・水道などを含む(「北海道」「沖縄」「台湾」の"海"・"沖"・"湾"は除外して判定)
//   land : 都府県名・北海道の地方名("日高地方東部"など)・"地方"・"内陸"を含む
//   other: 上記以外(海外の地名・震源調査中・未取得など)
export function classifyEpicenterArea(place) {
  if (!place || typeof place !== "string") return "other";
  const name = place.replace(/北海道/g, "").replace(/沖縄/g, "").replace(/台湾/g, "");
  if (/沖|近海|湾|灘|海|海峡|水道|海盆|海溝|海嶺|海域|海膨/.test(name)) return "sea";
  if (/[都府県]/.test(place) || /北海道|道央|道南|道東|道北|地方|内陸/.test(place)) return "land";
  return "other";
}

export function shouldShowMechanismButton(quake) {
  if (!quake) return false;
  if (classifyEpicenterArea(quake.place) === "land") return true;
  return quake.magnitude != null && quake.magnitude >= MECH_BUTTON_MIN_MAGNITUDE_NON_LAND;
}

const CMT_LIST_BASE = "https://www.data.jma.go.jp/eqev/data/mech/cmt/";
const CMT_FIG_BASE = "https://www.data.jma.go.jp/eqev/data/mech/cmt/fig/";

// "33度17.8分N" のような度分表記を10進の度(符号付き)に変換する。
// S(南緯)・W(西経)の場合は負の値にする。
function cmtParseDegMin(str) {
  if (!str) return null;
  const m = String(str).match(/([\d.]+)度([\d.]+)分([NSEW])/);
  if (!m) return null;
  const deg = parseFloat(m[1]) + parseFloat(m[2]) / 60;
  return (m[3] === "S" || m[3] === "W") ? -deg : deg;
}

// "2026-07-09 21:58:58.8" のような気象庁側の時刻文字列(日本時間)を、
// 比較に使えるエポックミリ秒に変換する。
function cmtParseTimeToEpochMs(str) {
  if (!str) return null;
  const m = String(str).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  // 気象庁のページはすべて日本時間(UTC+9)表記のため、UTCとして組み立ててから9時間引く。
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 3600 * 1000;
}

// アプリ内の地震オブジェクトが持つ time("YYYY/MM/DD HH:mm[:ss]"、日本時間)を
// 同じくエポックミリ秒に変換する。cmtParseTimeToEpochMsと単位を揃えるための対。
function quakeTimeToEpochMs(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).trim().match(/(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const hh = Number(m[4]), mm = Number(m[5]), ss = m[6] ? Number(m[6]) : 0;
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 3600 * 1000;
}

// 発生時刻(気象庁ページの文字列)から、詳細ページのURLに使うタイムスタンプ
// (YYYYMMDDHHMMSS)を組み立てる。
function cmtTimeToUrlStamp(str) {
  const m = String(str).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return m[1] + m[2] + m[3] + m[4] + m[5] + m[6];
}

// 月別一覧ページ(cmtYYYYMM.html)を取得し、行ごとに構造化データへ変換する。
// 同じ月内で複数回この一覧が必要になることがあるため、簡単なメモ化キャッシュを持つ。
const cmtMonthCache = new Map(); // "YYYYMM" -> Promise<rows>

function fetchCmtMonthList(yyyymm) {
  if (cmtMonthCache.has(yyyymm)) return cmtMonthCache.get(yyyymm);

  const promise = (async () => {
    const res = await fetch(`${CMT_LIST_BASE}cmt${yyyymm}.html`);
    if (!res.ok) throw new Error(`CMT一覧の取得に失敗しました(status ${res.status})`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = [...doc.querySelectorAll("table tr")];

    const out = [];
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
      // データ行は14列(発生時刻,緯度,経度,深さ,M,震央地域名,Mw,走向1,傾斜1,すべり角1,走向2,傾斜2,すべり角2,詳細)。
      // ヘッダー行(列数が違う・数値が入っていない)はここで自然に弾かれる。
      if (cells.length < 13) continue;
      const timeMs = cmtParseTimeToEpochMs(cells[0]);
      if (timeMs == null) continue;
      const lat = cmtParseDegMin(cells[1]);
      const lon = cmtParseDegMin(cells[2]);
      const depthMatch = cells[3].match(/\d+/);
      out.push({
        timeStr: cells[0],
        timeMs,
        lat, lon,
        depth: depthMatch ? parseInt(depthMatch[0], 10) : null,
        magnitude: parseFloat(cells[4]) || null,
        place: cells[5] || "",
        mw: parseFloat(cells[6]) || null,
        plane1: { strike: cells[7], dip: cells[8], rake: cells[9] },
        plane2: { strike: cells[10], dip: cells[11], rake: cells[12] },
        detailUrlStamp: cmtTimeToUrlStamp(cells[0]),
      });
    }
    return out;
  })();

  cmtMonthCache.set(yyyymm, promise);
  // 失敗した月はキャッシュに残さない(一時的なネットワーク障害等で、以後ずっと
  // 失敗扱いのままになるのを防ぐ)。
  promise.catch(() => cmtMonthCache.delete(yyyymm));
  return promise;
}

// 対象の地震(time・緯度経度)に最も近いCMT解の行を探す。
// 発生時刻が近い(±3分以内)ことを必須とし、その中で最も時刻が近いものを採用する
// (連続発生時に別の地震を誤って拾わないよう、念のため緯度経度も大きく離れて
//  いないか確認する)。
const CMT_MATCH_TOLERANCE_MS = 3 * 60 * 1000;
const CMT_MATCH_MAX_DEGREES = 2.0;

export async function findCmtMatchForQuake(quake) {
  const quakeMs = quakeTimeToEpochMs(quake.time);
  if (quakeMs == null) return null;

  const d = new Date(quakeMs);
  // 発生時刻が月初め近くの場合、CMT解の一覧側は「発生時刻」(=同じ日本時間)なので
  // 基本的には地震自身と同じ月の一覧に載っているはずだが、念のため前月分も
  // 候補に含めておく(月境界をまたぐタイミングのずれ対策)。
  const yyyymmThis = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prevMonthDate = new Date(quakeMs - 24 * 3600 * 1000);
  const yyyymmPrev = `${prevMonthDate.getUTCFullYear()}${String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthKeys = yyyymmThis === yyyymmPrev ? [yyyymmThis] : [yyyymmThis, yyyymmPrev];

  let candidates = [];
  for (const key of monthKeys) {
    try {
      const rows = await fetchCmtMonthList(key);
      candidates = candidates.concat(rows);
    } catch {
      // その月の一覧が取れなくても、もう片方の月で見つかる可能性があるので続行する。
    }
  }

  let best = null, bestDiff = Infinity;
  for (const row of candidates) {
    const diff = Math.abs(row.timeMs - quakeMs);
    if (diff > CMT_MATCH_TOLERANCE_MS) continue;
    if (quake.latitude != null && quake.longitude != null && row.lat != null && row.lon != null) {
      const dist = Math.abs(row.lat - quake.latitude) + Math.abs(row.lon - quake.longitude);
      if (dist > CMT_MATCH_MAX_DEGREES) continue;
    }
    if (diff < bestDiff) { bestDiff = diff; best = row; }
  }
  return best;
}

/* ─────────────────────────────────────────────────────
   気象庁の発震機構解 — 5系統をまとめて探す
     種別(kind)  : "cmt"(CMT解 国内) / "ini"(初動解) / "world_cmt"(CMT解 遠地地震)
     区分(grade) : "revised"(精査版) / "prelim"(速報値)
   系統: ①精査版CMT国内 ②速報値CMT国内 ③精査版初動 ④速報値初動
         ⑤精査版遠地CMT ⑥速報値遠地CMT(速報値は1つの一覧に3種別が並ぶ)
   優先順位: 種別はCMT(国内/遠地) > 初動(CMT解析は日本周辺のMw5.0以上が対象で、
   初動解より解が安定しているため)、同じ種別なら精査版 > 速報値。
   ───────────────────────────────────────────────────── */
const JMA_KIND_LABEL = { cmt: "CMT解(国内)", ini: "初動解", world_cmt: "CMT解(遠地地震)" };
const JMA_GRADE_LABEL = { revised: "精査版", prelim: "速報値" };

const PRELIM_LIST_URL = "https://www.data.jma.go.jp/eew/data/mech/top.html";
const REV_LIST_SPECS = {
  ini: { base: "https://www.data.jma.go.jp/eqev/data/mech/ini/", month: ym => `mc${ym}.html`, top: "top.html" },
  world_cmt: { base: "https://www.data.jma.go.jp/eqev/data/mech/world_cmt/", month: null, top: "top.html" },
};

// 「2026年11月09日13時52分頃」→ エポックミリ秒(日本時間)
function jaTimeToEpochMs(str) {
  const m = String(str || "").match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2})時\s*(\d{1,2})分/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m.map(Number);
  return Date.UTC(y, mo - 1, d, hh, mm, 0) - 9 * 3600 * 1000;
}
// 「北緯36.2度」「東経142.2度」→ 符号付きの度
function jaDegToNumber(str) {
  const m = String(str || "").match(/(北緯|南緯|東経|西経)\s*([\d.]+)\s*度/);
  if (!m) return null;
  const v = parseFloat(m[2]);
  return (m[1] === "南緯" || m[1] === "西経") ? -v : v;
}

// 時刻差(秒)+位置差(度×30秒相当)の小さい行を選ぶ。許容範囲外は候補にしない。
function pickBestRow(rows, quake, quakeMs, tolMs, maxDeg) {
  let best = null, bestScore = Infinity;
  for (const row of rows) {
    const diff = Math.abs(row.timeMs - quakeMs);
    if (diff > tolMs) continue;
    let dist = 0;
    if (quake.latitude != null && quake.longitude != null && row.lat != null && row.lon != null) {
      dist = Math.abs(row.lat - quake.latitude) + Math.abs(row.lon - quake.longitude);
      if (dist > maxDeg) continue;
    }
    const score = diff / 1000 + dist * 30;
    if (score < bestScore) { bestScore = score; best = row; }
  }
  return best;
}

// 一覧の取得結果は一定時間キャッシュする(失敗はキャッシュしない)。
const jmaListCache = new Map(); // key -> { at, promise }
function cachedList(key, ttlMs, loader) {
  const hit = jmaListCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = loader();
  jmaListCache.set(key, { at: Date.now(), promise });
  promise.catch(() => { if (jmaListCache.get(key)?.promise === promise) jmaListCache.delete(key); });
  return promise;
}

// 速報値の一覧(最近5日間)。1行に 初動解/CMT国内/CMT全世界 のリンクが並ぶ。
function fetchPrelimList() {
  return cachedList("prelim", 60 * 1000, async () => {
    const res = await fetch(PRELIM_LIST_URL);
    if (!res.ok) throw new Error(`速報値一覧の取得に失敗しました(status ${res.status})`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const out = [];
    for (const tr of doc.querySelectorAll("table tr")) {
      const tds = [...tr.querySelectorAll("td")];
      if (tds.length < 9) continue;
      const timeMs = jaTimeToEpochMs(tds[0].textContent);
      if (timeMs == null) continue;
      const link = idx => {
        const a = tds[idx].querySelector("a[href]");
        return a ? { url: new URL(a.getAttribute("href"), PRELIM_LIST_URL).href, label: a.textContent.trim() } : null;
      };
      out.push({
        timeMs,
        lat: jaDegToNumber(tds[1].textContent), lon: jaDegToNumber(tds[2].textContent),
        place: tds[5].textContent.trim(),
        ini: link(6), cmt: link(7), world_cmt: link(8),
      });
    }
    console.log("[jma-mech] 速報値一覧", { 行数: out.length });
    return out;
  });
}

async function findPrelimLink(quake, quakeMs, kind) {
  const rows = (await fetchPrelimList()).filter(r => r[kind]);
  // 速報値の時刻は「分」単位(頃)なので、秒の差は気にせず、位置の近さで選ぶ。
  const world = kind === "world_cmt";
  const row = pickBestRow(rows, quake, quakeMs, world ? 5 * 60 * 1000 : 3 * 60 * 1000, world ? 6.0 : 2.0);
  if (!row) return null;
  return { url: row[kind].url, reference: kind === "ini" && row[kind].label === "参考" };
}

// 精査版の一覧(初動解は月別+最新、遠地CMTは全件1ページ)。
function fetchRevList(kind, pageFile) {
  const spec = REV_LIST_SPECS[kind];
  const url = spec.base + pageFile;
  return cachedList(`rev:${kind}:${pageFile}`, 3 * 60 * 1000, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${JMA_KIND_LABEL[kind]}の一覧の取得に失敗しました(status ${res.status})`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const out = [];
    for (const tr of doc.querySelectorAll("table tr")) {
      const cells = [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
      if (cells.length < 12) continue;
      const timeMs = cmtParseTimeToEpochMs(cells[0]);
      if (timeMs == null) continue;
      const a = tr.querySelector("a[href]");
      if (!a) continue;
      out.push({
        timeMs,
        lat: cmtParseDegMin(cells[1]), lon: cmtParseDegMin(cells[2]),
        place: kind === "world_cmt" ? cells[4] : cells[5],
        detailUrl: new URL(a.getAttribute("href"), url).href,
      });
    }
    return out;
  });
}

async function findRevLink(quake, quakeMs, kind) {
  const ymOf = ms => { const x = new Date(ms); return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, "0")}`; };
  // 月境界・日本時間との差に備えて、前日分の月も候補に含める(既存CMTと同じ考え方)。
  const months = [...new Set([ymOf(quakeMs + 9 * 3600 * 1000), ymOf(quakeMs - 15 * 3600 * 1000)])];
  const spec = REV_LIST_SPECS[kind];
  const pages = kind === "world_cmt" ? [spec.top] : [...months.map(spec.month), spec.top];
  let rows = [];
  let okCount = 0, lastErr = null;
  for (const page of pages) {
    try { rows = rows.concat(await fetchRevList(kind, page)); okCount++; }
    catch (err) { lastErr = err; /* 月の一覧が無い(まだ作られていない)ことは普通にある */ }
  }
  if (okCount === 0 && lastErr) throw lastErr;
  const world = kind === "world_cmt";
  // 遠地CMTの震源は米国地質調査所の速報震源が初期値のため、気象庁の震源とずれる前提で広く許容する。
  const row = pickBestRow(rows, quake, quakeMs, world ? 5 * 60 * 1000 : 3 * 60 * 1000, world ? 6.0 : 2.0);
  return row ? { url: row.detailUrl } : null;
}

// 詳細ページ(5系統共通の構造)を取得し、震源球画像・震源・断層面解・P/T/N軸・観測点数などを取り出す。
//   - 見出し(h2)の文言で表を探す。系統によって無い表は空になる
//     (初動解の「参考」は節面が無く、初動解にはセントロイドが無い)。
export async function fetchJmaMechDetail(url, meta = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`発震機構解の詳細の取得に失敗しました(status ${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");

  function tableAfterHeading(keyword) {
    const heading = [...doc.querySelectorAll("h2")].find(h => h.textContent.includes(keyword));
    if (!heading) return null;
    let el = heading.nextElementSibling;
    while (el && el.tagName !== "TABLE") el = el.nextElementSibling;
    return el;
  }
  function rowCells(table, rowIndex) {
    if (!table) return [];
    const tr = table.querySelectorAll("tr")[rowIndex];
    if (!tr) return [];
    return [...tr.querySelectorAll("td,th")].map(c => c.textContent.trim());
  }

  // 震源: CMT=「地震発生時刻と震源位置…」、初動=「震源情報」、遠地CMT=「震源初期値」
  const hypo = rowCells(
    tableAfterHeading("地震発生時刻と震源位置") || tableAfterHeading("震源情報") || tableAfterHeading("震源初期値"), 1
  ); // [発生時刻, 緯度, 経度, 深さ, (M)]
  const centroid = rowCells(tableAfterHeading("セントロイド時刻"), 1);
  const mechTable = tableAfterHeading("発震機構解");
  const plane1Row = rowCells(mechTable, 1); // [断層面解1, 走向, 傾斜, すべり角, 方位, P軸方位, T軸方位, N軸方位]
  const plane2Row = rowCells(mechTable, 2); // [断層面解2, 走向, 傾斜, すべり角, 傾斜, P軸傾斜, T軸傾斜, N軸傾斜]
  const stationRow = rowCells(tableAfterHeading("使用観測点数"), 0); // [観測点数, N点, V.R.|スコア, N%]

  const images = [...doc.querySelectorAll("img")]
    .map(img => img.getAttribute("src"))
    .filter(Boolean)
    .map(src => new URL(src, url).href)
    .filter(src => !src.includes("jma.go.jp/jma/com/images/")); // 気象庁ロゴなど共通画像を除外
  const beachballImg = images.find(src => !/map/i.test(src)) || null;
  const surroundingMapImg = images.find(src => /map/i.test(src)) || null;

  const accuracyLabel = stationRow[2] === "スコア" ? "スコア" : "解の精度(V.R.)";
  const metrics = [];
  if (stationRow[1]) metrics.push({ label: "使用観測点数", value: stationRow[1] });
  if (stationRow[3]) metrics.push({ label: accuracyLabel, value: stationRow[3] });

  return {
    source: "jma",
    kind: meta.kind || null,
    grade: meta.grade || null,
    reference: !!meta.reference, // 初動解の「参考」(精度が低く、節面を求めていない)
    sourceLabel: meta.kind ? `${JMA_KIND_LABEL[meta.kind]}・${JMA_GRADE_LABEL[meta.grade] || ""}` : "気象庁",
    sourceUrl: url,
    hypo: {
      time: hypo[0] || null, lat: hypo[1] || null, lon: hypo[2] || null,
      depth: hypo[3] || null, magnitude: hypo[4] || null,
    },
    centroid: {
      time: centroid[0] || null, lat: centroid[1] || null, lon: centroid[2] || null,
      depth: centroid[3] || null, mw: centroid[4] || null,
    },
    plane1: { strike: plane1Row[1] || null, dip: plane1Row[2] || null, rake: plane1Row[3] || null },
    plane2: { strike: plane2Row[1] || null, dip: plane2Row[2] || null, rake: plane2Row[3] || null },
    // P軸・T軸・N軸は「方位」の行(plane1Row)と「傾斜」の行(plane2Row)にそれぞれ3つずつ入っている。
    axes: {
      p: { azimuth: plane1Row[5] || null, plunge: plane2Row[5] || null },
      t: { azimuth: plane1Row[6] || null, plunge: plane2Row[6] || null },
      n: { azimuth: plane1Row[7] || null, plunge: plane2Row[7] || null },
    },
    metrics,
    beachballImageUrl: beachballImg,
    surroundingMapImageUrl: surroundingMapImg,
  };
}

// 対象の地震について、気象庁の発震機構解(5系統)を並行して探し、優先順位が最も高い解を返す。
// 見つからなければnull。全系統の取得が失敗した場合だけ例外にする。
export async function findJmaMechanism(quake) {
  const quakeMs = quakeTimeToEpochMs(quake.time);
  if (quakeMs == null) return null;
  const area = classifyEpicenterArea(quake.place);
  // 国内の解析(CMT国内・初動)は日本周辺の地震が対象、遠地CMTは海外の地震が対象。
  // 震央地名が陸域なら遠地CMTは探さず、海外(other)なら国内系は探さない(無駄な通信を避ける)。
  const domestic = area !== "other";
  const world = area !== "land";

  const finders = [
    domestic && { kind: "cmt", grade: "revised", run: async () => {
      const m = await findCmtMatchForQuake(quake);
      return m ? { url: `${CMT_FIG_BASE}cmt${m.detailUrlStamp}.html` } : null;
    } },
    domestic && { kind: "cmt", grade: "prelim", run: () => findPrelimLink(quake, quakeMs, "cmt") },
    world && { kind: "world_cmt", grade: "revised", run: () => findRevLink(quake, quakeMs, "world_cmt") },
    world && { kind: "world_cmt", grade: "prelim", run: () => findPrelimLink(quake, quakeMs, "world_cmt") },
    domestic && { kind: "ini", grade: "revised", run: () => findRevLink(quake, quakeMs, "ini") },
    domestic && { kind: "ini", grade: "prelim", run: () => findPrelimLink(quake, quakeMs, "ini") },
  ].filter(Boolean);

  const settled = await Promise.allSettled(finders.map(f => f.run()));
  const found = [];
  let failures = 0, firstErr = null;
  settled.forEach((r, i) => {
    const tag = `${finders[i].kind}/${finders[i].grade}`;
    if (r.status === "fulfilled") {
      console.log("[jma-mech] 探索", tag, r.value ? "見つかった" : "なし");
      if (r.value) found.push({ ...finders[i], ...r.value, run: undefined });
    } else {
      failures++; firstErr = firstErr || r.reason;
      console.warn("[jma-mech] 探索失敗", tag, r.reason);
    }
  });

  // finders は優先順位順(CMT精査→CMT速報→遠地精査→遠地速報→初動精査→初動速報)。
  let detailErr = null;
  for (const c of found) {
    try {
      const d = await fetchJmaMechDetail(c.url, c);
      console.log("[jma-mech] 採用", `${c.kind}/${c.grade}`, c.url);
      return d;
    } catch (err) {
      detailErr = err;
      console.warn("[jma-mech] 詳細取得に失敗、次の候補へ", `${c.kind}/${c.grade}`, err);
    }
  }
  if (found.length > 0 && detailErr) throw detailErr;
  if (failures === finders.length && firstErr) throw firstErr;
  return null;
}

/* ─────────────────────────────────────────────────────
   USGSのモーメントテンソル解
   気象庁のCMT解は公開が遅いため、USGSのFDSN Event API(CORS対応)からも探す。
     1. 発生時刻の前後±5分・震源付近でmoment-tensorを持つイベントを検索
     2. 時刻・位置が最も近いイベントを採用(気象庁と同じ許容範囲)
     3. そのイベントの詳細(geojson)からmoment-tensorプロダクトを読み、
        気象庁のfetchCmtDetailと同じ形に正規化して返す
   ───────────────────────────────────────────────────── */
const USGS_QUERY_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query";
// 気象庁とUSGSでは震源決定の時刻・位置が数十秒・1〜2度ずれることがあるため、
// 気象庁側より少し広めに許容する。
const USGS_SEARCH_WINDOW_MS = 10 * 60 * 1000;
const USGS_MATCH_TOLERANCE_MS = 5 * 60 * 1000;
const USGS_MATCH_MAX_DEGREES = 3.0;
const USGS_BBOX_DEGREES = 5;

const usgsNum = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// エポックミリ秒 → 日本時間の"YYYY/MM/DD HH:mm:ss"。
function formatJstFromMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const usgsLat = lat => (lat == null ? null : `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}`);
const usgsLon = lon => (lon == null ? null : `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`);
const usgsDepth = km => (km == null ? null : `${Math.round(km)} km`);
const usgsDeg = v => (usgsNum(v) == null ? null : String(Math.round(usgsNum(v))));

export async function findUsgsCmtForQuake(quake) {
  const quakeMs = quakeTimeToEpochMs(quake.time);
  if (quakeMs == null) return null;

  const iso = ms => new Date(ms).toISOString().slice(0, 19);
  const params = new URLSearchParams({
    format: "geojson",
    producttype: "moment-tensor",
    orderby: "time",
    starttime: iso(quakeMs - USGS_SEARCH_WINDOW_MS),
    endtime: iso(quakeMs + USGS_SEARCH_WINDOW_MS),
  });
  if (quake.latitude != null && quake.longitude != null) {
    params.set("minlatitude", String(quake.latitude - USGS_BBOX_DEGREES));
    params.set("maxlatitude", String(quake.latitude + USGS_BBOX_DEGREES));
    params.set("minlongitude", String(quake.longitude - USGS_BBOX_DEGREES));
    params.set("maxlongitude", String(quake.longitude + USGS_BBOX_DEGREES));
  }

  // 設定の「ログ」画面で原因を追えるよう、検索条件と結果を残す。
  const queryUrl = `${USGS_QUERY_URL}?${params.toString()}`;
  console.log("[usgs-cmt] 検索開始", { quakeTime: quake.time, place: quake.place, queryUrl });
  const res = await fetch(queryUrl);
  // 該当なしは204(本文なし)で返ることがある。
  if (res.status === 204) { console.log("[usgs-cmt] 該当イベントなし(204)"); return null; }
  if (!res.ok) throw new Error(`USGSの検索に失敗しました(status ${res.status})`);
  const json = await res.json();

  console.log("[usgs-cmt] 検索結果", {
    件数: (json.features || []).length,
    候補: (json.features || []).map(f => ({
      id: f.id, 時刻差秒: Math.round(((f.properties?.time ?? NaN) - quakeMs) / 1000),
      lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0], mag: f.properties?.mag,
    })),
  });
  let best = null, bestDiff = Infinity;
  for (const f of json.features || []) {
    const diff = Math.abs((f.properties?.time ?? Infinity) - quakeMs);
    if (diff > USGS_MATCH_TOLERANCE_MS) continue;
    const [lon, lat] = f.geometry?.coordinates || [];
    if (quake.latitude != null && quake.longitude != null && lat != null && lon != null) {
      if (Math.abs(lat - quake.latitude) + Math.abs(lon - quake.longitude) > USGS_MATCH_MAX_DEGREES) continue;
    }
    if (diff < bestDiff) { bestDiff = diff; best = f; }
  }
  if (!best || !best.properties?.detail) { console.log("[usgs-cmt] 許容範囲内の一致なし"); return null; }
  console.log("[usgs-cmt] 一致", { id: best.id, detail: best.properties.detail });

  const detailRes = await fetch(best.properties.detail);
  if (!detailRes.ok) throw new Error(`USGSの詳細取得に失敗しました(status ${detailRes.status})`);
  const detailJson = await detailRes.json();
  // プロダクトは優先度順に並ぶため、先頭が採用されている解。
  const mt = detailJson.properties?.products?.["moment-tensor"]?.[0];
  if (!mt) { console.log("[usgs-cmt] moment-tensorプロダクトなし", Object.keys(detailJson.properties?.products || {})); return null; }
  const p = mt.properties || {};

  // 震源球画像(beachball)。含まれていない場合は画像なしで数値だけ表示する。
  const contents = mt.contents || {};
  const bbKey = Object.keys(contents).find(k => /beachball.*\.(png|jpe?g|gif)$/i.test(k))
    || Object.keys(contents).find(k => /beachball.*\.svg$/i.test(k));
  const foundBeachballUrl = bbKey ? contents[bbKey].url || null : null;
  // 画像が無い・読み込めない場合に備え、断層面解1から震源球を描いたものを必ず用意する。
  const drawnBeachballUrl = renderBeachballDataUrl(
    p["nodal-plane-1-strike"], p["nodal-plane-1-dip"], p["nodal-plane-1-rake"]
  );
  console.log("[usgs-cmt] 震源球", { 画像キー: bbKey, 含まれるファイル: Object.keys(contents), 描画: !!drawnBeachballUrl });

  const [evLon, evLat, evDepth] = best.geometry?.coordinates || [];
  const magText = best.properties.mag != null
    ? `${Number(best.properties.mag).toFixed(1)}${best.properties.magType ? ` (${best.properties.magType})` : ""}`
    : null;
  const derivedMs = p["derived-eventtime"] ? Date.parse(p["derived-eventtime"]) : null;
  const derivedMag = usgsNum(p["derived-magnitude"]);
  const pdc = usgsNum(p["percent-double-couple"]);
  const stations = p["num-stations-used"] ?? p["num-stations"] ?? null;

  const metrics = [];
  if (pdc != null) metrics.push({ label: "ダブルカップル成分", value: `${Math.round(pdc <= 1 ? pdc * 100 : pdc)}%` });
  if (stations != null) metrics.push({ label: "使用観測点数", value: String(stations) });
  if (p["review-status"]) metrics.push({ label: "レビュー状況", value: String(p["review-status"]) });

  return {
    source: "usgs",
    kind: "usgs",
    grade: null,
    reference: false,
    sourceLabel: "USGS モーメントテンソル解",
    sourceUrl: best.properties.url || null,
    hypo: {
      time: formatJstFromMs(best.properties.time),
      lat: usgsLat(evLat), lon: usgsLon(evLon),
      depth: usgsDepth(evDepth), magnitude: magText,
    },
    centroid: {
      time: formatJstFromMs(derivedMs),
      lat: usgsLat(usgsNum(p["derived-latitude"])), lon: usgsLon(usgsNum(p["derived-longitude"])),
      depth: usgsDepth(usgsNum(p["derived-depth"])),
      mw: derivedMag != null ? `${derivedMag.toFixed(1)}${p["derived-magnitude-type"] ? ` (${p["derived-magnitude-type"]})` : ""}` : null,
    },
    plane1: { strike: usgsDeg(p["nodal-plane-1-strike"]), dip: usgsDeg(p["nodal-plane-1-dip"]), rake: usgsDeg(p["nodal-plane-1-rake"]) },
    plane2: { strike: usgsDeg(p["nodal-plane-2-strike"]), dip: usgsDeg(p["nodal-plane-2-dip"]), rake: usgsDeg(p["nodal-plane-2-rake"]) },
    axes: {
      p: { azimuth: usgsDeg(p["p-axis-azimuth"]), plunge: usgsDeg(p["p-axis-plunge"]) },
      t: { azimuth: usgsDeg(p["t-axis-azimuth"]), plunge: usgsDeg(p["t-axis-plunge"]) },
      n: { azimuth: usgsDeg(p["n-axis-azimuth"]), plunge: usgsDeg(p["n-axis-plunge"]) },
    },
    metrics,
    beachballImageUrl: foundBeachballUrl || drawnBeachballUrl,
    beachballFallbackUrl: drawnBeachballUrl,
    surroundingMapImageUrl: null,
  };
}

/* ─────────────────────────────────────────────────────
   震源球(ビーチボール)の自前描画
   USGSのプロダクトには震源球画像が含まれない・名前が想定と違うことがあるため、
   断層面解(走向・傾斜・すべり角)から下半球等積投影の震源球を描いて、
   PNGのデータURLとして返す。
     - 各点の方位・射出角から、ダブルカップルの放射パターンの符号を求める
       (符号 = (n·r)(u·r)、n=断層面の法線、u=すべり方向、r=その方向の単位ベクトル)
     - 押し(P波初動が上向き)の領域を黒、引きの領域を白で塗る
   座標系は北(x)・東(y)・下(z)。
   ───────────────────────────────────────────────────── */
export function renderBeachballDataUrl(strikeDeg, dipDeg, rakeDeg, size = 360) {
  const strike = parseFloat(strikeDeg), dip = parseFloat(dipDeg), rake = parseFloat(rakeDeg);
  if (![strike, dip, rake].every(Number.isFinite)) return null;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const rad = d => (d * Math.PI) / 180;
  const phi = rad(strike), del = rad(dip), lam = rad(rake);
  // 走向方向 s、傾斜方向(下向き) d、上盤側の法線 n、すべり方向 u
  const s = [Math.cos(phi), Math.sin(phi), 0];
  const d = [-Math.sin(phi) * Math.cos(del), Math.cos(phi) * Math.cos(del), Math.sin(del)];
  const n = [-Math.sin(phi) * Math.sin(del), Math.cos(phi) * Math.sin(del), -Math.cos(del)];
  const u = [
    Math.cos(lam) * s[0] - Math.sin(lam) * d[0],
    Math.cos(lam) * s[1] - Math.sin(lam) * d[1],
    Math.cos(lam) * s[2] - Math.sin(lam) * d[2],
  ];

  const img = ctx.createImageData(size, size);
  const c = size / 2, R = size / 2 - 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5 - c) / R;  // 右が東
      const y = (c - (py + 0.5)) / R; // 上が北
      const rho = Math.hypot(x, y);
      const idx = (py * size + px) * 4;
      if (rho > 1) { img.data[idx + 3] = 0; continue; } // 円の外は透明
      // 等積投影: rho = √2·sin(i/2) (i = 鉛直下向きからの角度)
      const inc = 2 * Math.asin(Math.min(1, rho / Math.SQRT2));
      const az = Math.atan2(x, y); // 北から東回り
      const r = [Math.sin(inc) * Math.cos(az), Math.sin(inc) * Math.sin(az), Math.cos(inc)];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const compression = dot(n, r) * dot(u, r) > 0;
      const v = compression ? 20 : 255;
      img.data[idx] = v; img.data[idx + 1] = v; img.data[idx + 2] = v; img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#141414";
  ctx.stroke();
  return canvas.toDataURL("image/png");
}
