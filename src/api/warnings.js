import { cachedFetchJSON } from "../lib/loaders.js";
import { fastDist2, polygonRoughCentroid } from "./quakeData.js";

/* ─────────────────────────────────────────────────────
   市区町村境界データ(map/warning_areas.json、気象庁の警報等発表区域と同じ単位の
   市区町村ポリゴン、1,821件)。次の2つの用途に使う。
     1. 現在地(緯度経度)から、その地点を含む市区町村を逆引きして表示名を出す
        (点がポリゴンの内側にあるかのレイキャスティング判定)。
     2. 地点登録の五十音順選択(あかさたなはまやらわ→あいうえお→一覧)用の
        市区町村名・読みの一覧を作る。
   ───────────────────────────────────────────────────── */
const WARNING_AREAS_URL = `${import.meta.env.BASE_URL}map/warning_areas.json`;


// warning_areas.jsonの生データを1回だけfetch+JSON.parseして使い回すための共有
// キャッシュ。以前はloadWarningAreas()(逆引き・五十音ピッカー用)と
// loadWarningAreasFullGeoJson()(地図の塗り分け用)がそれぞれ個別に
// cachedFetchJSON(同じURL)を呼んでいたため、警報タブを開いた瞬間に同じ
// 大きめのファイルを2回fetch+parseしてしまい、体感の重さの一因になっていた。
let warningAreasRawPromise = null;

function loadWarningAreasRaw() {
  if (!warningAreasRawPromise) {
    warningAreasRawPromise = cachedFetchJSON(WARNING_AREAS_URL);
  }
  return warningAreasRawPromise;
}


function computeGeoJsonBBox(geometry) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    } else {
      for (const c of coords) visit(c);
    }
  };
  visit(geometry.coordinates);
  return [minLon, minLat, maxLon, maxLat];
}


// 標準的なレイキャスティング(交差数)判定による点-in-リング判定。
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(lon, lat, rings) {
  if (!rings || rings.length === 0 || !pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false; // 穴(内側のリング)の中は除外
  }
  return true;
}

function pointInGeoJsonGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygonRings(lon, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || []).some(rings => pointInPolygonRings(lon, lat, rings));
  }
  return false;
}


let warningAreasPromise = null;

function loadWarningAreas() {
  if (!warningAreasPromise) {
    warningAreasPromise = loadWarningAreasRaw().then(data =>
      (data.features || []).map(f => ({
        properties: f.properties,
        geometry: f.geometry,
        bbox: computeGeoJsonBBox(f.geometry),
      }))
    );
  }
  return warningAreasPromise;
}


// 地点登録の五十音ピッカー用に、市区町村名・読み・代表座標(ポリゴン頂点の
// 単純平均)だけの軽量な一覧を作る(ジオメトリ自体は逆引き判定にしか使わないため
// 持ち回らない)。1,821件全部のcentroidを毎回計算するので、五十音ピッカーを
// 開いた時など「本当に全件必要な場面」でだけ呼ぶこと。警報タブの一覧・詳細表示
// のように「発表中の数件だけ座標が要る」場面ではloadWarningAreaNameIndex()の方を使う。
export async function loadWarningAreaMunicipalities() {
  const features = await loadWarningAreas();
  return features.map(f => {
    const centroid = polygonRoughCentroid(f.geometry);
    return {
      regioncode: f.properties.regioncode,
      name: f.properties.name,
      regionname: f.properties.regionname,
      namekana: f.properties.namekana || "",
      lat: centroid?.lat ?? null,
      lon: centroid?.lon ?? null,
    };
  }).filter(m => m.lat != null && m.lon != null);
}


// 警報タブ用の軽量インデックス: regioncode → {name, geometry}。
// loadWarningAreaMunicipalities()と違い、ここでは1,821件分のcentroidを
// 前もって計算しない(名前とジオメトリの受け渡しだけなのでO(1,821)の軽い
// オブジェクト構築のみ)。実際に発表中のエリアの代表座標は、呼び出し側
// (App本体)で発表中の数件分だけpolygonRoughCentroid()を遅延計算する。
export async function loadWarningAreaNameIndex() {
  const features = await loadWarningAreas();
  const index = {};
  for (const f of features) {
    // regionnameは「東京都千代田区」のように都道府県名を前方に含む表記のため、
    // 警報タブの一覧で都道府県ごとの小見出しを作る際にderivePrefFromEewAreaName()
    // へそのまま渡せる(EEWの細分区域名と同じ判定ロジックを使い回せる)。
    index[f.properties.regioncode] = { name: f.properties.name, regionname: f.properties.regionname, geometry: f.geometry };
  }
  return index;
}


// 緯度経度からその地点を含む市区町村を逆引きする。まずbboxで簡易に絞り込んでから
// レイキャスティング判定を行う(1,821件全部に対してリング判定するのは無駄なため)。
export async function findMunicipalityAtPoint(lat, lon) {
  const features = await loadWarningAreas();
  for (const f of features) {
    const [minLon, minLat, maxLon, maxLat] = f.bbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    if (pointInGeoJsonGeometry(lon, lat, f.geometry)) return f.properties;
  }
  return null;
}


/* ─────────────────────────────────────────────────────
   警報タブ: 気象警報・注意報レイヤー
   気象庁の警報・注意報API(bosai/warning/data/r8/{都道府県コード}.json、全国)と
   洪水警報API(bosai/warning/data/l_flood/{都道府県コード}.json)を取得し、
   市区町村コード(regioncode。warning_areas.jsonのproperties.regioncodeと同じ単位)
   ごとに発表中の警報・注意報種別をまとめる。
   地図側は既存のwarning-areas境界(WARNING_AREAS_URL)をそのまま塗り分けに使う
   (逆引き用のloadWarningAreas()とは別に、フルGeoJSONをそのままsetDataできる
    形でも読み込む → loadWarningAreasGeoJson()参照)。
   ───────────────────────────────────────────────────── */

// 気象庁 offices コード(warning_areas.jsonのregioncodeとは別の、都道府県予報区単位のコード)
const WARNING_OFFICE_CODES = [
  "011000", "012000", "013000", "014030", "014100", "015000", "016000", "017000", // 北海道
  "020000", "030000", "040000", "050000", "060000", "070000",                     // 東北
  "080000", "090000", "100000", "110000", "120000", "130000", "140000", "190000", "200000", // 関東甲信
  "210000", "220000", "230000", "240000",                                          // 東海
  "150000", "160000", "170000", "180000",                                          // 北陸
  "250000", "260000", "270000", "280000", "290000", "300000",                     // 近畿
  "310000", "320000", "330000", "340000", "350000",                               // 中国
  "360000", "370000", "380000", "390000",                                         // 四国
  "400000", "410000", "420000", "430000", "440000",                               // 九州北部
  "450000", "460040", "460100",                                                    // 九州南部・奄美
  "471000", "472000", "473000", "474000",                                         // 沖縄
];


// 新API(r8)の警報種別コード(2桁文字列) → {name, level}
// level: "chui"(注意報) < "keiho"(警報) < "kiken"(危険警報) < "tokubetsu"(特別警報)
const WARNING_KIND_MAP = {
  // 注意報
  "10": { name: "大雨注意報",     level: "chui" },
  "12": { name: "大雪注意報",     level: "chui" },
  "13": { name: "風雪注意報",     level: "chui" },
  "14": { name: "雷注意報",       level: "chui" },
  "15": { name: "強風注意報",     level: "chui" },
  "16": { name: "波浪注意報",     level: "chui" },
  "17": { name: "融雪注意報",     level: "chui" },
  "18": { name: "洪水注意報",     level: "chui" },
  "19": { name: "高潮注意報",     level: "chui" },
  "20": { name: "濃霧注意報",     level: "chui" },
  "21": { name: "乾燥注意報",     level: "chui" },
  "22": { name: "なだれ注意報",   level: "chui" },
  "23": { name: "低温注意報",     level: "chui" },
  "24": { name: "霜注意報",       level: "chui" },
  "25": { name: "着氷注意報",     level: "chui" },
  "26": { name: "着雪注意報",     level: "chui" },
  "27": { name: "その他の注意報", level: "chui" },
  "29": { name: "土砂災害注意報", level: "chui" },
  // 警報
  "02": { name: "暴風雪警報",     level: "keiho" },
  "03": { name: "大雨警報",       level: "keiho" },
  "04": { name: "洪水警報",       level: "keiho" },
  "05": { name: "暴風警報",       level: "keiho" },
  "06": { name: "大雪警報",       level: "keiho" },
  "07": { name: "波浪警報",       level: "keiho" },
  "08": { name: "高潮警報",       level: "keiho" },
  "09": { name: "土砂災害警報",   level: "keiho" },
  // 危険警報(2026年5月新設)
  "43": { name: "大雨危険警報",     level: "kiken" },
  "48": { name: "高潮危険警報",     level: "kiken" },
  "49": { name: "土砂災害危険警報", level: "kiken" },
  // 特別警報
  "32": { name: "暴風雪特別警報",   level: "tokubetsu" },
  "33": { name: "大雨特別警報",     level: "tokubetsu" },
  "35": { name: "暴風特別警報",     level: "tokubetsu" },
  "36": { name: "大雪特別警報",     level: "tokubetsu" },
  "37": { name: "波浪特別警報",     level: "tokubetsu" },
  "38": { name: "高潮特別警報",     level: "tokubetsu" },
  "39": { name: "土砂災害特別警報", level: "tokubetsu" },
};

// 洪水警報API(l_flood)のcode → 対応するWARNING_KIND_MAPのキー
export const WARNING_LEVEL_PRIORITY = { chui: 1, keiho: 2, kiken: 3, tokubetsu: 4 };

export const WARNING_LEVEL_LABEL = { chui: "注意報", keiho: "警報", kiken: "危険警報", tokubetsu: "特別警報" };

export const WARNING_LEVEL_COLOR = {
  tokubetsu: "#1A1A1A",
  kiken:     "#AA00AA",
  keiho:     "#FF2800",
  chui:      "#FFEF00",
};


// regioncode(市区町村コード) → { level, kinds:[{code,name,level}] } のマージ処理。
// 複数ソース(警報・注意報API/河川氾濫API)から同じ地域に複数種別が来る前提でマージする。
// kind自体({code,name,level})を直接渡す形にしている(氾濫系はWARNING_KIND_MAPに
// 無い動的な名称になるため、コード引きではなく呼び出し側で組み立てる)。
function mergeWarningKind(map, regioncode, kind) {
  if (!kind || !regioncode) return;
  const existing = map[regioncode];
  const kinds = existing ? [...existing.kinds] : [];
  if (!kinds.some(k => k.code === kind.code && k.name === kind.name)) {
    kinds.push(kind);
  }
  const topLevel = kinds.reduce(
    (best, k) => (WARNING_LEVEL_PRIORITY[k.level] > WARNING_LEVEL_PRIORITY[best] ? k.level : best),
    kinds[0].level
  );
  map[regioncode] = { level: topLevel, kinds };
}


// 気象警報・注意報(暴風/大雨/波浪/雷/土砂災害/危険警報/特別警報 等)を取得し、
// regioncode(7桁市区町村コード)単位でmapにマージする。
// 使用するのは新形式(令和8年5月29日運用開始)の r8 エンドポイント。
// 注意: 似た名前の別エンドポイント(data/warning/{code}.json)は「警戒レベル相当情報
// 4要素(大雨・土砂災害・河川氾濫・高潮)」専用かつ更新が反映されないことがあり、
// これを使うと警報級以上が全く出てこない不具合になる(実際に発生した問題)。
// 必ずこちらのr8エンドポイントを使うこと。
// レスポンスは配列で、各要素の entry.warning.class20Items[] に
// { areaCode(7桁regioncode), kinds:[{code, status}] } が入っている。
async function fetchWarningLevelMap(map) {
  const results = await Promise.allSettled(
    WARNING_OFFICE_CODES.map(code =>
      fetch(`https://www.jma.go.jp/bosai/warning/data/r8/${code}.json`, { cache: "no-store" })
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    )
  );
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.warn(`[警報] ${WARNING_OFFICE_CODES[i]} の取得に失敗しました:`, r.reason);
      return;
    }
    const dataArr = Array.isArray(r.value) ? r.value : [r.value];
    dataArr.forEach(entry => {
      const items = entry?.warning?.class20Items ?? [];
      items.forEach(item => {
        const regioncode = String(item.areaCode ?? "").trim();
        if (!regioncode) return;
        (item.kinds ?? []).forEach(k => {
          const s = String(k.status ?? "").trim();
          if (s === "" || s === "解除") return;
          // コードは数値の場合もあるので2桁ゼロ埋め文字列に正規化
          const codeStr = String(k.code ?? "").trim().padStart(2, "0");
          const def = WARNING_KIND_MAP[codeStr];
          if (!def) return;
          mergeWarningKind(map, regioncode, { code: codeStr, name: def.name, level: def.level });
        });
      });
    });
  });
}


// 氾濫系警報コード(気象庁 flood_xml.json の item.code)→ {name, level} に変換する。
// 十の位でレベルが決まる: 1x=解除 / 2x=氾濫注意報 / 3x=氾濫警報 / 4x=氾濫危険警報 / 5x=氾濫特別警報
// (指定河川洪水予報。令和8年5月の改定で「洪水注意報・警報」自体は廃止され、
//  指定河川はこちらの氾濫情報、それ以外の河川は大雨警報の枠組みに統合された)。
function getFloodWarningKind(codeStr) {
  const n = parseInt(codeStr, 10);
  if (n >= 20 && n < 30) return { code: `flood-${n}`, name: "氾濫注意報",   level: "chui" };
  if (n >= 30 && n < 40) return { code: `flood-${n}`, name: "氾濫警報",     level: "keiho" };
  if (n >= 40 && n < 50) return { code: `flood-${n}`, name: "氾濫危険警報", level: "kiken" };
  if (n >= 50)           return { code: `flood-${n}`, name: "氾濫特別警報", level: "tokubetsu" };
  return null; // 1x = 解除, その他 = 不明 → スキップ
}


// 指定河川の氾濫警報等(氾濫危険警報など)を取得し、regioncode単位でmapにマージする。
async function fetchFloodWarningLevelMap(map) {
  try {
    const res = await fetch("https://www.jma.go.jp/bosai/flood/data/r8/flood_xml.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return;
    data.forEach(entry => {
      const kind = getFloodWarningKind(String(entry?.item?.code ?? "").trim());
      if (!kind) return; // 解除または不明コードはスキップ
      // class20Codesは7桁の市区町村コードで、warningLevelMapのregioncodeと同じ単位
      (entry?.class20Codes ?? []).forEach(rc => {
        const regioncode = String(rc).trim();
        if (regioncode) mergeWarningKind(map, regioncode, kind);
      });
    });
  } catch (err) {
    console.warn("[河川氾濫警報] flood_xml.jsonの取得に失敗しました:", err);
  }
}


// 気象警報・注意報+河川氾濫警報の両方を取得し、regioncode(市区町村コード)単位の
// マップにまとめる。ライブデータのため cachedFetchJSON(Cache API長期保存)は使わず、
// no-storeの素のfetchにする(warning_areas.json等の静的境界データとは性質が違う)。
export async function fetchWarningLevelMap_combined() {
  const map = {};
  await Promise.all([fetchWarningLevelMap(map), fetchFloodWarningLevelMap(map)]);
  console.log(`[警報] warningLevelMap件数: ${Object.keys(map).length}`);
  return map;
}


// 境界データ(public/map/warning_areas.json)をそのままGeoJSONとして読み込む。
// loadWarningAreas()(逆引き・五十音ピッカー用の軽量版)とは処理内容は別だが、
// 生データの取得自体はloadWarningAreasRaw()を共有しているので、どちらが先に
// 呼ばれても実際のfetch+JSON.parseは1回で済む。
let warningAreasFullGeoJsonPromise = null;

export function loadWarningAreasFullGeoJson() {
  if (!warningAreasFullGeoJsonPromise) {
    warningAreasFullGeoJsonPromise = loadWarningAreasRaw();
  }
  return warningAreasFullGeoJsonPromise;
}


// warningLevelMapを使って、warning-areasの各featureにwarnLevelプロパティを
// 埋め込んだGeoJSONを作る(mapのpaintはこのプロパティをmatch式で参照する)。
export function buildWarningAreasGeoJson(baseGeoJson, warningLevelMap) {
  if (!baseGeoJson) return { type: "FeatureCollection", features: [] };
  return {
    ...baseGeoJson,
    features: baseGeoJson.features.map(f => {
      const entry = warningLevelMap[f.properties.regioncode];
      return {
        ...f,
        // 移植元ツールと同じく、warnLevel(文字列)とwarnColor(ベタ色/transparent)の
        // 両方をfeature propertiesに埋め込む。fill-colorはこのwarnColorをそのまま参照する。
        properties: {
          ...f.properties,
          warnLevel: entry ? entry.level : "",
          warnColor: entry ? WARNING_LEVEL_COLOR[entry.level] : "transparent",
        },
      };
    }),
  };
}


// fill-colorは["get","warnColor"](移植元ツールと同じ、match式は使わない)。
export function buildWarningAreaColorExpr() {
  return ["get", "warnColor"];
}


// 五十音(あかさたなはまやらわ)の行・段の定義。「あかさたなはまやらわ」の
// ボタン(1段目)→選んだ行の中の段(例: あいうえお)(2段目)→一覧、の
// 2段階の絞り込みに使う。
export const KANA_ROWS = [
  { key: "あ", columns: ["あ", "い", "う", "え", "お"] },
  { key: "か", columns: ["か", "き", "く", "け", "こ"] },
  { key: "さ", columns: ["さ", "し", "す", "せ", "そ"] },
  { key: "た", columns: ["た", "ち", "つ", "て", "と"] },
  { key: "な", columns: ["な", "に", "ぬ", "ね", "の"] },
  { key: "は", columns: ["は", "ひ", "ふ", "へ", "ほ"] },
  { key: "ま", columns: ["ま", "み", "む", "め", "も"] },
  { key: "や", columns: ["や", "ゆ", "よ"] },
  { key: "ら", columns: ["ら", "り", "る", "れ", "ろ"] },
  { key: "わ", columns: ["わ", "を", "ん"] },
];

// 濁音・半濁音・拗音・促音・小書き文字を、五十音表での分類上の基本の文字に正規化する
// (例: 「が」は「か」行「か」段として分類する、辞書の見出し語順と同じ考え方)。
const KANA_BASE_MAP = {
  "が": "か", "ぎ": "き", "ぐ": "く", "げ": "け", "ご": "こ",
  "ざ": "さ", "じ": "し", "ず": "す", "ぜ": "せ", "ぞ": "そ",
  "だ": "た", "ぢ": "ち", "づ": "つ", "で": "て", "ど": "と",
  "ば": "は", "び": "ひ", "ぶ": "ふ", "べ": "へ", "ぼ": "ほ",
  "ぱ": "は", "ぴ": "ひ", "ぷ": "ふ", "ぺ": "へ", "ぽ": "ほ",
  "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "っ": "つ",
  "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
};

// 「段の文字」→{行key, 段文字}のフラットな逆引きマップを1回だけ作る。
const KANA_CHAR_TO_ROWCOL = (() => {
  const map = {};
  for (const row of KANA_ROWS) {
    for (const col of row.columns) map[col] = { rowKey: row.key, colChar: col };
  }
  return map;
})();

function classifyKanaChar(ch) {
  if (!ch) return null;
  const base = KANA_BASE_MAP[ch] || ch;
  return KANA_CHAR_TO_ROWCOL[base] || null;
}

// 市区町村一覧(loadWarningAreaMunicipalities()の結果)を、行→段→(その段に属する
// 市区町村の配列、namekana昇順)の入れ子オブジェクトに分類する。
export function groupMunicipalitiesByKana(municipalities) {
  const grouped = {};
  for (const m of municipalities) {
    const cls = classifyKanaChar((m.namekana || "")[0]);
    if (!cls) continue;
    grouped[cls.rowKey] = grouped[cls.rowKey] || {};
    grouped[cls.rowKey][cls.colChar] = grouped[cls.rowKey][cls.colChar] || [];
    grouped[cls.rowKey][cls.colChar].push(m);
  }
  for (const rowKey in grouped) {
    for (const colChar in grouped[rowKey]) {
      grouped[rowKey][colChar].sort((a, b) => a.namekana.localeCompare(b.namekana, "ja"));
    }
  }
  return grouped;
}


// 計測震度(連続値)を気象庁の震度階級に変換する(「震度を知る」の計測震度→震度階級の対応表)。
function instrumentalIntensityToScaleKey(i) {
  if (i < 0.5) return "0";
  if (i < 1.5) return "1";
  if (i < 2.5) return "2";
  if (i < 3.5) return "3";
  if (i < 4.5) return "4";
  if (i < 5.0) return "5-";
  if (i < 5.5) return "5+";
  if (i < 6.0) return "6-";
  if (i < 6.5) return "6+";
  return "7";
}


// 緊急地震速報テスト配信専用: 震源(緯度・経度・M・深さ)から、細分区域.json(areasGeoJSON)の
// 各地域の予測最大震度を距離減衰式で計算する。気象庁「緊急地震速報の概要や処理手法に関する
// 技術的参考資料」(令和6年4月版)の予測震度算出処理をベースにしている:
//   1. Mjma→Mw変換(宇津[1982]等): Mw = M - 0.171
//   2. 断層長(宇津[1977]): log10(L) = 0.5*Mw - 1.85 半分を震源球の半径とし、最短距離から差し引く
//      (下限3km)
//   3. 司・翠川[1999]の距離減衰式で基準基盤(Vs600m/s)上の最大速度PGV600を算出
//   4. 地表への換算。本来は基準基盤→工学的基盤(≒0.90倍)→地点ごとの地盤増幅度、と
//      2段階だが、地点別の地盤増幅度データは持たないため、代わりに市街地の軟弱地盤を
//      想定した簡易増幅係数(SITE_AMPLIFICATION_FACTOR)を掛けている。この値は気象庁の
//      実運用の平均値より高め(＝震度がやや過大気味)に寄せてある。
//   5. 翠川ほか[1999]の換算式で計測震度に変換する。
// 気象庁は震度4未満の予測でも緊急地震速報(予報)自体は発表し、最大震度の予測値も含めて
// いる(警報になるのは震度5弱以上の予測の時)。そのため、地図に塗り潰す地域(areas)は
// 従来通り震度4以上のみに絞る一方、カードの「最大震度」表示に使うmaxIntensityKeyは
// 震度4未満だった場合も含めた全地域中の最大値から求め、震度4未満の震源でも「?」に
// ならず正しい予測震度が表示されるようにしている。
const SITE_AMPLIFICATION_FACTOR = 2.0;

// 震度キー→気象庁の震度階級コード(数値。大きいほど強い)の対応。eewMaxScaleKey等で
// 使われているものと同じ体系。
const INTENSITY_SCALE_CODE = { "7": 70, "6+": 60, "6-": 55, "6": 54, "5+": 50, "5-": 45, "5": 44, "4": 40, "3": 30, "2": 20, "1": 10, "0": 0 };

// テスト配信専用: 震度5弱(気象庁の実運用で警報の基準となる階級)以上を警報級とみなす。
export function isTestWarnLevel(intensityKey) {
  return (INTENSITY_SCALE_CODE[intensityKey] ?? -1) >= 45;
}

export function calcTestEewAreasByAttenuation(areasGeoJSON, lat, lon, magnitude, depthKm, isPlum) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features)) return { areas: [], maxIntensityKey: "?" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(magnitude)) {
    return { areas: [], maxIntensityKey: "?" };
  }
  const D = Number.isFinite(depthKm) ? Math.max(0, depthKm) : 10;
  const Mw = magnitude - 0.171;
  const faultLengthKm = Math.pow(10, 0.5 * Mw - 1.85);
  const sourceRadiusKm = faultLengthKm / 2;

  const areas = []; // 地図の塗り潰し用(震度4以上のみ)
  let overallMaxValue = -Infinity;
  let overallMaxKey = null;

  for (const feature of areasGeoJSON.features) {
    const name = feature.properties?.name;
    if (!name) continue;
    const center = polygonRoughCentroid(feature.geometry);
    if (!center) continue;

    const epicentralKm = Math.sqrt(fastDist2(lat, lon, center.lat, center.lon));
    const hypocentralKm = Math.sqrt(epicentralKm * epicentralKm + D * D);
    const shortestKm = Math.max(3, hypocentralKm - sourceRadiusKm);

    const logPGV600 = 0.58 * Mw + 0.0038 * D - 1.29
      - Math.log10(shortestKm + 0.0028 * Math.pow(10, 0.5 * Mw))
      - 0.002 * shortestKm;
    const PGV600 = Math.pow(10, logPGV600);
    const PGVs = PGV600 * SITE_AMPLIFICATION_FACTOR;

    const instrIntensity = 2.68 + 1.72 * Math.log10(PGVs);
    if (!Number.isFinite(instrIntensity)) continue;

    const key = instrumentalIntensityToScaleKey(instrIntensity);
    if (instrIntensity > overallMaxValue) {
      overallMaxValue = instrIntensity;
      overallMaxKey = key;
    }
    if (instrIntensity < 4) continue; // 塗り潰し対象は震度4以上のみ

    const code = INTENSITY_SCALE_CODE[key] ?? 40;
    areas.push({ pref: "", name, scaleFrom: code, scaleTo: code, maxIntensityKey: key, isPlum: !!isPlum });
  }
  return { areas, maxIntensityKey: overallMaxKey || "?" };
}


/* ─────────────────────────────────────────────────────
   地震情報テスト配信専用: 震源(緯度・経度・M・深さ)から、震度速報・震度に関する情報の
   段階で使うダミーの観測点分布(points)を作る。
   calcTestEewAreasByAttenuationと同じ距離減衰式をそのまま使い回すが、EEW側は
   「地図に塗る震度4以上の地域」だけに絞っているのに対し、こちらは震度速報の
   雰囲気を再現するため震度1以上の地域も含める(細分区域.json全域を計算するため、
   通常の震源だとEEWよりだいぶ多い件数になる)。
   本来のP2P地震情報の観測点(points)は市町村・観測点単位(isArea:false)だが、
   このテスト機能では細分区域単位(isArea:true)の粒度で簡易的に生成する
   (震度速報と同じ粒度。実際の詳細報もこの粒度で代用する簡略化版)。
   ───────────────────────────────────────────────────── */
function calcTestQuakePointsByAttenuation(areasGeoJSON, lat, lon, magnitude, depthKm) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features)) return { points: [], maxIntensityKey: "?" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(magnitude)) {
    return { points: [], maxIntensityKey: "?" };
  }
  const D = Number.isFinite(depthKm) ? Math.max(0, depthKm) : 10;
  const Mw = magnitude - 0.171;
  const faultLengthKm = Math.pow(10, 0.5 * Mw - 1.85);
  const sourceRadiusKm = faultLengthKm / 2;

  const points = [];
  let overallMaxValue = -Infinity;
  let overallMaxKey = null;

  for (const feature of areasGeoJSON.features) {
    const name = feature.properties?.name;
    if (!name) continue;
    const center = polygonRoughCentroid(feature.geometry);
    if (!center) continue;

    const epicentralKm = Math.sqrt(fastDist2(lat, lon, center.lat, center.lon));
    const hypocentralKm = Math.sqrt(epicentralKm * epicentralKm + D * D);
    const shortestKm = Math.max(3, hypocentralKm - sourceRadiusKm);

    const logPGV600 = 0.58 * Mw + 0.0038 * D - 1.29
      - Math.log10(shortestKm + 0.0028 * Math.pow(10, 0.5 * Mw))
      - 0.002 * shortestKm;
    const PGV600 = Math.pow(10, logPGV600);
    const PGVs = PGV600 * SITE_AMPLIFICATION_FACTOR;

    const instrIntensity = 2.68 + 1.72 * Math.log10(PGVs);
    if (!Number.isFinite(instrIntensity)) continue;

    const key = instrumentalIntensityToScaleKey(instrIntensity);
    if (instrIntensity > overallMaxValue) {
      overallMaxValue = instrIntensity;
      overallMaxKey = key;
    }
    if (instrIntensity < 1) continue; // 震度1未満の地域は載せない(震度速報の実際の見え方に合わせる)

    points.push({ pref: "", addr: name, scale: INTENSITY_SCALE_CODE[key] ?? 10, isArea: true });
  }
  return { points, maxIntensityKey: overallMaxKey || "?" };
}


// 地震情報テスト配信: 発表段階(stage)ごとに、実際のtoQuakeCard()と同じ形のカードを作る。
// ①震度速報(prompt): 震源不明、地域単位の震度分布あり、津波は調査中。
// ②震源に関する情報(destination): 震源は判明、震度分布はまだ無い(maxIntensityは"?")。
// ③震度に関する情報(detail): 震源・震度分布ともに確定。津波はフォームの指定値。
// time(発生時刻)は同じ地震の複数段階を通じて固定し、issueTimeStrだけ毎回「今」を渡す
// ことで、実際のmergeQuakeCards(dedupeQuakeList)と同じ仕組みでApp側が段階的に統合できる。
export function buildTestQuakeStageCard(stage, form, time, issueTimeStr, areasGeoJSON) {
  const { points, maxIntensityKey } = calcTestQuakePointsByAttenuation(
    areasGeoJSON, form.latitude, form.longitude, form.magnitude, form.depth
  );

  if (stage === "prompt") {
    return {
      id: `test_${time}_prompt`,
      time, issueTime: issueTimeStr, stage: "prompt",
      place: "震源調査中",
      maxIntensity: maxIntensityKey,
      isForeign: false,
      magnitude: null, depth: null, latitude: null, longitude: null, longPeriod: null,
      points,
      domesticTsunami: "Checking",
      freeFormComment: null,
      isTest: true,
    };
  }
  if (stage === "destination") {
    return {
      id: `test_${time}_destination`,
      time, issueTime: issueTimeStr, stage: "destination",
      place: form.place || "震源地不明",
      maxIntensity: "?",
      isForeign: false,
      magnitude: form.magnitude, depth: form.depth, latitude: form.latitude, longitude: form.longitude, longPeriod: null,
      points: [],
      domesticTsunami: "Checking",
      freeFormComment: null,
      isTest: true,
    };
  }
  // detail(確定)
  return {
    id: `test_${time}_detail`,
    time, issueTime: issueTimeStr, stage: "detail",
    place: form.place || "震源地不明",
    maxIntensity: maxIntensityKey,
    isForeign: false,
    magnitude: form.magnitude, depth: form.depth, latitude: form.latitude, longitude: form.longitude, longPeriod: null,
    points,
    domesticTsunami: form.domesticTsunami || "None",
    freeFormComment: null,
    isTest: true,
  };
}


// 潮位観測点(1点)から一番近い津波予報区を、tsunami-areas.json(海岸線の座標データ、
// 都道府県名などのあいまいな情報に頼らず地図描画に実際使っている正式なデータ)との
// 距離計算で求める。各予報区のMultiLineStringの頂点との最短距離で近似している
// (頂点間隔は密なため、線分内挿までは行わずとも十分な精度が出る)。
export function findNearestTsunamiArea(lat, lon, tsunamiAreasGeoJSON) {
  if (lat == null || lon == null || !tsunamiAreasGeoJSON || !Array.isArray(tsunamiAreasGeoJSON.features)) return null;
  let best = null;
  let bestDist2 = Infinity;
  for (const feature of tsunamiAreasGeoJSON.features) {
    const multiLine = feature.geometry?.coordinates;
    if (!Array.isArray(multiLine)) continue;
    for (const line of multiLine) {
      for (const pt of line) {
        const d2 = fastDist2(lat, lon, pt[1], pt[0]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          best = feature.properties;
        }
      }
    }
  }
  return best; // { code, name } | null
}


// findNearestTsunamiAreaと同じ距離計算だが、地図タップでの予報区選択用に
// 「どれだけ近かったか(km)」も一緒に返す。海上の何もない場所や地図の範囲外を
// 誤ってタップした場合に、呼び出し側で距離が遠すぎる結果を弾けるようにするため。
export function findNearestTsunamiAreaWithDistance(lat, lon, tsunamiAreasGeoJSON) {
  if (lat == null || lon == null || !tsunamiAreasGeoJSON || !Array.isArray(tsunamiAreasGeoJSON.features)) return null;
  let best = null;
  let bestDist2 = Infinity;
  for (const feature of tsunamiAreasGeoJSON.features) {
    const multiLine = feature.geometry?.coordinates;
    if (!Array.isArray(multiLine)) continue;
    for (const line of multiLine) {
      for (const pt of line) {
        const d2 = fastDist2(lat, lon, pt[1], pt[0]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          best = feature.properties;
        }
      }
    }
  }
  if (!best) return null;
  return { ...best, distanceKm: Math.sqrt(bestDist2) }; // { code, name, distanceKm } | null
}
