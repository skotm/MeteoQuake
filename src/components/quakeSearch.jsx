import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassOpaqueContext, PressableButton } from "../ui/glass.jsx";
import { loadEpicenterNamesData, loadGeoData } from "../lib/loaders.js";
import { ThemeContext, touchGlassBackdropFilter } from "../settings/prefs.js";
import { EMPTY_EQDB_LIST, EQDB_EPICENTER_NAME_OPTIONS_DEFAULT, EQDB_MAX_INT_OPTIONS, EQDB_MAX_INT_SCALE, EQDB_MIN_MAG_OPTIONS, EQDB_SORT_OPTIONS, eqdbIntensityStringToScale, eqdbIntensityThresholdScale, fetchEqdbEventCached, fetchEqdbSearch } from "../api/quakeData.js";
import { buildEqdbQuakeCard, useEqdbEpicenterPoints } from "../weather/location.jsx";
import { eqdbListItemToPreview } from "../quake/quakeCards.jsx";
import { HistoryClockIcon, ListViewIcon, SearchGlassIcon, TideGaugeIcon } from "./icons.jsx";
import { QuakeListRow } from "./tsunamiTide.jsx";

/* ─────────────────────────────────────────────────────
   EQDB FORM FIELD — 検索フォームの1項目(ラベル+入力欄)の共通ラッパー
   ───────────────────────────────────────────────────── */
// 開始日/終了日(input[type=date])・OptionPickerの見た目を統一するための共通スタイル。
// 高さを固定(34px)して、日付欄とピッカー欄で縦の揃いがずれないようにする。
// 「中高」パネル(290px固定)に検索ボタンまで収まるよう、あえて少しコンパクトにしている。
// ライト/ダークで色が変わるため、固定オブジェクトではなくtokensを受け取る関数にしている。
function eqdbInputStyle(tokens, mode) {
  return {
    width: "100%", height: 34, boxSizing: "border-box",
    background: `rgba(${tokens.ink},0.06)`, color: tokens.text,
    border: `1px solid rgba(${tokens.ink},0.16)`, borderRadius: 8,
    padding: "0 10px", fontSize: 13, outline: "none",
    colorScheme: mode === "light" ? "light" : "dark",
  };
}


function EqdbFormField({ label, full, children }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <div style={{ flex: full ? "1 1 100%" : 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 9, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, lineHeight: 1.2 }}>{label}</span>
      {children}
    </div>
  );
}


// "YYYY-MM-DD" (input[type=date]の値形式)に整形する
function eqdbDateValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}


/* ─────────────────────────────────────────────────────
   気象庁 震度データベースの実際の収録期間
   これまでは終了日の上限を「現在の2日前」という決め打ちの目安値で計算していたが、
   実際のデータベースへの反映にはこれより長いタイムラグが生じることがあり、
   その場合は「まだ収録されていない期間」を終了日に指定してしまい、検索そのものが
   エラーになっていた(地震の内容に関わらず、その時点でのタイムラグの長さ次第で
   毎回失敗する形になっていた)。
   date.json(https://www.data.jma.go.jp/eqdb/data/shindo/js/date.json)に
   実際の収録期間 { st: "1919-01-01", en: "YYYY-MM-DD" } が公開されているため、
   これを取得して実際の範囲に合わせる。取得できるまで・取得に失敗した場合は、
   従来の決め打ち値をフォールバックとして使う。
   ───────────────────────────────────────────────────── */
const EQDB_DATE_RANGE_URL = "https://www.data.jma.go.jp/eqdb/data/shindo/js/date.json";


let eqdbDateRangePromise = null;

function loadEqdbDateRange() {
  if (!eqdbDateRangePromise) {
    eqdbDateRangePromise = fetch(EQDB_DATE_RANGE_URL)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (!data || typeof data.st !== "string" || typeof data.en !== "string") {
          throw new Error("date.jsonの形式が想定と異なります");
        }
        return { st: data.st, en: data.en };
      })
      .catch(err => {
        eqdbDateRangePromise = null; // 失敗時は次回呼び出しで再取得を試みられるようにする
        throw err;
      });
  }
  return eqdbDateRangePromise;
}


// 実際の収録期間(date.json)を取得して { st, en } | null を返すフック。
// 未取得・取得失敗の間はnullを返すので、呼び出し側は従来のフォールバック値
// (EQDB_MIN_DATE / eqdbMaxEndDate())と組み合わせて使う。
function useEqdbDateRange() {
  const [range, setRange] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadEqdbDateRange()
      .then(r => { if (!cancelled) setRange(r); })
      .catch(err => { console.error("震度データベースの収録期間(date.json)の取得に失敗しました:", err); });
    return () => { cancelled = true; };
  }, []);
  return range;
}


// 開始日に指定できる最も古い日付のフォールバック値。実際の収録期間(date.json のst)が
// 取得できていればそちらを優先する(理論上は常に1919-01-01のはずだが、念のため)。
const EQDB_MIN_DATE = "1919-01-01";


// 終了日に指定できる最新日のフォールバック値(=現在の2日前という決め打ちの目安)。
// 実際の収録期間(date.jsonのen)が取得できていればそちらを優先して使うべきで、
// これはあくまで取得できるまでの・取得に失敗した場合の暫定値。
function eqdbMaxEndDate(realEn) {
  if (realEn) return realEn;
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return eqdbDateValue(d);
}


// 検索フォームの初期値。開始日=1か月前、終了日=選べる最新日(現在の2日前が目安)。
export function defaultEqdbDateRange() {
  const start = new Date();
  start.setMonth(start.getMonth() - 1);
  return { start: eqdbDateValue(start), end: eqdbMaxEndDate() };
}


// input[type=date](ネイティブのカレンダーから選ぶ方式)専用のスタイル。
// フォントサイズを16px未満にすると、iOSがフォーカス時に画面を自動的に拡大し、
// そのまま(user-scalable=noのため)手動で縮小できなくなる不具合があるため、
// 必ず16px以上にする。
const EQDB_DATE_INPUT_STYLE_EXTRA = {
  fontSize: 16,
  WebkitAppearance: "none",
  appearance: "none",
};


function eqdbDateInputStyle(tokens, mode) {
  return { ...eqdbInputStyle(tokens, mode), ...EQDB_DATE_INPUT_STYLE_EXTRA };
}


// 下向き山形アイコン(OptionPickerの右端に置く。開いている間は上下反転する)
export function ChevronDownIcon({ open }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
         stroke={`rgba(${tokens.ink},0.45)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
         style={{ flexShrink: 0, marginLeft: 6, transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none" }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}


/* ─────────────────────────────────────────────────────
   OPTION PICKER
   ネイティブの<select>や<input type="date">はiOS Safariだと背景・高さを
   自前のCSSで統一できず、他の項目と見た目が揃わなくなる(ネイティブのピル状
   UIが被さって見えてしまう)ため、代わりにこのアプリの他の設定画面と同じ
   「ボタン+SVGの山形アイコン」で選択肢を開閉する自前のドロップダウンを使う。
   ───────────────────────────────────────────────────── */
function OptionPicker({ value, options, onChange, style }) {
  const { tokens, mode } = useContext(ThemeContext);
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null); // {left, width, top?, bottom?}
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const selected = options.find(o => o.value === value);

  // ボトムシートは自身のスクロール領域でoverflowを切っているため、通常の
  // position:absoluteな子要素だと上下どちらに開いてもシートの外にはみ出た分が
  // 見切れてしまう。それを避けるため、メニュー自体はdocument.bodyへportalし、
  // position:fixedでボタンの実際の画面上の位置から浮かせて表示する
  // (=シートのoverflowに一切影響されない)。
  function computeAndOpen() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) { setOpen(true); return; }
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
    setMenuRect({
      left: rect.left, width: rect.width,
      ...(openUpward ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
    setOpen(true);
  }

  // 開いている間にシートやページがスクロールされると、固定座標がボタンと
  // ずれてしまうため、その場合はメニューを閉じる。
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      // メニュー自身(選択肢一覧)のスクロールでは閉じない。ボトムシート側など
      // 外側のスクロールでボタンとメニューの位置がずれた場合だけ閉じる。
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <PressableButton
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : computeAndOpen())}
        style={{
          ...eqdbInputStyle(tokens, mode), ...style,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: "pointer",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.label ?? value}
        </span>
        <ChevronDownIcon open={open}/>
      </PressableButton>

      {open && menuRect && createPortal(
        <>
          {/* 背面タップで閉じるための透明オーバーレイ */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9998 }}/>
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              left: menuRect.left, width: menuRect.width,
              ...(menuRect.top != null ? { top: menuRect.top } : { bottom: menuRect.bottom }),
              zIndex: 9999,
              maxHeight: 220, overflowY: "auto",
              borderRadius: 10,
              background: tokens.glassOpaqueBg,
              boxShadow: `0 10px 28px rgba(0,0,0,0.35), inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
            }}
          >
            {options.map((o, i) => (
              <PressableButton
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{
                  width: "100%", textAlign: "left", padding: "9px 12px",
                  background: o.value === value ? `rgba(${tokens.ink},0.08)` : "transparent",
                  border: "none", borderTop: i > 0 ? `0.5px solid rgba(${tokens.ink},0.08)` : "none",
                  color: tokens.text, fontSize: 13,
                }}
              >
                {o.label}
              </PressableButton>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   NEARBY QUAKES PANEL
   「この震源の近傍で発生した地震」。選択中のP2P地震情報(リアルタイム)の
   震源地名と同じ震源地名を持つ地震を、気象庁 震度データベース(eqdb)全期間から
   検索して一覧表示する。eqdbの検索APIには震央地名そのものを条件にする項目が
   無い(震央地域はコード化された階層選択のみ)ため、期間全体を対象に検索した
   上で、返ってきた各件の震源地名(name)が選択中の地震の震源地名と完全一致する
   ものだけをクライアント側で絞り込む。
   ───────────────────────────────────────────────────── */
const NEARBY_SORT_BUTTONS = [
  { key: "time", label: "日時" },
  { key: "mag", label: "M" },
  { key: "maxInt", label: "最大震度" },
  { key: "depth", label: "深さ" },
];


// 近傍地震一覧の検索結果キャッシュ(震源地名→結果一覧)。
// NearbyQuakesPanelは、近傍一覧→他の地震の詳細→近傍一覧、と行き来するたびに
// (selectedQuakeIdの変化でキーが変わるため)Reactコンポーネントとしては毎回
// 作り直される。componentのstateはその度に失われるので、再訪問時に検索し直さず
// 済むよう、コンポーネントの外(モジュールスコープ)にキャッシュを持たせる。
const nearbyQuakeSearchCache = new Map();


export function NearbyQuakesPanel({ place, stations, colorScheme, onFoundQuake, onSelectQuake, onPointsChange, onLoadingChange, epicenterCirclesEnabled }) {
  const { tokens } = useContext(ThemeContext);

  const cached = nearbyQuakeSearchCache.get(place);
  const [status, setStatus] = useState(cached ? "done" : "loading"); // loading | error | done
  const [results, setResults] = useState(cached || []);
  const [sortKey, setSortKey] = useState("maxInt");
  const [sortDesc, setSortDesc] = useState(true);
  const [loadingId, setLoadingId] = useState(null);

  // 実際の震度データベースの収録期間(date.json)。取得できるまでは
  // nullなので、fetchEqdbSearchの呼び出し側でフォールバック値と組み合わせる。
  const eqdbDateRange = useEqdbDateRange();

  // 震央分布(地図上の丸)用に、resultsの座標をバックグラウンドで少しずつ解決し、
  // 呼び出し元(BottomDock)へ伝える。まだ解決しきっていない間はonLoadingChangeで
  // 「読み込み中」も伝え、地図上にローディング表示を出せるようにする。
  // 設定でOFFの場合は、そもそも表示しないデータを無駄に取得しないよう、
  // 解決対象を空配列にしてバックグラウンド取得自体を行わない。
  const { points: epicenterPoints, loading: epicenterLoading } = useEqdbEpicenterPoints(epicenterCirclesEnabled ? results : EMPTY_EQDB_LIST);
  useEffect(() => {
    onPointsChange?.(epicenterPoints);
  }, [epicenterPoints]);
  useEffect(() => {
    onLoadingChange?.(epicenterLoading);
    return () => onLoadingChange?.(false);
  }, [epicenterLoading]);

  useEffect(() => {
    if (nearbyQuakeSearchCache.has(place)) return; // キャッシュ済みなら検索し直さない
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const startDate = eqdbDateRange?.st || EQDB_MIN_DATE;
        const endDate = eqdbMaxEndDate(eqdbDateRange?.en);
        console.log("[nearby-quake-diag] 検索開始", { place, startDate, endDate });
        const { list, errMsg, summary } = await fetchEqdbSearch({
          startDate, endDate,
          minMag: 0, maxInt: "1", sort: "S2", epi: place,
        });
        if (cancelled) return;
        console.log("[nearby-quake-diag] 検索結果", {
          place, errMsg, summary, 件数: list.length,
        });
        if (errMsg) { setStatus("error"); setResults([]); return; }
        // eqdbのepi[]は本来コード化された地域選択用の項目で、震源地名の
        // 文字列そのものを条件にする項目はAPIに無いため、念のため返ってきた
        // 結果を震源地名の完全一致でもクライアント側から絞り込んでおく
        // (epi[]が実際に地名文字列でどこまで絞り込んでくれているか不明なため、
        // 二重チェックとして残す。ここでの絞り込みで結果が0件になる場合、
        // epi[]側では絞り込めていなかった可能性が高い)。
        const filtered = list.filter(eq => eq.name === place);
        console.log("[nearby-quake-diag] 震源地名完全一致で絞り込み後", {
          place, 絞り込み前: list.length, 絞り込み後: filtered.length,
        });
        nearbyQuakeSearchCache.set(place, filtered);
        setResults(filtered);
        setStatus("done");
      } catch (e) {
        console.error("[nearby-quake-diag] 検索失敗(例外)", { place, message: e?.message, name: e?.name });
        if (!cancelled) { setStatus("error"); setResults([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [place, eqdbDateRange]);

  const sorted = useMemo(() => {
    const arr = [...results];
    const valueOf = (eq) => {
      if (sortKey === "time") return eq.id || "";
      if (sortKey === "mag") return parseFloat(eq.mag) || 0;
      if (sortKey === "depth") return parseInt((eq.dep || "").match(/\d+/)?.[0] || "0", 10);
      return eqdbIntensityStringToScale(eq.maxI || "");
    };
    arr.sort((a, b) => {
      const av = valueOf(a), bv = valueOf(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDesc ? -cmp : cmp;
    });
    return arr;
  }, [results, sortKey, sortDesc]);

  function handleSortTap(key) {
    if (sortKey === key) { setSortDesc(d => !d); return; }
    setSortKey(key);
    setSortDesc(true);
  }

  async function handlePick(eq) {
    if (loadingId) return;
    setLoadingId(eq.id);
    try {
      const [detail, geo] = await Promise.all([fetchEqdbEventCached(eq.id), loadGeoData()]);
      if (!detail) return;
      const card = buildEqdbQuakeCard(detail, eq, stations, geo?.areas);
      onFoundQuake(card);
      onSelectQuake(card.id);
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div>
      <div style={{ padding: "10px 14px 2px" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>
          この震源({place})の近傍で発生した地震
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "8px 14px 10px", flexWrap: "wrap" }}>
        {NEARBY_SORT_BUTTONS.map(b => (
          <PressableButton
            key={b.key}
            type="button"
            onClick={() => handleSortTap(b.key)}
            style={{
              padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: "none", cursor: "pointer",
              background: sortKey === b.key ? `rgba(${tokens.ink},0.18)` : `rgba(${tokens.ink},0.06)`,
              color: sortKey === b.key ? tokens.text : `rgba(${tokens.ink},0.6)`,
            }}
          >
            {b.label}{sortKey === b.key ? (sortDesc ? " ↓" : " ↑") : ""}
          </PressableButton>
        ))}
      </div>

      {status === "loading" && (
        <div style={{ padding: "18px 0", textAlign: "center", color: `rgba(${tokens.ink},0.45)`, fontSize: 12 }}>
          検索中…
        </div>
      )}
      {status === "error" && (
        <div style={{ padding: "18px 16px", textAlign: "center", color: "rgba(255,140,140,0.9)", fontSize: 12 }}>
          取得に失敗しました
        </div>
      )}
      {status === "done" && sorted.length === 0 && (
        <div style={{ padding: "18px 16px", textAlign: "center", color: `rgba(${tokens.ink},0.45)`, fontSize: 12 }}>
          同じ震源地の地震は見つかりませんでした
        </div>
      )}
      {status === "done" && sorted.map((eq, i) => (
        <QuakeListRow
          key={eq.id}
          quake={eqdbListItemToPreview(eq)}
          showDivider={i > 0}
          colorScheme={colorScheme}
          onSelect={() => handlePick(eq)}
          loading={loadingId === eq.id}
        />
      ))}
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   QUAKE SEARCH PANEL
   「検索」モードの中身。気象庁 震度データベース(eqdb)を期間・マグニチュード・
   最大震度で検索するフォーム + 結果一覧。
   結果一覧の1件をタップすると、その地震の観測点別震度(mode=event)を取得し、
   通常の地震カード(QuakeDetailCard等)と全く同じ見た目で表示できる形に変換して
   onFoundQuakeで親(App)に渡し、onSelectQuakeで選択状態にする。
   ───────────────────────────────────────────────────── */
export function QuakeSearchPanel({ stations, colorScheme, onFoundQuake, onSelectQuake, search, onChangeSearch, onSearchExecuted, scrollContainerRef, onPointsChange, onLoadingChange, epicenterCirclesEnabled }) {
  const { tokens, mode } = useContext(ThemeContext);

  // 実際の震度データベースの収録期間(date.json)。取得できるまでは
  // nullなので、従来の決め打ちのフォールバック値と組み合わせて使う。
  const eqdbDateRange = useEqdbDateRange();
  const minStartDate = eqdbDateRange?.st || EQDB_MIN_DATE;
  const maxEndDate = eqdbMaxEndDate(eqdbDateRange?.en); // 終了日に選べる最新日(収録期間の実際の終端、取得できるまでは現在の2日前が目安)。

  // 収録期間が(取得前の目安値より)実際には手前までしか無かった場合、既に
  // フォームにセットされている終了日がそれを超えていることがあるため、実際の
  // 範囲が判明した時点で一度だけ補正する(ユーザーが日付を選び直す手間を省く)。
  useEffect(() => {
    if (!eqdbDateRange) return;
    onChangeSearch(prev => {
      let next = prev;
      if (prev.endDate && prev.endDate > maxEndDate) next = { ...next, endDate: maxEndDate };
      if (next.startDate && next.startDate < minStartDate) next = { ...next, startDate: minStartDate };
      return next;
    });
  }, [eqdbDateRange]);

  const {
    startDate, endDate, minMag, maxInt, sort, epicenterName,
    status, isSearching, hasSearched, results, loadingId,
  } = search;

  // 震源地名の選択肢(プルダウン)。EEW・地震情報テスト配信の「地図をタップして
  // 震源を指定」で使っているep.json(気象庁の震央地名区域)をそのまま流用し、
  // 収録されている震央地名を重複無く並べたものを選択肢にする。
  // カタカナ表記の震源地名(海外の地名など。例:「アリューシャン列島」)は、
  // 五十音順だと国内の地名の間に混ざってしまい探しにくいため、まとめて
  // 末尾に回す(カタカナ同士は引き続き五十音順)。
  const [epicenterNameOptions, setEpicenterNameOptions] = useState(EQDB_EPICENTER_NAME_OPTIONS_DEFAULT);
  useEffect(() => {
    let cancelled = false;
    loadEpicenterNamesData()
      .then(geojson => {
        if (cancelled || !geojson?.features) return;
        const startsWithKatakana = s => /^[\u30A0-\u30FF]/.test(s);
        const names = Array.from(new Set(
          geojson.features.map(f => f.properties?.name).filter(Boolean)
        )).sort((a, b) => {
          const aKana = startsWithKatakana(a);
          const bKana = startsWithKatakana(b);
          if (aKana !== bKana) return aKana ? 1 : -1;
          return a.localeCompare(b, "ja");
        });
        setEpicenterNameOptions([
          { value: "", label: "指定なし" },
          ...names.map(n => ({ value: n, label: n })),
        ]);
      })
      .catch(err => console.error("震央地名データの読み込みに失敗しました:", err));
    return () => { cancelled = true; };
  }, []);


  // 震央分布(地図上の丸)用に、resultsの座標をバックグラウンドで少しずつ解決し、
  // 呼び出し元(BottomDock)へ伝える。まだ解決しきっていない間はonLoadingChangeで
  // 「読み込み中」も伝え、地図上にローディング表示を出せるようにする。
  // 設定でOFFの場合は、そもそも表示しないデータを無駄に取得しないよう、
  // 解決対象を空配列にしてバックグラウンド取得自体を行わない。
  const { points: epicenterPoints, loading: epicenterLoading } = useEqdbEpicenterPoints(epicenterCirclesEnabled ? results : EMPTY_EQDB_LIST);
  useEffect(() => {
    onPointsChange?.(epicenterPoints);
  }, [epicenterPoints]);
  useEffect(() => {
    onLoadingChange?.(epicenterLoading);
    return () => onLoadingChange?.(false);
  }, [epicenterLoading]);

  // 検索条件・結果一覧の状態は、選択解除で再マウントされても消えないよう
  // 親(BottomDock)側で保持している。ここでは差分だけをマージして書き戻す。
  function patch(p) {
    onChangeSearch(prev => ({ ...prev, ...p }));
  }

  // 検索を実行したら、パネルの高さは「中高」のまま、結果一覧の先頭が
  // パネル上部に来る位置までスクロールする。
  // (「戻る」で選択解除された後の再マウント時など、ユーザー操作を伴わない
  //  タイミングでは動かしたくないため、実際にhandleSearchが呼ばれた時だけ
  //  フラグを立てて、検索が完了した瞬間(isSearchingがtrue→falseになった瞬間)に発火する)
  const justSearchedRef = useRef(false);
  const resultsAnchorRef = useRef(null);
  useEffect(() => {
    if (justSearchedRef.current && !isSearching) {
      justSearchedRef.current = false;
      onSearchExecuted?.();
      // パネルの高さが変わるアニメーション(0.4s)が落ち着いてからスクロールする。
      // scrollIntoView()は「overflow:hiddenだが技術的にはスクロール可能な
      // 祖先要素」まで対象にしてしまうことがあり(例えば角丸クリップ用の
      // overflow:hidden要素)、本来スクロールさせたいスクロールコンテナ
      // (scrollContainerRef)ではなく見えない場所を動かしてしまうことがある。
      // そのため、対象となるスクロールコンテナに対して直接scrollTopを
      // 計算して設定する。
      setTimeout(() => {
        const container = scrollContainerRef?.current;
        const anchor = resultsAnchorRef.current;
        if (container && anchor) {
          const containerRect = container.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const delta = anchorRect.top - containerRect.top;
          container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
        } else {
          anchor?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 420);
    }
  }, [isSearching, onSearchExecuted]);

  async function handleSearch() {
    if (isSearching) return;
    justSearchedRef.current = true;

    // 検索前に、終了日が実際の収録期間の終端を超えていないか・開始日が終了日より後や
    // 収録期間の始端より前になっていないかを念のため補正する
    // (input[type=date]のmax/min属性で通常は防げるが、念のためここでも二重にチェックしておく)。
    let effectiveEnd = endDate > maxEndDate ? maxEndDate : endDate;
    let effectiveStart = startDate > effectiveEnd ? effectiveEnd : startDate;
    if (effectiveStart < minStartDate) effectiveStart = minStartDate;

    if (!effectiveStart || !effectiveEnd) { patch({ status: "開始日・終了日を指定してください" }); justSearchedRef.current = false; return; }

    patch({
      startDate: effectiveStart, endDate: effectiveEnd,
      isSearching: true, hasSearched: true,
      status: "気象庁 震度データベースを検索中…",
    });
    try {
      const minMagNum = parseFloat(minMag) || 0;
      const { list, errMsg, summary } = await fetchEqdbSearch({
        startDate: effectiveStart, endDate: effectiveEnd, minMag: minMagNum, maxInt, sort,
        epi: epicenterName || undefined,
      });
      if (errMsg) {
        patch({ status: `⚠ ${errMsg}`, results: [] });
        return;
      }
      const maxIntScale = EQDB_MAX_INT_SCALE[maxInt] || 10;
      const filtered = list.filter(eq => {
        const magOk = minMagNum <= 0 || parseFloat(eq.mag) >= minMagNum;
        const intOk = maxInt === "1" || eqdbIntensityThresholdScale(eq.maxI || "") >= maxIntScale;
        // epi[]はコード化された地域選択用の項目で、震源地名の文字列そのものを
        // 条件にする項目がAPIに無いため、念のためクライアント側でも震源地名の
        // 完全一致で絞り込んでおく(近傍地震検索と同じ理由・同じやり方)。
        const nameOk = !epicenterName || eq.name === epicenterName;
        return magOk && intOk && nameOk;
      });
      if (sort === "S2") {
        filtered.sort((a, b) => eqdbIntensityStringToScale(b.maxI || "") - eqdbIntensityStringToScale(a.maxI || "") || parseFloat(b.mag) - parseFloat(a.mag));
      } else if (sort === "S3") {
        filtered.sort((a, b) => parseFloat(b.mag) - parseFloat(a.mag) || eqdbIntensityStringToScale(b.maxI || "") - eqdbIntensityStringToScale(a.maxI || ""));
      }
      patch({
        results: filtered,
        status: filtered.length !== list.length
          ? `${filtered.length}件（取得${list.length}件から絞り込み）`
          : (summary || `${filtered.length}件`),
      });
    } catch (e) {
      patch({ status: `検索中にエラーが発生しました: ${e.message}`, results: [] });
    } finally {
      patch({ isSearching: false });
    }
  }

  async function handleSelect(eq) {
    if (loadingId) return;
    patch({ loadingId: eq.id, status: `「${eq.name}」の震度データを取得中…` });
    try {
      const [detail, geo] = await Promise.all([fetchEqdbEventCached(eq.id), loadGeoData()]);
      if (!detail) {
        patch({ status: "詳細データの取得に失敗しました" });
        return;
      }
      const card = buildEqdbQuakeCard(detail, eq, stations, geo?.areas);
      onFoundQuake(card);
      onSelectQuake(card.id);
    } catch (e) {
      patch({ status: `詳細データの取得に失敗しました: ${e.message}` });
    } finally {
      patch({ loadingId: null });
    }
  }

  return (
    <div>
      {/* 検索条件フォーム */}
      <div style={{ padding: "2px 14px 6px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <EqdbFormField label="開始日">
            <input type="date" value={startDate} min={minStartDate} max={endDate || maxEndDate}
              onChange={e => patch({ startDate: e.target.value < minStartDate ? minStartDate : e.target.value })} style={eqdbDateInputStyle(tokens, mode)}/>
          </EqdbFormField>
          <EqdbFormField label="終了日">
            <input type="date" value={endDate} min={startDate || minStartDate} max={maxEndDate}
              onChange={e => patch({ endDate: e.target.value > maxEndDate ? maxEndDate : e.target.value })} style={eqdbDateInputStyle(tokens, mode)}/>
          </EqdbFormField>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <EqdbFormField label="最小M">
            <OptionPicker value={minMag} options={EQDB_MIN_MAG_OPTIONS} onChange={v => patch({ minMag: v })}/>
          </EqdbFormField>
          <EqdbFormField label="最大震度">
            <OptionPicker value={maxInt} options={EQDB_MAX_INT_OPTIONS} onChange={v => patch({ maxInt: v })}/>
          </EqdbFormField>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <EqdbFormField label="並び順">
            <OptionPicker value={sort} options={EQDB_SORT_OPTIONS} onChange={v => patch({ sort: v })}/>
          </EqdbFormField>
          <EqdbFormField label="震源地名">
            <OptionPicker value={epicenterName} options={epicenterNameOptions} onChange={v => patch({ epicenterName: v })}/>
          </EqdbFormField>
        </div>

        <PressableButton
          onClick={handleSearch}
          disabled={isSearching}
          style={{
            marginTop: 1, padding: "8px 0", borderRadius: 10,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            border: "1px solid rgba(10,132,255,0.9)",
            background: "#0A84FF", color: "#ffffff",
            fontSize: 14, fontWeight: 700,
            opacity: isSearching ? 0.5 : 1,
          }}
        >
          <SearchGlassIcon size={15}/>
          <span>{isSearching ? "検索中…" : "検索"}</span>
        </PressableButton>

        {status !== "" && (
          <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, textAlign: "center" }}>
            {status}
          </div>
        )}
      </div>

      {/* 検索結果一覧 — refは「検索」実行後にここまでスクロールするための目印 */}
      <div ref={resultsAnchorRef}/>
      {!hasSearched ? (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            条件を指定して検索してください
          </span>
        </div>
      ) : results.length === 0 ? (
        !isSearching && (
          <div style={{ padding: "18px 16px", textAlign: "center" }}>
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
              該当する地震が見つかりませんでした
            </span>
          </div>
        )
      ) : (
        results.map((eq, i) => (
          <QuakeListRow
            key={eq.id}
            quake={eqdbListItemToPreview(eq)}
            showDivider={i > 0}
            colorScheme={colorScheme}
            onSelect={() => handleSelect(eq)}
            loading={loadingId === eq.id}
          />
        ))
      )}
    </div>
  );
}


/* ─────────────────────────────────────────────────────
   QUAKE LIST TOOLBAR
   地震タブの一覧最上部（ハンドル直下）に固定表示するミニバー。
   ハイライトピルの動き(指の位置に連続追従するドラッグ、離した位置の
   タブへスナップ、押している間のスケール膨張)は、ボトムドック本体の
   ナビ行(NAVタブ)と全く同じロジックを2項目版として踏襲している。
   - リストボタン: 直近の地震一覧（既存のP2P地震情報フィード）を表示
   - 検索ボタン:   気象庁 震度データベースの検索UIに切り替える
   ───────────────────────────────────────────────────── */
const QUAKE_TOOLBAR_ITEMS = [
  { id: "recent", label: "地震一覧", icon: ListViewIcon },
  { id: "search", label: "地震検索", icon: SearchGlassIcon },
];


// 津波タブ版の切り替え項目。地震タブの「一覧⇄検索」と同じ考え方で、
// 直近一覧⇄過去の津波情報を切り替える(過去分は/history APIをoffsetで
// 遡って追加取得するTsunamiHistoryのモード)。
export const TSUNAMI_TOOLBAR_ITEMS = [
  { id: "recent",    label: "津波情報",   icon: ListViewIcon },
  { id: "history",   label: "過去の津波", icon: HistoryClockIcon },
  { id: "tidegauge", label: "潮位計",     icon: TideGaugeIcon },
];


export function QuakeListToolbar({ mode, onModeChange, onHandoffToPanelDrag, items = QUAKE_TOOLBAR_ITEMS }) {
  // このコンポーネント自身のpropに"mode"(表示モード: list/search)があるため、
  // ThemeContextの方はthemeModeという別名で受け取る。
  const { tokens, mode: themeMode } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  // ナビ行と同じ %ベース連続追従方式。PAD_X はJSX側のpaddingと必ず一致させる。
  const PAD_X = 3;
  const rowRef      = useRef(null);
  const pointerId    = useRef(null);
  const moved        = useRef(false);
  const startX       = useRef(0);
  const startY       = useRef(0);
  const N     = items.length;
  const tabW  = 100 / N; // 1タブの幅[%]（内側領域基準）

  const activeIndex = items.findIndex(item => item.id === mode);
  const [highlightLeft, setHighlightLeft] = useState(activeIndex * tabW);
  const [dragging,      setDragging]      = useState(false);
  const [pressed,       setPressed]       = useState(false);
  const [previewIdx,    setPreviewIdx]    = useState(null);

  // mode が外部から変わった時（タップ以外の切替）にハイライトを追従させる
  useEffect(() => {
    if (!dragging) setHighlightLeft(activeIndex * tabW);
  }, [activeIndex, dragging, tabW]);

  function clientXToLeft(clientX) {
    const row = rowRef.current;
    if (!row) return activeIndex * tabW;
    const { left, width } = row.getBoundingClientRect();
    const innerLeft  = left + PAD_X;
    const innerWidth = width - PAD_X * 2;
    const ratio = Math.max(0, Math.min(1, (clientX - innerLeft) / innerWidth));
    return ratio * 100;
  }

  function clientXToIndex(clientX) {
    const pct = clientXToLeft(clientX);
    return Math.max(0, Math.min(N - 1, Math.round(pct / tabW - 0.5)));
  }

  function handlePointerDown(e) {
    pointerId.current = e.pointerId;
    moved.current      = false;
    startX.current     = e.clientX;
    startY.current     = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    setPressed(true);
    setHighlightLeft(idx * tabW);
  }

  function handlePointerMove(e) {
    if (pointerId.current !== e.pointerId) return;

    if (!moved.current) {
      const dx = e.clientX - startX.current;
      const dy = e.clientY - startY.current;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        moved.current = true;

        // 縦方向優位の動き = すぐ上にあるドラッグハンドルを掴もうとして
        // 指が少しずれてこのバーの上で始まってしまったケース。
        // このバーのトグル操作としては扱わず、パネル本体のリサイズドラッグへ
        // そのまま引き渡す(ハイライトは元の位置に戻して動かさない)。
        if (Math.abs(dy) > Math.abs(dx)) {
          setPressed(false);
          setPreviewIdx(null);
          setHighlightLeft(activeIndex * tabW);
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
          pointerId.current = null;
          onHandoffToPanelDrag?.(e);
          return;
        }

        setDragging(true);
      }
    }

    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    if (moved.current) {
      const raw = clientXToLeft(e.clientX) - tabW / 2;
      setHighlightLeft(Math.max(0, Math.min(100 - tabW, raw)));
    } else {
      setHighlightLeft(idx * tabW);
    }
  }

  function handlePointerUp(e) {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    const idx = clientXToIndex(e.clientX);
    setDragging(false);
    setPressed(false);
    setPreviewIdx(null);
    setHighlightLeft(idx * tabW);
    onModeChange(items[idx].id);
  }

  function handleClick(id) {
    if (moved.current) return; // ドラッグ完了後(縦方向への引き渡しを含む)の二重発火を防ぐ
    const idx = items.findIndex(item => item.id === id);
    setHighlightLeft(idx * tabW);
    onModeChange(id);
  }

  const displayIdx = dragging && previewIdx != null ? previewIdx : activeIndex;

  return (
    <div style={{ flexShrink: 0, padding: "2px 14px 8px" }}>
      <div
        ref={rowRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          position: "relative",
          display: "flex",
          height: 34,
          borderRadius: 999,
          background: `rgba(${tokens.ink},0.05)`,
          boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
          padding: PAD_X,
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {/* スライドするハイライトピル — ナビ行と同じ%ベースのleft/width計算 */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: PAD_X, bottom: PAD_X,
            left: `calc(${PAD_X}px + (100% - ${PAD_X * 2}px) * ${highlightLeft / 100})`,
            width: `calc((100% - ${PAD_X * 2}px) * ${tabW / 100})`,
            borderRadius: 999,
            background: (pressed || dragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
            boxShadow: (pressed || dragging) && !glassOpaque
              ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
              : tokens.navPillShadow,
            // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
            backdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(themeMode) : "none",
            WebkitBackdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(themeMode) : "none",
            transform: pressed ? "scale(1.16)" : "scale(1)",
            transformOrigin: "center",
            transition: dragging
              ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
              : "left 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
        {items.map(({ id, label, icon: Icon }, idx) => {
          const isActive = idx === displayIdx;
          return (
            <button
              key={id}
              onClick={() => handleClick(id)}
              aria-label={label}
              style={{
                position: "relative", zIndex: 1, flex: 1,
                display: "flex", alignItems: "center", justifyContent: "center",
                border: "none", background: "transparent", borderRadius: 999,
                cursor: "pointer",
                color: isActive ? `rgba(${tokens.ink},1)` : `rgba(${tokens.ink},0.5)`,
                transition: "color 0.15s",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <Icon size={16}/>
            </button>
          );
        })}
      </div>
    </div>
  );
}
