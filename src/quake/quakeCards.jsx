import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Glass, PressableButton, useIsStandalonePwa } from "../ui/glass.jsx";
import { INTENSITY_ORDER } from "./intensityScale.jsx";
import { QUAKE_COLOR_SCHEMES, QuakeColorSchemeContext, ThemeContext, getIntensityStyleFromScheme, splitIntensityLabel, useIntensityStyle } from "../settings/prefs.js";
import { QUAKE_STAGE_LABEL, buildQuakeMessage, formatQuakeTimeShort, maxScaleToIntensityKey } from "../api/p2p.js";
import { eqdbIdToTimeDisplay, eqdbIntensityStringToScale } from "../api/quakeData.js";

/* ─────────────────────────────────────────────────────
   発震機構解(CMT解) — 「この地震の詳細」用

   気象庁の発震機構解(精査後)ページ(data.jma.go.jp/eqev/data/mech/cmt/…)は
   正式なJSON APIではなく、月別の一覧HTMLページと、地震ごとの詳細HTMLページから
   なる。fetchでの取得(CORS)自体は実機で確認済み。
   
   1. 対象地震の発生月から一覧ページ(cmtYYYYMM.html)を取得し、時刻・位置が
      近い行を探す(=CMT解が求まっている地震かどうか、どれに対応するかを判別)。
   2. 一致した行の発生時刻から、詳細ページのURL(cmtYYYYMMDDHHMMSS.html)を
      組み立てて取得し、震源球画像・モーメントテンソル・P/T/N軸などの
      詳しい情報を得る。
   ───────────────────────────────────────────────────── */

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
const cmtMonthCache = new Map();
 // "YYYYMM" -> Promise<rows>

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


async function findCmtMatchForQuake(quake) {
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


// 地震ごとの詳細ページ(cmtYYYYMMDDHHMMSS.html)を取得し、震源球画像や
// モーメントテンソル・発震機構解(P/T/N軸込み)・観測点数などを取り出す。
async function fetchCmtDetail(detailUrlStamp) {
  const url = `${CMT_FIG_BASE}cmt${detailUrlStamp}.html`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CMT詳細の取得に失敗しました(status ${res.status})`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  // ページ内には複数の<table>があり、順番は固定(見出し文言で対応するテーブルを探す)。
  // h2見出しの直後の最初のtableを、その見出しのテーブルとみなす。
  function tableAfterHeading(keyword) {
    const heading = [...doc.querySelectorAll("h2")].find(h => h.textContent.includes(keyword));
    if (!heading) return null;
    let el = heading.nextElementSibling;
    while (el && el.tagName !== "TABLE") el = el.nextElementSibling;
    return el;
  }
  function rowCells(table, rowIndex) {
    if (!table) return [];
    const trs = table.querySelectorAll("tr");
    const tr = trs[rowIndex];
    if (!tr) return [];
    return [...tr.querySelectorAll("td,th")].map(c => c.textContent.trim());
  }

  const hypoTable = tableAfterHeading("地震発生時刻と震源位置");
  const hypo = rowCells(hypoTable, 1); // [発生時刻, 緯度, 経度, 深さ, M]

  const centroidTable = tableAfterHeading("セントロイド時刻");
  const centroid = rowCells(centroidTable, 1); // [セントロイド時刻, 緯度, 経度, 深さ, Mw]

  const mechTable = tableAfterHeading("発震機構解");
  const plane1Row = rowCells(mechTable, 1); // [断層面解1, 走向, 傾斜, すべり角, 方位, P軸方位, T軸方位, N軸方位]
  const plane2Row = rowCells(mechTable, 2); // [断層面解2, 走向, 傾斜, すべり角, 傾斜, P軸傾斜, T軸傾斜, N軸傾斜]

  const stationTable = tableAfterHeading("使用観測点数");
  const stationRow = rowCells(stationTable, 0);

  // 画像(震源球・周辺のCMT解)。<img>タグで直接読み込むだけなのでCORSの影響を受けない。
  // ページ内のsrc属性は相対パス("cmt....png"など)で書かれていることがあるため、
  // 文字列にパスが含まれているかで絞り込む前に、必ずURLを絶対パスへ解決してから
  // 判定する(でないと相対パスの画像を取りこぼす)。
  const images = [...doc.querySelectorAll("img")]
    .map(img => img.getAttribute("src"))
    .filter(Boolean)
    .map(src => new URL(src, url).href)
    .filter(src => !src.includes("jma.go.jp/jma/com/images/")); // 気象庁ロゴなど共通画像を除外
  const beachballImg = images.find(src => !/map/i.test(src)) || null;
  const surroundingMapImg = images.find(src => /map/i.test(src)) || null;

  return {
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
    // P軸・T軸・N軸は「方位」の行(plane1Row)と「傾斜」の行(plane2Row)にそれぞれ
    // 3つずつ入っている(表が2行にまたがった構成のため)。
    axes: {
      p: { azimuth: plane1Row[5] || null, plunge: plane2Row[5] || null },
      t: { azimuth: plane1Row[6] || null, plunge: plane2Row[6] || null },
      n: { azimuth: plane1Row[7] || null, plunge: plane2Row[7] || null },
    },
    stationCount: stationRow[1] || null,
    varianceReduction: stationRow[3] || null,
    beachballImageUrl: beachballImg,
    surroundingMapImageUrl: surroundingMapImg,
  };
}



// 「地震カード」互換の軽量プレビュー形式に変換する(観測点別震度はまだ持たない)。
export function eqdbListItemToPreview(eq) {
  const scale = eqdbIntensityStringToScale(eq.maxI || "");
  const depMatch = (eq.dep || "").match(/\d+/);
  const mag = parseFloat(eq.mag);
  return {
    id: eq.id,
    time: eqdbIdToTimeDisplay(eq.id) || (eq.ot || ""),
    place: eq.name || "震源地不明",
    maxIntensity: scale > 0 ? maxScaleToIntensityKey(scale) : "?",
    isForeign: false,
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    depth: depMatch ? parseInt(depMatch[0], 10) : null,
    isEqdb: true, // 一覧表示で日時を「YYYY/MM/DD」形式にするための目印
  };
}


/* ─────────────────────────────────────────────────────
   AUTO FIT TEXT
   与えられたコンテナ幅に収まるよう、フォントサイズを自動的に縮小して1行で表示する。
   QuakeDetailCardの震源地名(短い地名〜長い地名まで幅が大きく変わる)向け。
   ResizeObserverでコンテナ幅の変化(画面回転・レイアウト変更)にも追従する。
   ───────────────────────────────────────────────────── */
export function AutoFitText({ text, maxFontSize, minFontSize = 13, className, style }) {
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;

    function fit() {
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return;

      // 最大サイズから1pxずつ縮めて、テキストの実測幅(scrollWidth)が
      // コンテナ幅に収まるところを探す。文字数が少なければ最大サイズのまま。
      let size = maxFontSize;
      textEl.style.fontSize = `${size}px`;
      while (size > minFontSize && textEl.scrollWidth > containerWidth) {
        size -= 1;
        textEl.style.fontSize = `${size}px`;
      }
      setFontSize(size);
    }

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(container);
    return () => ro.disconnect();
  }, [text, maxFontSize, minFontSize]);

  return (
    <div ref={containerRef} style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
      <span
        ref={textRef}
        className={className}
        style={{ ...style, fontSize, whiteSpace: "nowrap", display: "inline-block" }}
      >
        {text}
      </span>
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   PANEL DRAG HANDOFF CARD
   フローティングパネル最上部のカード(地震カード・津波カード)を掴んで縦方向に
   ドラッグした時、リスト内スクロールではなく、パネル本体の高さ調整
   (ハンドルのドラッグ)として扱うためのラッパー。QuakeListToolbarの
   onHandoffToPanelDrag(縦方向優位の動きをパネルドラッグへ引き渡す)と同じ考え方。
   カード内のボタン等のタップ操作はそのまま素通しするため、判定前は何もしない。
   ───────────────────────────────────────────────────── */
export function PanelDragHandoffCard({ onHandoffToPanelDrag, children }) {
  const pointerId = useRef(null);
  const startX    = useRef(0);
  const startY    = useRef(0);
  const decided   = useRef(false);

  function handlePointerDown(e) {
    if (pointerId.current != null) return; // 複数指の同時操作は無視
    pointerId.current = e.pointerId;
    startX.current = e.clientX;
    startY.current = e.clientY;
    decided.current = false;
    // ここでsetPointerCaptureは呼ばない。指を置いた時点で無条件にキャプチャして
    // しまうと、動かさずに離しただけの単純なタップでも(ブラウザによっては)
    // 中のボタンへclickイベントが届かなくなることがある(PCのChromium系ブラウザで
    // 確認、iOS Safariでは問題なし)。縦ドラッグと判定できた時(下のhandlePointerMove)
    // だけ、その場でキャプチャしてすぐパネルドラッグへ引き渡す。
  }
  function handlePointerMove(e) {
    if (pointerId.current !== e.pointerId || decided.current) return;
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // まだ判定するには小さすぎる(タップの可能性)
    decided.current = true;
    if (Math.abs(dy) >= Math.abs(dx)) {
      // 縦方向優位の動き = パネルの高さ調整として引き渡す(ハンドルを掴んだ時と同じ)
      pointerId.current = null;
      onHandoffToPanelDrag?.(e);
    }
    // 横方向優位の動きは、このラッパーとしては何もしない(カード内の通常操作に任せる)
  }
  function handlePointerUp(e) {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: "none" }} // QuakeListToolbarと同じ(縦横ともブラウザ標準ジェスチャーを完全に無効化し、途中でpointercancelされるのを防ぐ)
    >
      {children}
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   QUAKE DETAIL CARD
   地震リスト/地図で選択した地震の詳細を表示するカード。
   左に「最大震度」バッジ、右にM/深さ・震源地・発生時刻を積む構成。
   ───────────────────────────────────────────────────── */
export function QuakeDetailCard({ quake }) {
  const { tokens } = useContext(ThemeContext);

  const style = useIntensityStyle(quake.maxIntensity || "1");
  const { num, suffix } = splitIntensityLabel(style.label);

  return (
    <div
      style={{
        margin: "2px 14px 4px",
        borderRadius: 16,
        padding: "7px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        position: "relative",
        background: `linear-gradient(135deg, ${style.bg}2E, ${style.bg}14)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
        animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {/* 最大震度バッジ — 遠地地震は震度が観測されないため「遠地」表示にする */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`, whiteSpace: "nowrap", lineHeight: 1.1 }}>
          {quake.isForeign ? "遠地地震" : "最大震度"}
        </span>
        <div
          style={{
            width: 64, height: 64,
            borderRadius: 14,
            background: style.bg, color: style.fg,
            position: "relative",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {/* テスト配信バッジ — 津波警報テスト配信(TsunamiDetailCard)と全く同じ見た目を
              そのまま流用する。最大震度アイコンの角に乗せることで、一目でテストデータだと
              分かるようにする。 */}
          {quake.isTest && (
            <span style={{
              position: "absolute", top: -8, left: -8,
              fontSize: 9.5, fontWeight: 800, color: "#fff",
              background: "#FF453A", borderRadius: 4, padding: "2px 6px",
              whiteSpace: "nowrap",
            }}>
              テスト配信
            </span>
          )}
          {quake.isForeign ? (
            <span style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>不明</span>
          ) : quake.maxIntensity === "?" ? (
            <span style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.15, textAlign: "center" }}>調査中</span>
          ) : quake.maxIntensity === "5u" ? (
            // 震度5弱以上未入電 — 観測点の震度計は検知したが、確定した震度が
            // まだ入電されていない状態。「少なくとも5弱」を示す"5弱+"と、
            // その理由となる"未入電"を2段で表示する。
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.1 }}>
              <span className="mono" style={{ fontSize: 22, fontWeight: 800 }}>5弱+</span>
              <span style={{ fontSize: 10, fontWeight: 700, marginTop: 2 }}>未入電</span>
            </div>
          ) : suffix ? (
            <>
              {/* 弱/強付き(5弱・5強・6弱・6強) — 数字と弱/強を近づけ、正方形の中央にまとめて配置 */}
              <span className="mono" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{num}</span>
              <span style={{
                fontSize: 15, fontWeight: 700, lineHeight: 1,
                marginLeft: 2, alignSelf: "flex-end", marginBottom: 14,
              }}>{suffix}</span>
            </>
          ) : (
            // 数字のみ(1〜4,7) — 弱/強が無い分、正方形の大きさを変えずに数字だけ少し大きく
            <span className="mono" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{num}</span>
          )}
        </div>
      </div>

      {/* 震源地 / M・深さ / 発生時刻 — 中央寄せで大きめに表示する */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, lineHeight: 1.1 }}>
          {/* 発表段階バッジ。震度速報・震源に関する情報の間だけ「震源地」ラベルの
              代わりに表示し、確定報(DetailScale)が届いたら通常の「震源地」に戻る。
              ラベルの位置にそのまま差し替えるだけなので、他の行・列の並びは変わらない。 */}
          {QUAKE_STAGE_LABEL[quake.stage] ? (
            <span style={{
              flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
              background: `rgba(${tokens.ink},0.14)`, color: `rgba(${tokens.ink},0.75)`,
              whiteSpace: "nowrap", lineHeight: 1.5,
            }}>
              {QUAKE_STAGE_LABEL[quake.stage]}
            </span>
          ) : (
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>震源地</span>
          )}
          <AutoFitText
            text={quake.place}
            maxFontSize={30}
            minFontSize={13}
            style={{ fontWeight: 800, color: tokens.text, lineHeight: 1.1 }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
            M<span className="mono" style={{ fontSize: 21, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
              {quake.magnitude != null ? quake.magnitude.toFixed(1) : "-"}
            </span>
          </span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
            深さ<span className="mono" style={{ fontSize: 21, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
              {quake.depth != null ? (quake.depth === 0 ? "ごく浅い" : quake.depth) : "-"}
            </span>
            {quake.depth != null && quake.depth !== 0 && (
              <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.6)`, marginLeft: 2, lineHeight: 1.1 }}>km</span>
            )}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>発生時刻</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.1 }}>
            {formatQuakeTimeShort(quake.time)}
          </span>
        </div>
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   QUAKE MESSAGE CARD — 電文(津波情報・付加文)
   選択中の地震について、津波の心配の有無や気象庁の付加コメントを表示する。
   ───────────────────────────────────────────────────── */
export function QuakeMessageCard({ quake }) {
  const { tokens } = useContext(ThemeContext);

  const lines = buildQuakeMessage(quake);

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        borderRadius: 12,
        padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 8,
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: line.color }}>
              【{line.label}】
            </span>
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.5 }}>
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   STATION POINTS LIST — 各地の震度
   選択中の地震について、観測点ごとの震度を表示する。表示方法は設定で選べる:
     - "list"    : 震度が大きい順にフラットな一覧で表示(従来の見た目)。
                   件数が多い地震(数百観測点になることもある)を考慮し、
                   既定では上位のみ表示し「すべて表示」で展開できる。
     - "grouped" : 震度階級ごとの一覧(既定)。各行は「バッジ+震度ラベル+
                   都道府県名(まとめて表示)+ >」の要約行で、タップすると
                   その震度の地域一覧(都道府県ごとに開閉できる詳細画面)へ遷移する。
   観測点マスタに見つからず地図に表示されていない件数(unmappedCount)は、
   要約画面の最下部にまとめて表示する(詳細画面では表示しない)。
   ───────────────────────────────────────────────────── */
export function StationPointsList({ points, displayMode = "list", openKey, onOpenKeyChange }) {
  const { tokens } = useContext(ThemeContext);

  const [expanded, setExpanded] = useState(false); // 一覧表示(list)用の「すべて表示」
  // 階層表示(grouped)用: 詳細画面を開いている震度キー。
  // フローティングの外にある丸い「戻る」ボタンでもこの詳細画面を閉じられるように、
  // 親(BottomDock)側にstateを持ち上げてpropsで受け取る形にしている
  // (✕ボタン自体はこれまで通りこのコンポーネント内に残す)。
  const [openPrefs, setOpenPrefs] = useState(() => new Set()); // 詳細画面内で開いている都道府県
  const [closePressed, setClosePressed] = useState(false); // 詳細画面の✕(ガラス)ボタンの押下状態
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;

  // scale(10刻みのJMAコード)が大きい順 = 震度が大きい順
  const sorted = useMemo(() => {
    return [...points].sort((a, b) => INTENSITY_ORDER.indexOf(b.intensityKey) - INTENSITY_ORDER.indexOf(a.intensityKey));
  }, [points]);

  // 震度キーごとにグループ化する(sortedは既に震度降順なので、Mapの挿入順=震度降順のまま保たれる)
  const groups = useMemo(() => {
    const map = new Map();
    for (const p of sorted) {
      if (!map.has(p.intensityKey)) map.set(p.intensityKey, []);
      map.get(p.intensityKey).push(p);
    }
    return [...map.entries()];
  }, [sorted]);

  // 選択中の地震が変わるたび(=points自体が変わるたび)、詳細画面は閉じておく
  useEffect(() => {
    onOpenKeyChange(null);
    setOpenPrefs(new Set());
  }, [points]);

  // 詳細画面を閉じた時・別の震度キーの詳細画面へ切り替わった時は、
  // 開いていた都道府県の展開状態をリセットする。
  // openPrefsは震度キーをまたいで共有しているstateなので、これをやらないと
  // 「震度5弱の詳細で北海道を開いたまま閉じて、震度3の詳細を開いたら
  //  北海道が開きっぱなしになっている」といった意図しない引き継ぎが起きる。
  useEffect(() => {
    setOpenPrefs(new Set());
  }, [openKey]);

  if (sorted.length === 0) return null;

  // 観測点マスタに見つからず、緯度経度が引けなかった(=地図上には表示されていない)観測点の数。
  // 地図上で「無いことに気づけない」状態を防ぐため、要約画面の最下部に件数を明示しておく。
  // 震度速報(isArea:true)の点は、そもそも個別の緯度経度を持たず区域塗り分けで
  // 表示される(観測点マスタに無いのとは違う)ため、この「地図に出せない件数」には含めない。
  const unmappedCount = sorted.filter(p => !p.isArea && (p.latitude == null || p.longitude == null)).length;

  const VISIBLE_COUNT = 10;
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_COUNT);
  const hasMore = sorted.length > VISIBLE_COUNT;

  function togglePref(pref) {
    setOpenPrefs(prev => {
      const next = new Set(prev);
      if (next.has(pref)) next.delete(pref); else next.add(pref);
      return next;
    });
  }

  // 階層表示(grouped)で、ある震度キーの地域詳細画面を開いている場合はそちらを表示する
  if (displayMode === "grouped" && openKey != null) {
    const groupPoints = groups.find(([k]) => k === openKey)?.[1] || [];
    const style = getIntensityStyleFromScheme(scheme, openKey);

    // 都道府県ごと→さらに市区町村ごとにまとめ直す(出現順を維持)。
    // 同じ市区町村の地点は1つの見出しの下にまとめ、見出しの繰り返しを避ける。
    const byPref = [];
    const prefIndexOf = new Map();
    for (const p of groupPoints) {
      if (!prefIndexOf.has(p.pref)) {
        prefIndexOf.set(p.pref, byPref.length);
        byPref.push({ pref: p.pref, cities: [], cityIndexOf: new Map() });
      }
      const prefEntry = byPref[prefIndexOf.get(p.pref)];
      const cityKey = p.city || `__nocity_${p.addr}`; // 市区町村が無い観測点は地点名単位でそのまま1件ずつ扱う
      if (!prefEntry.cityIndexOf.has(cityKey)) {
        prefEntry.cityIndexOf.set(cityKey, prefEntry.cities.length);
        prefEntry.cities.push({ city: p.city, addrs: [] });
      }
      prefEntry.cities[prefEntry.cityIndexOf.get(cityKey)].addrs.push(p.addr);
    }

    return (
      <div style={{ margin: "2px 14px 8px", textAlign: "left" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", padding: "6px 2px 10px" }}>
          <div style={{ flex: 1, textAlign: "left", fontSize: 14, fontWeight: 700, color: tokens.text, paddingRight: 36 }}>
            震度{style.label}の地域
          </div>
          <div style={{ position: "absolute", right: 0 }}>
            <Glass
              radius={999}
              style={{
                width: 28, height: 28,
                transform: closePressed ? "scale(1.16)" : "scale(1)",
                transformOrigin: "center",
                transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
              }}
            >
              <button
                onClick={() => onOpenKeyChange(null)}
                onPointerDown={() => setClosePressed(true)}
                onPointerUp={() => setClosePressed(false)}
                onPointerCancel={() => setClosePressed(false)}
                onPointerLeave={() => setClosePressed(false)}
                aria-label="閉じる"
                style={{
                  width: "100%", height: "100%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "transparent", border: "none", cursor: "pointer",
                }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                     stroke={`rgba(${tokens.ink},0.75)`} strokeWidth="2.4" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18"/>
                  <line x1="18" y1="6" x2="6" y2="18"/>
                </svg>
              </button>
            </Glass>
          </div>
        </div>

        <div style={{
          borderRadius: 12,
          overflow: "hidden",
          background: `rgba(${tokens.ink},0.04)`,
          boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
        }}>
          {byPref.map((entry, pi) => {
            const isOpen = openPrefs.has(entry.pref);
            return (
              <div key={entry.pref}>
                {pi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                <PressableButton
                  onClick={() => togglePref(entry.pref)}
                  style={{
                    width: "100%", display: "block", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left", padding: 0,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px" }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: tokens.text, flex: 1 }}>
                      {entry.pref}
                    </span>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                         stroke={`rgba(${tokens.ink},0.3)`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
                         style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease", flexShrink: 0 }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                  {isOpen && (
                    <div style={{ padding: "0 12px 10px", textAlign: "left" }}>
                      {entry.cities.map((c, ci) => (
                        <div key={ci} style={{ marginTop: ci > 0 ? 6 : 0, fontSize: 14, lineHeight: 1.7, textAlign: "left" }}>
                          {c.city && (
                            <span style={{ fontWeight: 700, color: tokens.text }}>{c.city} </span>
                          )}
                          <span style={{ color: `rgba(${tokens.ink},0.88)` }}>{c.addrs.join(" ")}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </PressableButton>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        padding: "6px 2px",
        fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`,
      }}>
        各地の震度
      </div>

      <div style={{
        borderRadius: 12,
        overflow: "hidden",
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {displayMode === "grouped" ? (
          groups.map(([key, groupPoints], gi) => {
            const style = getIntensityStyleFromScheme(scheme, key);
            const prefs = [...new Set(groupPoints.map(p => p.pref))];
            return (
              <div key={key}>
                {gi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                <PressableButton
                  onClick={() => onOpenKeyChange(key)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: key === "5u" ? 9 : 11, fontWeight: 800,
                  }}>
                    {key === "5u" ? "未入電" : style.label}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>
                      震度{style.label}
                    </div>
                    <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)`, marginTop: 3, lineHeight: 1.6 }}>
                      {prefs.map((pref, pi) => (
                        <span key={pref} style={{ whiteSpace: "nowrap" }}>
                          {pref}{pi < prefs.length - 1 ? "、" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                       stroke={`rgba(${tokens.ink},0.3)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                       style={{ flexShrink: 0 }}>
                    <polyline points="9 6 15 12 9 18"/>
                  </svg>
                </PressableButton>
              </div>
            );
          })
        ) : (
          visible.map((p, i) => {
            const style = getIntensityStyleFromScheme(scheme, p.intensityKey);
            return (
              <div key={`${p.pref}-${p.addr}-${i}`}>
                {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 12 }}/>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: p.intensityKey === "5u" ? 9 : 11, fontWeight: 800,
                  }}>
                    {p.intensityKey === "5u" ? "未入電" : style.label}
                  </span>
                  <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
                    {p.pref}
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {p.addr}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {displayMode === "list" && hasMore && (
        <PressableButton
          onClick={() => setExpanded(v => !v)}
          style={{
            width: "100%", textAlign: "center", padding: "8px 0",
            fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
          }}
        >
          {expanded ? "閉じる" : `すべて表示 (${sorted.length}件)`}
        </PressableButton>
      )}

      {unmappedCount > 0 && (
        <div style={{ padding: "8px 2px 2px", fontSize: 11, fontWeight: 500, color: `rgba(${tokens.ink},0.35)` }}>
          うち{unmappedCount}件は観測点マスタに無く、地図には非表示です
        </div>
      )}
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   QUAKE MECH DETAIL PANEL — 「この地震の詳細」画面
   
   気象庁の発震機構解(CMT解)を取得して表示する。M5.0以上でないとそもそも
   解析されないため、見つからない場合はその旨を案内する(エラーではない)。
   ───────────────────────────────────────────────────── */
export function QuakeMechDetailPanel({ quake }) {
  const { tokens } = useContext(ThemeContext);
  // ホーム画面に追加したPWA(スタンドアロン表示)かどうか。
  // iOSのスタンドアロンPWAには「新しいタブ」という概念が無いため、
  // target="_blank"のリンクを踏むとOSがSafari側にまるごと処理を渡してしまい、
  // 「戻る」で復帰した時にPWA側のWebViewがメモリから破棄されていて
  // アプリ全体がリロードされてしまうことがある(=開いていた画面が消える不具合)。
  // スタンドアロン時だけtarget="_blank"を外し、同じWebView内で遷移させることで、
  // これを避ける。
  const isStandalonePwa = useIsStandalonePwa();
  // "loading" | "found" | "not_found" | "error"
  const [status, setStatus] = useState("loading");
  const [detail, setDetail] = useState(null);
  const [matchedRow, setMatchedRow] = useState(null);
  // 震源球画像のURLが取れても、実際には読み込みに失敗する(ページ構成の想定違いで
  // 誤ったURLを組み立ててしまった等)ことがあるため、<img>のonErrorで検知して
  // 壊れた画像アイコンの代わりに案内文を出す。
  const [imgLoadFailed, setImgLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setDetail(null);
    setMatchedRow(null);
    setImgLoadFailed(false);

    (async () => {
      try {
        const match = await findCmtMatchForQuake(quake);
        if (cancelled) return;
        if (!match) { setStatus("not_found"); return; }
        setMatchedRow(match);
        const d = await fetchCmtDetail(match.detailUrlStamp);
        if (cancelled) return;
        setDetail(d);
        setStatus("found");
      } catch (err) {
        console.error("発震機構解の取得に失敗:", err);
        if (!cancelled) setStatus("error");
      }
    })();

    return () => { cancelled = true; };
  }, [quake.id]);

  const rowLabelStyle = { fontSize: 11, color: tokens.textSecondary };
  const rowValueStyle = { fontSize: 13, fontWeight: 700, color: tokens.text };

  function DataRow({ label, value }) {
    if (value == null || value === "") return null;
    return (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0" }}>
        <span style={rowLabelStyle}>{label}</span>
        <span style={rowValueStyle}>{value}</span>
      </div>
    );
  }

  // 深さ・M(またはMw)のように、単独の行だと空きスペースが目立つ2項目を
  // 1行に横並びで表示する(左右それぞれで見出し/値のペア)。
  // 片方だけ値が無い場合は、そちら側だけ非表示にする。
  function DataRowPair({ left, right }) {
    const leftHas = left.value != null && left.value !== "";
    const rightHas = right.value != null && right.value !== "";
    if (!leftHas && !rightHas) return null;
    return (
      <div style={{ display: "flex", gap: 10, padding: "6px 0" }}>
        {leftHas && (
          <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...rowLabelStyle, flexShrink: 0 }}>{left.label}</span>
            <span style={{ ...rowValueStyle, flex: 1, textAlign: "center" }}>{left.value}</span>
          </div>
        )}
        {rightHas && (
          <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...rowLabelStyle, flexShrink: 0 }}>{right.label}</span>
            <span style={{ ...rowValueStyle, flex: 1, textAlign: "center" }}>{right.value}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <QuakeDetailCard quake={quake}/>
      <div style={{ padding: "2px 14px 16px" }}>
      {status === "loading" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary }}>気象庁のデータを確認しています…</div>
        </Glass>
      )}

      {status === "not_found" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary, lineHeight: 1.6 }}>
            この地震の発震機構解は見つかりませんでした。<br/>
            まだ解析中か、解析対象外の可能性があります。
          </div>
        </Glass>
      )}

      {status === "error" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "rgba(255,140,140,0.9)", lineHeight: 1.6 }}>
            気象庁のデータ取得に失敗しました。時間をおいて再度お試しください。
          </div>
        </Glass>
      )}

      {status === "found" && detail && (
        <>
          {/* 使用観測点数・精度(左)と震源球の図(右)を横並びにする。
              左側は中身の幅だけ確保し(space-betweenで間延びさせない)、
              余った分は震源球の画像を大きく見せる方に回す。
              「震源球(下半球等積投影)」のキャプションは画像の下ではなく、
              左側の解の精度の下に矢印つきで置くことで、画像により幅を割ける。 */}
          <Glass radius={14} style={{ padding: 16, marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, minWidth: 0 }}>
              <div style={{ flexShrink: 1, minWidth: 0 }}>
                <DataRow label="使用観測点数" value={detail.stationCount} />
                <DataRow label="解の精度(V.R.)" value={detail.varianceReduction} />
                {detail.beachballImageUrl && !imgLoadFailed && (
                  <div style={{ fontSize: 10, color: tokens.textSecondary, marginTop: 6 }}>
                    震源球(下半球等積投影)→
                  </div>
                )}
              </div>
              {detail.beachballImageUrl && (
                <div style={{ flex: "0 1 150px", minWidth: 0, maxWidth: 150, textAlign: "center" }}>
                  {!imgLoadFailed ? (
                    <img
                      src={detail.beachballImageUrl}
                      alt="震源球(発震機構解)"
                      style={{ display: "block", width: "100%", maxWidth: "100%", height: "auto", borderRadius: 8, background: "#fff" }}
                      onError={() => setImgLoadFailed(true)}
                    />
                  ) : (
                    <div style={{ fontSize: 10, color: tokens.textSecondary, lineHeight: 1.5 }}>
                      画像を読み込めませんでした
                    </div>
                  )}
                </div>
              )}
            </div>
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <DataRow label="発生時刻" value={detail.hypo.time} />
            <DataRow label="震源位置" value={detail.hypo.lat && detail.hypo.lon ? `${detail.hypo.lat} ${detail.hypo.lon}` : null} />
            <DataRowPair
              left={{ label: "深さ", value: detail.hypo.depth }}
              right={{ label: "M", value: detail.hypo.magnitude }}
            />
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
              セントロイド・モーメントマグニチュード
            </div>
            <DataRow label="セントロイド時刻" value={detail.centroid.time} />
            <DataRow label="位置" value={detail.centroid.lat && detail.centroid.lon ? `${detail.centroid.lat} ${detail.centroid.lon}` : null} />
            <DataRowPair
              left={{ label: "深さ", value: detail.centroid.depth }}
              right={{ label: "Mw", value: detail.centroid.mw }}
            />
          </Glass>

          {/* 断層面解1・2は片方ずつだと余白が目立つため、真ん中に区切り線を入れて
              横に2つ並べる。 */}
          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
                  断層面解1
                </div>
                <DataRow label="走向" value={detail.plane1.strike} />
                <DataRow label="傾斜" value={detail.plane1.dip} />
                <DataRow label="すべり角" value={detail.plane1.rake} />
              </div>
              <div style={{ width: 1, alignSelf: "stretch", background: tokens.divider, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
                  断層面解2
                </div>
                <DataRow label="走向" value={detail.plane2.strike} />
                <DataRow label="傾斜" value={detail.plane2.dip} />
                <DataRow label="すべり角" value={detail.plane2.rake} />
              </div>
            </div>
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
              P軸・T軸・N軸(方位 / 傾斜)
            </div>
            <DataRow label="P軸" value={detail.axes.p.azimuth && detail.axes.p.plunge ? `${detail.axes.p.azimuth}° / ${detail.axes.p.plunge}°` : null} />
            <DataRow label="T軸" value={detail.axes.t.azimuth && detail.axes.t.plunge ? `${detail.axes.t.azimuth}° / ${detail.axes.t.plunge}°` : null} />
            <DataRow label="N軸" value={detail.axes.n.azimuth && detail.axes.n.plunge ? `${detail.axes.n.azimuth}° / ${detail.axes.n.plunge}°` : null} />
          </Glass>

          <a
            href={detail.sourceUrl}
            {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            style={{
              display: "block", textAlign: "center", padding: "10px 0",
              fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
              textDecoration: "none",
            }}
          >
            気象庁の該当ページを開く ↗
          </a>
        </>
      )}

      {/* CMT解についての注意書きは最下部に置く */}
      <Glass radius={14} style={{ padding: "14px 16px", marginTop: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: tokens.text, marginBottom: 2 }}>
          発震機構解(CMT解)
        </div>
        <div style={{ fontSize: 11, color: tokens.textSecondary, lineHeight: 1.5 }}>
          気象庁の解析結果です。マグニチュード5.0程度以上の地震のみ解析されるため、
          対象の地震でも掲載されていない場合があります。
        </div>
      </Glass>
      </div>
    </>
  );
}
