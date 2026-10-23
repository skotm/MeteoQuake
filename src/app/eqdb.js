import { useState, useEffect } from "react";
import { hasKnownHypocenter, maxScaleToIntensityKey } from "./quakeCards";
import { findAreaCodeByStationName, resolvePrefCityForEqdbPoint } from "./geo";


/* ─────────────────────────────────────────────────────
   気象庁 震度データベース(eqdb) 検索API
   https://www.data.jma.go.jp/eqdb/data/shindo/
   過去の地震を期間・マグニチュード・最大震度で検索する(mode=search)、
   および1件の地震の観測点別震度を取得する(mode=event)ためのAPI。
   このAPIはP2P地震情報と違い、観測点の緯度経度(lat/lon)を直接返してくるため、
   自前の観測点マスタ(stations)との突き合わせをしなくても地図に描画できる。
   ───────────────────────────────────────────────────── */
const EQDB_API_URL = "https://www.data.jma.go.jp/eqdb/data/shindo/api/";

// 検索フォーム「最大震度」欄の選択肢。値はeqdb APIのmaxIntパラメータそのもの。
export const EQDB_MAX_INT_OPTIONS = [
  { value: "1", label: "指定なし（震度1以上）" },
  { value: "2", label: "震度2以上" },
  { value: "3", label: "震度3以上" },
  { value: "4", label: "震度4以上" },
  { value: "A", label: "震度5弱以上" },
  { value: "B", label: "震度5強以上" },
  { value: "C", label: "震度6弱以上" },
  { value: "D", label: "震度6強以上" },
  { value: "7", label: "震度7" },
];
// 検索の「震度◯以上」フィルターで比較する際に使うスケール値。
// eqdbIntensityStringToScale()は表示用に、旧震度階級(弱/強の区分が無い震度5・6)を
// 現行の5弱(45)/6弱(55)とは別のスケール値(44/54)として返すが、そのままだと
// 「5弱以上」「6弱以上」で検索した際に旧震度階級の地震がヒットしなくなってしまう。
// 実際の震度は5弱〜5強(または6弱〜6強)のいずれかだったはずなので、
// 「◯弱以上」の条件は満たすとみなして45/55に読み替える。
export function eqdbIntensityThresholdScale(raw) {
  const scale = eqdbIntensityStringToScale(raw);
  if (scale === 44) return 45;
  if (scale === 54) return 55;
  return scale;
}

export const EQDB_MAX_INT_SCALE = { "1": 10, "2": 20, "3": 30, "4": 40, "A": 45, "B": 50, "C": 55, "D": 60, "7": 70 };

// 「この震源の近傍で発生した地震」ボタンを出す条件。
// P2P地震情報(リアルタイム)側の地震であれば、震度・マグニチュードに関わらず表示する。
// ただし震源がまだ判明していない段階(震度速報「震源調査中」・稀な「震源地不明」)は、
// 検索条件になる震源地名そのものが無いため、気象庁震度データベースを検索しても
// 一致するはずがない(=ボタンを出しても必ず0件になる)。そのため震源が判明してから
// (震源に関する情報 or 確定報が届いてから)だけボタンを表示するようにする。
export function shouldShowNearbyQuakeButton(quake) {
  return !!quake && !quake.isEqdb && hasKnownHypocenter(quake);
}

export const EQDB_SORT_OPTIONS = [
  { value: "S0", label: "新しい順" },
  { value: "S1", label: "古い順" },
  { value: "S2", label: "最大震度の大きい順" },
  { value: "S3", label: "地震の規模の大きい順" },
];

// 震源地名プルダウンの初期値(ep.jsonの読み込みが終わるまでの間)。
export const EQDB_EPICENTER_NAME_OPTIONS_DEFAULT = [{ value: "", label: "指定なし" }];

// 最小マグニチュードの選択肢("1.0"〜"9.9")
export const EQDB_MIN_MAG_OPTIONS = [
  { value: "0.0", label: "指定なし" },
  ...Array.from({ length: 90 }, (_, i) => {
    const v = ((i + 10) / 10).toFixed(1);
    return { value: v, label: `M${v}以上` };
  }),
];

// "震度５弱"/"５弱"/"震度７"/"5弱(推定)" のような文字列(全角数字・「震度」接頭辞・
// 前後の余分な文字の有無を問わない)を、10刻みのJMAスケール
// (10=震度1 ... 70=震度7、47=旧震度5、57=旧震度6)に変換する。
// 完全一致ではなく部分一致で判定しているのは、eqdb側が返す文字列に
// "(推定)"などの注記が付くことがあり、完全一致だと本来有効な観測点まで
// 判定漏れして震度の塗りつぶしから抜け落ちてしまうことがあったため。
export function eqdbIntensityStringToScale(raw) {
  if (!raw) return 0;
  const str = raw
    .replace(/震度/g, "")
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  if (str.includes("7")) return 70;
  // 1996年10月の震度階級改定より前は「弱」「強」の区分が無く、単に「震度6」
  // 「震度5」とだけ記録されている(旧震度階級)。これらは現在の「5弱」「6弱」とは
  // 区別して、そのまま「5」「6」として表示したいので、専用のスケール値(44/54)を
  // 割り当てる(45=5弱, 55=6弱と衝突しないようにするため)。
  if (str.includes("6")) return str.includes("強") ? 60 : str.includes("弱") ? 55 : 54;
  if (str.includes("5")) return str.includes("強") ? 50 : str.includes("弱") ? 45 : 44;
  if (str.includes("4")) return 40;
  if (str.includes("3")) return 30;
  if (str.includes("2")) return 20;
  if (str.includes("1")) return 10;
  return 0;
}

// eqdbのid(dbid)は "YYYYMMDDHHMMSS..." 形式の発生時刻エンコード文字列。
// アプリ内の他の地震カードと表示を揃えるため "YYYY/MM/DD HH:MM:SS" に変換する。
function eqdbIdToTimeDisplay(id) {
  if (!id || id.length < 14) return "";
  return `${id.slice(0,4)}/${id.slice(4,6)}/${id.slice(6,8)} ${id.slice(8,10)}:${id.slice(10,12)}:${id.slice(12,14)}`;
}

// mode=search: 期間・M・最大震度・(任意で)震央地名で地震を検索する。
// 観測点別の詳細は含まない一覧のみを返す。
// epi: 震央地名(例:"神奈川県西部")をそのまま渡すと、サーバー側でその震央地名に
// 完全一致する地震だけに絞り込んで返してくれる(実際のeqdb検索フォームの挙動と同じ)。
// 指定が無い場合は"99"(絞り込みなし)を使う。
export async function fetchEqdbSearch({ startDate, endDate, startTime = "00:00", endTime = "23:59", minMag, maxInt, sort, epi }) {
  const epiValue = epi || "99";
  const isFiltered = minMag > 0 || maxInt !== "1" || epiValue !== "99";
  const fd = new FormData();
  fd.append("mode", "search");
  fd.append("dateTimeF[]", startDate); fd.append("dateTimeF[]", startTime);
  fd.append("dateTimeT[]", endDate);   fd.append("dateTimeT[]", endTime);
  fd.append("mag[]", minMag.toFixed(1)); fd.append("mag[]", "9.9");
  fd.append("dep[]", "000"); fd.append("dep[]", "999");
  fd.append("epi[]", epiValue); fd.append("pref[]", "99"); fd.append("city[]", "99"); fd.append("station[]", "99");
  fd.append("obsInt", "1");
  fd.append("maxInt", maxInt);
  fd.append("additionalC", isFiltered ? "true" : "false");
  fd.append("Sort", sort);
  fd.append("Comp", "C0");
  fd.append("seisCount", "false");
  fd.append("observed", "false");
  fd.append("strParam", "[object Object]");

  const res = await fetch(EQDB_API_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.res) ? data.res : [];
  const strMsgs = Array.isArray(data.str) ? data.str : [];
  const errMsg = strMsgs.find(s => s.includes("ありません") || s.includes("エラー") || s.includes("見直し"));
  return { list, errMsg, summary: strMsgs[1] || "" };
}

// mode=event: 1件の地震について、観測点ごとの震度(int[], lat/lon付き)を含む詳細を取得する。
async function fetchEqdbEvent(id) {
  const fd = new FormData();
  fd.append("mode", "event");
  fd.append("id", id);
  const res = await fetch(EQDB_API_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.res && Array.isArray(data.res.hyp) && data.res.hyp.length > 0) return data.res;
  return null;
}

/* ─────────────────────────────────────────────────────
   震央分布(地図上の丸)用: 気象庁 震度データベース(eqdb)の座標プリフェッチ。
   eqdbの一覧検索(mode=search、近傍地震検索・データベース検索で使用)は
   震央の緯度経度を返さない。座標が分かるのは1件ごとの詳細(mode=event)
   だけなので、一覧が決まったらバックグラウンドで少しずつ詳細を取得し、
   震央分布に反映していく。
   取得済みの詳細はモジュールスコープのキャッシュ(id→detail)に載せておき、
   一覧をタップして選択する時にも同じデータをそのまま使い回せるようにする
   (二重に同じ地震を取得しないため)。
   ───────────────────────────────────────────────────── */
const eqdbEventDetailCache = new Map();

export async function fetchEqdbEventCached(id) {
  if (eqdbEventDetailCache.has(id)) return eqdbEventDetailCache.get(id);
  const detail = await fetchEqdbEvent(id);
  if (detail) eqdbEventDetailCache.set(id, detail);
  return detail;
}

// eqdbのmode=event詳細(+検索一覧の元データ)から、震央分布1点分の情報を作る。
// 選択(タップ)時にそのままbuildEqdbQuakeCardへ渡せるよう、元データも持たせておく。
function eqdbDetailToEpicenterPoint(detail, listItem) {
  if (!detail || !Array.isArray(detail.hyp) || !detail.hyp[0]) return null;
  const hyp = detail.hyp[0];
  const lat = parseFloat(hyp.lat), lon = parseFloat(hyp.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const scale = eqdbIntensityStringToScale(hyp.maxI || "");
  const mag = parseFloat(hyp.mag);
  const depMatch = (hyp.dep || "").match(/\d+/);
  return {
    id: `eqdb_${listItem?.id || hyp.name}`,
    latitude: lat,
    longitude: lon,
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    maxIntensityKey: scale > 0 ? maxScaleToIntensityKey(scale) : "?",
    time: eqdbIdToTimeDisplay(listItem?.id) || (listItem?.ot || ""),
    depth: depMatch ? parseInt(depMatch[0], 10) : null,
    place: hyp.name || listItem?.name || "震源地不明",
    _eqdbListItem: listItem,
    _eqdbDetail: detail,
  };
}

// 近傍地震検索・データベース検索の結果一覧(rawList、座標を持たない生のeqdb一覧項目)
// から、震央分布用の点をバックグラウンドで少しずつ解決していくフック。
// 同時に取得するのは3件までにして、APIへの負荷と表示までの速さのバランスを取る。
// キャッシュ済みの分は即座に反映され、未取得の分は取得でき次第、順次追加されていく。
// 震央分布の設定がOFFの時、useEqdbEpicenterPointsに毎回新しい[]を渡すと
// (依存配列の参照比較で)無駄にeffectが再実行されてしまうため、固定の空配列を使う。
export const EMPTY_EQDB_LIST = [];


export function useEqdbEpicenterPoints(rawList) {
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function rebuildFromCache() {
      const next = [];
      for (const item of rawList || []) {
        const detail = eqdbEventDetailCache.get(item.id);
        const point = detail ? eqdbDetailToEpicenterPoint(detail, item) : null;
        if (point) next.push(point);
      }
      if (!cancelled) setPoints(next);
    }

    rebuildFromCache(); // まずキャッシュ済みの分だけ即座に反映する

    const total = (rawList || []).length;
    if (total === 0) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);

    let nextIndex = 0;
    let completed = 0;
    async function worker() {
      while (!cancelled) {
        const i = nextIndex++;
        if (i >= total) return;
        const item = rawList[i];
        if (!eqdbEventDetailCache.has(item.id)) {
          try {
            await fetchEqdbEventCached(item.id);
          } catch (err) {
            // この1件は諦めて次へ(震央分布は「取れた分だけ表示」でよいため)
          }
          if (cancelled) return;
          rebuildFromCache();
        }
        completed++;
        if (!cancelled && completed >= total) setLoading(false);
      }
    }
    const CONCURRENCY = 3;
    for (let i = 0; i < CONCURRENCY; i++) worker();

    return () => { cancelled = true; };
  }, [rawList]);

  return { points, loading };
}

// eqdbのmode=eventレスポンスを、アプリ内の「地震カード」共通形式に変換する。
// P2P地震情報由来のカードと違い、resolvedPointsとして緯度経度・震度キーまで
// 解決済みの状態を直接持たせる。selectedQuakePoints側は、resolvedPointsが
// あればそれをそのまま使い、無ければ従来通り観測点マスタで解決する。
export function buildEqdbQuakeCard(detail, listItem, stations, areasGeoJSON) {
  const hyp = detail.hyp[0];
  const intPoints = Array.isArray(detail.int) ? detail.int : [];

  // ごく稀に、1つの地震(event)に対して震源が複数記録されていることがある
  // (例: 群発地震をまとめて1件として扱っている場合など)。detail.hypは配列な
  // ので、先頭だけでなく全件を拾って地図上にバツ印を複数表示できるようにする。
  // 代表値(震源地名・M・深さなど)は従来通り先頭(hyp = detail.hyp[0])を使う。
  const hypocenters = detail.hyp
    .map(h => ({ latitude: parseFloat(h.lat), longitude: parseFloat(h.lon) }))
    .filter(h => Number.isFinite(h.latitude) && Number.isFinite(h.longitude));

  const lat = parseFloat(hyp.lat);
  const lon = parseFloat(hyp.lon);
  const mag = parseFloat(hyp.mag);
  const depMatch = (hyp.dep || "").match(/\d+/);
  const depth = depMatch ? parseInt(depMatch[0], 10) : 0;
  const maxScale = eqdbIntensityStringToScale(hyp.maxI || "");

  const resolvedPoints = intPoints.map(pt => {
    const scale = eqdbIntensityStringToScale(pt.int || "");
    if (scale <= 0) return null;
    const pLat = parseFloat(pt.lat), pLon = parseFloat(pt.lon);
    // eqdbは観測点名(pt.name。例: "苫前町旭＊")しか返さず、都道府県名は
    // 含まれない(市区町村名から始まる)。そのため観測点マスタ(stations)と
    // 名前・緯度経度で突き合わせて、マスタ側が持つ都道府県名・市区町村名を
    // 借りてくる(通常のP2P地震情報由来の地点と同じ「都道府県ごとの階層表示」に
    // 乗せられるようにするため)。マスタに見つからなければpref/cityともnullのまま
    // (今まで通り、階層表示では「その他」等の扱いにフォールバックする)。
    const { pref, city, addr } = resolvePrefCityForEqdbPoint(stations, pt.name, pLat, pLon);
    return {
      pref,
      city,
      addr,
      intensityKey: maxScaleToIntensityKey(scale),
      latitude: Number.isFinite(pLat) ? pLat : null,
      longitude: Number.isFinite(pLon) ? pLon : null,
      areaCode: findAreaCodeByStationName(stations, pt.name, pLat, pLon, areasGeoJSON),
    };
  }).filter(Boolean);

  // 1996年10月の震度階級改定(弱/強区分の導入)より前の地震かどうか。
  // 震度7の地震であっても、旧震度階級の期間のものは内部の5・6も区分の無い
  // 「5」「6」のはずなので、凡例側で5弱/5強・6弱/6強を出さないための目印にする。
  const eventDateStr = (listItem?.id || "").slice(0, 8);
  const legacyIntensityScale = eventDateStr.length === 8 && eventDateStr < "19961001";

  return {
    id: `eqdb_${listItem?.id || hyp.name}`,
    time: eqdbIdToTimeDisplay(listItem?.id) || (listItem?.ot || ""),
    place: hyp.name || listItem?.name || "震源地不明",
    maxIntensity: maxScaleToIntensityKey(maxScale),
    legacyIntensityScale,
    isForeign: false,
    isEqdb: true, // 一覧表示で日時を「YYYY/MM/DD」形式にするための目印
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    depth: Number.isFinite(depth) ? depth : null,
    longPeriod: null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lon) ? lon : null,
    hypocenters, // 複数震源対応。地図には1件以上のバツ印として全て表示する。
    points: [],
    resolvedPoints,
    // eqdbには津波情報が含まれないため、津波の心配なし文言をデフォルトにしておく
    domesticTsunami: "None",
    freeFormComment: "気象庁 震度データベースより取得",
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
