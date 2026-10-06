import { useEffect, useState } from "react";
import { cachedFetchJSON } from "../lib/loaders.js";
import { maxScaleToIntensityKey } from "../api/p2p.js";
import { TIDE_AREA_URL, eqdbDetailToEpicenterPoint, eqdbEventDetailCache, eqdbIdToTimeDisplay, eqdbIntensityStringToScale, fastDist2, fetchEqdbEventCached, tideObsUrl, toTideDateStr } from "../api/quakeData.js";
import { findMunicipalityAtPoint } from "../api/warnings.js";

/* ─────────────────────────────────────────────────────
   天気タブ「地点」モード — 現在地(GPS)または登録地点の天気予報。
   気象庁の天気予報(forecast.json)は府県予報区(office)単位、天気・降水確率は
   一次細分区域(class10s)単位、気温はアメダス観測所単位で提供されており、
   緯度経度から直接これらを引く手段は無い。そこでここでは、
     1. アメダス観測点一覧(amedastable.json、緯度経度あり)から一番近い観測点を探す
     2. その観測点が属する一次細分区域・オフィスを、天気予報で使うアメダス地点だけを
        まとめたforecast_area.json(office→class10→amedasの対応表)から逆引きする
   という2段階でlat/lngから予報の取得先(office・class10・amedas)を決める。
   ───────────────────────────────────────────────────── */
const AMEDAS_TABLE_URL = "https://www.jma.go.jp/bosai/amedas/const/amedastable.json";

const FORECAST_AREA_URL = "https://www.jma.go.jp/bosai/forecast/const/forecast_area.json";

function forecastDataUrl(officeCode) {
  return `https://www.jma.go.jp/bosai/forecast/data/forecast/${officeCode}.json`;
}


// area.json上の行政区分(office)としては存在するのに、forecast.json自体は
// 気象庁側に用意されておらず、実際には別のofficeのデータで代用されている
// コードがいくつかある(気象庁の天気予報ページ自身もこの読み替えを内部で
// 行っている)。判明しているもの:
//   460040(奄美地方)      → 460100(鹿児島県) のforecast.jsonを使う
//   014030(十勝地方)      → 014100            のforecast.jsonを使う
// 該当する地域(class10Code)自体は代用先のforecast.json内にareaの1つとして
// ちゃんと含まれているため、officeCodeだけこちらに差し替えてfetchし、
// class10Code/amedasCodeでの絞り込みはそのまま行えばよい。
const FORECAST_OFFICE_CODE_REDIRECTS = {
  "014030": "014100",
  "460040": "460100",
};

function resolveForecastFetchOfficeCode(officeCode) {
  return FORECAST_OFFICE_CODE_REDIRECTS[officeCode] || officeCode;
}


// amedastable.jsonの緯度経度は[度, 分]の配列で入っているため、10進度に変換する。
function amedasDegMinToDecimal(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const [deg, min] = pair;
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  return deg + min / 60;
}


let amedasPointsCache = null;
      // [{code, lat, lon, name}] | null(未取得)
let forecastAreaDataCache = null;
  // { index: {amedasコード:{officeCode,class10Code}}, byOffice: {officeCode:[amedasコード]} } | null(未取得)

async function loadAmedasPoints() {
  if (amedasPointsCache) return amedasPointsCache;
  const res = await fetch(AMEDAS_TABLE_URL);
  if (!res.ok) throw new Error(`アメダス観測点一覧の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  const points = [];
  for (const code of Object.keys(data)) {
    const entry = data[code];
    const lat = amedasDegMinToDecimal(entry.lat);
    const lon = amedasDegMinToDecimal(entry.lon);
    if (lat == null || lon == null) continue;
    points.push({ code, lat, lon, name: entry.kjName || "" });
  }
  amedasPointsCache = points;
  return points;
}


async function loadForecastAreaData() {
  if (forecastAreaDataCache) return forecastAreaDataCache;
  const res = await fetch(FORECAST_AREA_URL);
  if (!res.ok) throw new Error(`天気予報エリア対応表の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  const index = {};    // amedasコード → {officeCode, class10Code}
  const byOffice = {};  // officeCode → そのofficeに属するamedasコードの配列
  for (const officeCode of Object.keys(data)) {
    byOffice[officeCode] = [];
    for (const entry of data[officeCode]) {
      for (const amedasCode of entry.amedas || []) {
        index[amedasCode] = { officeCode, class10Code: entry.class10 };
        byOffice[officeCode].push(amedasCode);
      }
    }
  }
  forecastAreaDataCache = { index, byOffice };
  return forecastAreaDataCache;
}


// 気象庁の公式な行政区分階層(common/const/area.json、centers→offices→
// class10s→class15s→class20s)。class20sのコードは、市区町村境界データ
// (warning_areas.json)のregioncodeと同じJIS X 0402ベースの7桁コードなので、
// これをキーに辿ればofficeCode・class10Codeを距離ではなく行政区分そのものから
// 正確に求められる。
const AREA_HIERARCHY_URL = "https://www.jma.go.jp/bosai/common/const/area.json";

let areaHierarchyPromise = null;

function loadAreaHierarchy() {
  if (!areaHierarchyPromise) areaHierarchyPromise = cachedFetchJSON(AREA_HIERARCHY_URL);
  return areaHierarchyPromise;
}

async function resolveForecastAreaFromMunicipalityCode(regioncode) {
  const area = await loadAreaHierarchy();
  const class20 = area.class20s?.[regioncode];
  const class15 = class20 && area.class15s?.[class20.parent];
  const class10Code = class15?.parent;
  const class10 = class10Code && area.class10s?.[class10Code];
  const officeCode = class10?.parent;
  if (!officeCode || !area.offices?.[officeCode]) return null;
  return { officeCode, class10Code };
}


// 緯度・経度から、天気予報の取得に必要な情報(所属オフィス・一次細分区域・
// 気温用の最寄りアメダス観測点)をまとめて求める。
//
// まず市区町村境界データ(warning_areas.json)でその地点を含む市区町村を特定し、
// 気象庁の公式な行政区分階層からofficeCode・class10Codeを求める(都県境付近だと、
// 直線距離では隣の都県のアメダス観測点の方が近いことがあり、距離だけで推定すると
// 隣県の予報が出てしまうことがあるため)。市区町村が特定できなかった場合(海上など)
// のみ、全国のアメダス観測点から単純に最寄りを探すやり方にフォールバックする。
// 気温を取る観測点(amedasCode)は、officeCodeが判明していればその予報区に属する
// 観測点の中だけから最寄りを探す(そうしないと気温だけ隣県の観測点になりうるため)。
async function resolveForecastLocation(lat, lon, opts = {}) {
  let officeCode = null;
  let class10Code = null;
  if (!opts.ignoreMunicipality) {
    try {
      const muni = await findMunicipalityAtPoint(lat, lon);
      if (muni?.regioncode) {
        const resolved = await resolveForecastAreaFromMunicipalityCode(muni.regioncode);
        if (resolved) {
          officeCode = resolved.officeCode;
          class10Code = resolved.class10Code;
        }
      }
    } catch (err) {
      console.error("市区町村境界からの予報エリア解決に失敗。距離ベースの推定にフォールバックします:", err);
    }
  }

  const [points, areaData] = await Promise.all([loadAmedasPoints(), loadForecastAreaData()]);
  const { index: areaIndex, byOffice } = areaData;
  // area.jsonとforecast_area.jsonでコードの型(文字列/数値)が食い違っていても
  // 一致判定できるよう、Setに入れる側・検索する側の両方を文字列に揃えておく
  // (離島など特定の地域だけ突き合わせが崩れる不具合の予防策)。
  let candidateSet = officeCode ? new Set((byOffice[officeCode] || []).map(String)) : null;
  // area.jsonとforecast_area.jsonでofficeコードの対応が取れず、絞り込んだ結果
  // 候補が1件も無い場合は、行政区分による解決自体を諦めて全国検索にフォールバック
  // する(「予報が全く出ない」よりは、多少不正確でも予報が出る方が良いため)。
  if (candidateSet && candidateSet.size === 0) {
    officeCode = null;
    class10Code = null;
    candidateSet = null;
  }

  let best = null;
  let bestDist2 = Infinity;
  for (const pt of points) {
    const isCandidate = candidateSet ? candidateSet.has(String(pt.code)) : !!areaIndex[pt.code];
    if (!isCandidate) continue;
    const d2 = fastDist2(lat, lon, pt.lat, pt.lon);
    if (d2 < bestDist2) {
      bestDist2 = d2;
      best = pt;
    }
  }
  if (!best) return null;

  if (!officeCode) {
    const fallback = areaIndex[best.code];
    officeCode = fallback.officeCode;
    class10Code = fallback.class10Code;
  }
  return { officeCode, class10Code, amedasCode: best.code, stationName: best.name };
}


// weatherCode → { icon(気象庁のSVGファイル名の数字部分), telop(短い天気表現) }。
// 出典: 気象庁の天気予報JSON内で使われているコード表。
const WEATHER_CODE_INFO = {
  "100": { icon: "100", telop: "晴" }, "101": { icon: "101", telop: "晴時々曇" },
  "102": { icon: "102", telop: "晴一時雨" }, "103": { icon: "102", telop: "晴時々雨" },
  "104": { icon: "104", telop: "晴一時雪" }, "105": { icon: "104", telop: "晴時々雪" },
  "106": { icon: "102", telop: "晴一時雨か雪" }, "107": { icon: "102", telop: "晴時々雨か雪" },
  "108": { icon: "102", telop: "晴一時雨か雷雨" }, "110": { icon: "110", telop: "晴後時々曇" },
  "111": { icon: "110", telop: "晴後曇" }, "112": { icon: "112", telop: "晴後一時雨" },
  "113": { icon: "112", telop: "晴後時々雨" }, "114": { icon: "112", telop: "晴後雨" },
  "115": { icon: "115", telop: "晴後一時雪" }, "116": { icon: "115", telop: "晴後時々雪" },
  "117": { icon: "115", telop: "晴後雪" }, "118": { icon: "112", telop: "晴後雨か雪" },
  "119": { icon: "112", telop: "晴後雨か雷雨" }, "120": { icon: "102", telop: "晴朝夕一時雨" },
  "121": { icon: "102", telop: "晴朝の内一時雨" }, "122": { icon: "112", telop: "晴夕方一時雨" },
  "123": { icon: "100", telop: "晴山沿い雷雨" }, "124": { icon: "100", telop: "晴山沿い雪" },
  "125": { icon: "112", telop: "晴午後は雷雨" }, "126": { icon: "112", telop: "晴昼頃から雨" },
  "127": { icon: "112", telop: "晴夕方から雨" }, "128": { icon: "112", telop: "晴夜は雨" },
  "130": { icon: "100", telop: "朝の内霧後晴" }, "131": { icon: "100", telop: "晴明け方霧" },
  "132": { icon: "101", telop: "晴朝夕曇" }, "140": { icon: "102", telop: "晴時々雨で雷を伴う" },
  "160": { icon: "104", telop: "晴一時雪か雨" }, "170": { icon: "104", telop: "晴時々雪か雨" },
  "181": { icon: "115", telop: "晴後雪か雨" },
  "200": { icon: "200", telop: "曇" }, "201": { icon: "201", telop: "曇時々晴" },
  "202": { icon: "202", telop: "曇一時雨" }, "203": { icon: "202", telop: "曇時々雨" },
  "204": { icon: "204", telop: "曇一時雪" }, "205": { icon: "204", telop: "曇時々雪" },
  "206": { icon: "202", telop: "曇一時雨か雪" }, "207": { icon: "202", telop: "曇時々雨か雪" },
  "208": { icon: "202", telop: "曇一時雨か雷雨" }, "209": { icon: "200", telop: "霧" },
  "210": { icon: "210", telop: "曇後時々晴" }, "211": { icon: "210", telop: "曇後晴" },
  "212": { icon: "212", telop: "曇後一時雨" }, "213": { icon: "212", telop: "曇後時々雨" },
  "214": { icon: "212", telop: "曇後雨" }, "215": { icon: "215", telop: "曇後一時雪" },
  "216": { icon: "215", telop: "曇後時々雪" }, "217": { icon: "215", telop: "曇後雪" },
  "218": { icon: "212", telop: "曇後雨か雪" }, "219": { icon: "212", telop: "曇後雨か雷雨" },
  "220": { icon: "202", telop: "曇朝夕一時雨" }, "221": { icon: "202", telop: "曇朝の内一時雨" },
  "222": { icon: "212", telop: "曇夕方一時雨" }, "223": { icon: "201", telop: "曇日中時々晴" },
  "224": { icon: "212", telop: "曇昼頃から雨" }, "225": { icon: "212", telop: "曇夕方から雨" },
  "226": { icon: "212", telop: "曇夜は雨" }, "228": { icon: "215", telop: "曇昼頃から雪" },
  "229": { icon: "215", telop: "曇夕方から雪" }, "230": { icon: "215", telop: "曇夜は雪" },
  "231": { icon: "200", telop: "曇海上海岸は霧か霧雨" }, "240": { icon: "202", telop: "曇時々雨で雷を伴う" },
  "250": { icon: "204", telop: "曇時々雪で雷を伴う" }, "260": { icon: "204", telop: "曇一時雪か雨" },
  "270": { icon: "204", telop: "曇時々雪か雨" }, "281": { icon: "215", telop: "曇後雪か雨" },
  "300": { icon: "300", telop: "雨" }, "301": { icon: "301", telop: "雨時々晴" },
  "302": { icon: "302", telop: "雨時々止む" }, "303": { icon: "303", telop: "雨時々雪" },
  "304": { icon: "300", telop: "雨か雪" }, "306": { icon: "300", telop: "大雨" },
  "308": { icon: "308", telop: "雨で暴風を伴う" }, "309": { icon: "303", telop: "雨一時雪" },
  "311": { icon: "311", telop: "雨後晴" }, "313": { icon: "313", telop: "雨後曇" },
  "314": { icon: "314", telop: "雨後時々雪" }, "315": { icon: "314", telop: "雨後雪" },
  "316": { icon: "311", telop: "雨か雪後晴" }, "317": { icon: "313", telop: "雨か雪後曇" },
  "320": { icon: "311", telop: "朝の内雨後晴" }, "321": { icon: "313", telop: "朝の内雨後曇" },
  "322": { icon: "303", telop: "雨朝晩一時雪" }, "323": { icon: "311", telop: "雨昼頃から晴" },
  "324": { icon: "311", telop: "雨夕方から晴" }, "325": { icon: "311", telop: "雨夜は晴" },
  "326": { icon: "314", telop: "雨夕方から雪" }, "327": { icon: "314", telop: "雨夜は雪" },
  "328": { icon: "300", telop: "雨一時強く降る" }, "329": { icon: "300", telop: "雨一時みぞれ" },
  "340": { icon: "400", telop: "雪か雨" }, "350": { icon: "300", telop: "雨で雷を伴う" },
  "361": { icon: "411", telop: "雪か雨後晴" }, "371": { icon: "413", telop: "雪か雨後曇" },
  "400": { icon: "400", telop: "雪" }, "401": { icon: "401", telop: "雪時々晴" },
  "402": { icon: "402", telop: "雪時々止む" }, "403": { icon: "403", telop: "雪時々雨" },
  "405": { icon: "400", telop: "大雪" }, "406": { icon: "406", telop: "風雪強い" },
  "407": { icon: "406", telop: "暴風雪" }, "409": { icon: "403", telop: "雪一時雨" },
  "411": { icon: "411", telop: "雪後晴" }, "413": { icon: "413", telop: "雪後曇" },
  "414": { icon: "414", telop: "雪後雨" }, "420": { icon: "411", telop: "朝の内雪後晴" },
  "421": { icon: "413", telop: "朝の内雪後曇" }, "422": { icon: "414", telop: "雪昼頃から雨" },
  "423": { icon: "414", telop: "雪夕方から雨" }, "425": { icon: "400", telop: "雪一時強く降る" },
  "426": { icon: "400", telop: "雪後みぞれ" }, "427": { icon: "400", telop: "雪一時みぞれ" },
  "450": { icon: "400", telop: "雪で雷を伴う" },
};

function weatherTelop(code) {
  const info = WEATHER_CODE_INFO[String(code)];
  return info ? info.telop : "不明";
}


/* ─────────────────────────────────────────────────────
   天気アイコン(https://github.com/ciscorn/jma-weather-images, license: CC0)

   あのリポジトリは「基本アイコン(晴・くもり・雨…)+のちサイン」の少数の
   部品画像を、weathercodeごとの指定(b=ベース, m=修飾子, t=対象)に従って
   PILで合成し、weathercodeごとの画像を書き出す、という仕組みになっている
   (generate.py参照)。
   今回は事前に静止画として書き出す代わりに、同じ合成ロジックをそのまま
   このコンポーネントに移植し、部品SVG(public/srcimgs_refs/に配置)を
   CSSの絶対配置で重ねることでブラウザ側で合成する。これなら部品SVGを
   1セット(16個程度)用意するだけで済み、weathercodeが増えても新しい
   組み合わせを追加するだけでよい。

   generate.pyの座標算出(WIDTH=260, HEIGHT=145のキャンバス基準)をそのまま
   %に変換してある。ロジックの対応関係:
   - make_one            → ICON_LAYOUT.single
   - make_two (mod=="tr" のときの d=0 の大きめレイアウト)
                         → ICON_LAYOUT.trTarget / trBase
   - make_two (mod!="tr" のときの d=HEIGHT//8 の縮小・右上寄せレイアウト。
     "st"/"te"だけでなく"trst"/"trte"もこちら側に入る点はgenerate.py通り)
                         → ICON_LAYOUT.cornerTarget / cornerBase
   - draw_modifier(mod=="tr"のときだけ、のち矢印を重ねる)
                         → ICON_LAYOUT.trArrow
   PILのcomposite()は後から描いた画像が上に乗るため、DOM上の描画順も
   target→base→(のち矢印) の順にして同じ重なりにしている。 */

// codes.json (ciscorn/jma-weather-images) から、このアプリが実際に使う
// weathercodeの分だけ抜き出したもの。b=ベースアイコン、m=修飾子
// (tr=のち, st=時々, te=一時, trst/trte=のち+時々/一時), t=対象アイコン。
const WEATHER_ICON_SPEC = {
  "100": { b: "sun" }, "101": { b: "sun", m: "st", t: "cloud" },
  "102": { b: "sun", m: "te", t: "rain" }, "103": { b: "sun", m: "st", t: "rain" },
  "104": { b: "sun", m: "te", t: "snow" }, "105": { b: "sun", m: "st", t: "snow" },
  "106": { b: "sun", m: "te", t: "rain_or_snow" }, "107": { b: "sun", m: "st", t: "rain_or_snow" },
  "108": { b: "sun", m: "te", t: "rain_thunder" }, "110": { b: "sun", m: "trst", t: "cloud" },
  "111": { b: "sun", m: "tr", t: "cloud" }, "112": { b: "sun", m: "trst", t: "rain" },
  "113": { b: "sun", m: "trte", t: "rain" }, "114": { b: "sun", m: "tr", t: "rain" },
  "115": { b: "sun", m: "trte", t: "snow" }, "116": { b: "sun", m: "trst", t: "snow" },
  "117": { b: "sun", m: "tr", t: "snow" }, "118": { b: "sun", m: "tr", t: "rain_or_snow" },
  "119": { b: "sun", m: "tr", t: "rain_thunder" }, "120": { b: "sun", m: "te", t: "rain" },
  "121": { b: "sun", m: "te", t: "rain" }, "122": { b: "sun", m: "te", t: "rain" },
  "123": { b: "sun" }, "124": { b: "sun" },
  "125": { b: "sun", m: "tr", t: "rain_thunder" }, "126": { b: "sun", m: "tr", t: "rain" },
  "127": { b: "sun", m: "tr", t: "rain" }, "128": { b: "sun", m: "tr", t: "rain" },
  "130": { b: "mist", m: "tr", t: "sun" }, "131": { b: "sun", m: "tr", t: "mist" },
  "132": { b: "sun", m: "st", t: "cloud" }, "140": { b: "sun", m: "st", t: "rain_thunder" },
  "160": { b: "sun", m: "te", t: "snow_or_rain" }, "170": { b: "sun", m: "st", t: "snow_or_rain" },
  "181": { b: "sun", m: "tr", t: "snow_or_rain" },
  "200": { b: "cloud" }, "201": { b: "cloud", m: "st", t: "sun" },
  "202": { b: "cloud", m: "te", t: "rain" }, "204": { b: "cloud", m: "te", t: "snow" },
  "209": { b: "mist" }, "210": { b: "cloud", m: "trst", t: "sun" },
  "212": { b: "cloud", m: "trte", t: "rain" }, "215": { b: "cloud", m: "trte", t: "snow" },
  "300": { b: "rain" }, "301": { b: "rain", m: "st", t: "sun" },
  "302": { b: "rain", m: "st", t: "cloud" }, "303": { b: "rain", m: "st", t: "snow" },
  "308": { b: "rain_wind" },
  "311": { b: "rain", m: "tr", t: "sun" }, "313": { b: "rain", m: "tr", t: "cloud" },
  "314": { b: "rain", m: "trst", t: "snow" },
  "400": { b: "snow" }, "401": { b: "snow", m: "st", t: "sun" },
  "402": { b: "snow", m: "st", t: "cloud" }, "403": { b: "snow", m: "st", t: "rain" },
  "406": { b: "snow_wind" },
  "411": { b: "snow", m: "tr", t: "sun" }, "413": { b: "snow", m: "tr", t: "cloud" },
  "414": { b: "snow", m: "tr", t: "rain" },
};


// codes.jsonの意味的なキー(rain_or_snowなど)→実ファイル名。generate.pyの
// BASE_IMAGESで複数のキーが同じ画像ファイルを指しているのに合わせてある。
const WEATHER_ICON_FILE = {
  sun: "sun", cloud: "cloud", rain: "rain", snow: "snow", mist: "mist",
  rain_thunder: "rain_thunder", snow_thunder: "snow_thunder",
  rain_heavy: "rain_heavy", snow_heavy: "snow_heavy",
  rain_wind: "rain_wind", snow_wind: "snow_wind", rain_heavy_wind: "rain_heavy_wind",
  rain_or_snow: "rain_and_snow", snow_or_rain: "rain_and_snow", rain_and_snow: "rain_and_snow",
  night_fair: "fair_night", tr: "tr",
};


function weatherIconAssetUrl(name) {
  const file = WEATHER_ICON_FILE[name] || name;
  return `${import.meta.env.BASE_URL}srcimgs_refs/${file}.svg`;
}


// generate.pyのWIDTH=260, HEIGHT=145キャンバス上の座標・サイズを%に変換。
const ICON_LAYOUT = {
  single:       { left: (57 / 260) * 100, top: 0, width: (145 / 260) * 100, height: 100 },
  trTarget:     { left: (115 / 260) * 100, top: 0, width: (145 / 260) * 100, height: 100 },
  trBase:       { left: 0, top: 0, width: (145 / 260) * 100, height: 100 },
  trArrow:      { left: (57 / 260) * 100, top: 0, width: (145 / 260) * 100, height: 100 },
  cornerTarget: { left: (124 / 260) * 100, top: (18 / 145) * 100, width: (109 / 260) * 100, height: (109 / 145) * 100 },
  cornerBase:   { left: (27 / 260) * 100, top: 0, width: (145 / 260) * 100, height: 100 },
};


function WeatherIconLayer({ name, layout }) {
  if (!name) return null;
  return (
    <img
      src={weatherIconAssetUrl(name)}
      alt=""
      style={{
        position: "absolute",
        left: `${layout.left}%`, top: `${layout.top}%`,
        width: `${layout.width}%`, height: `${layout.height}%`,
        objectFit: "contain",
      }}
    />
  );
}


// WIDTH:HEIGHT = 260:145 のキャンバス比率(部品アイコンの配置がこの比率を
// 前提にしているため、正方形に押し込めると位置がずれる)。
const WEATHER_ICON_ASPECT = 260 / 145;


export function WeatherIcon({ code, size = 68, alt = "", style }) {
  const spec = WEATHER_ICON_SPEC[String(code)] || WEATHER_ICON_SPEC["200"];
  const height = size;
  const width = Math.round(size * WEATHER_ICON_ASPECT);

  let content;
  if (spec.t) {
    // generate.pyのmake_two: mod=="tr"(完全一致)のときだけ「大きい二枚を
    // 並べて、のち矢印を重ねる」レイアウトになり、st/te/trst/trteはすべて
    // 「ベースを大きく、対象を右上に小さく」のレイアウトになる。
    const isTr = spec.m === "tr";
    const targetLayout = isTr ? ICON_LAYOUT.trTarget : ICON_LAYOUT.cornerTarget;
    const baseLayout = isTr ? ICON_LAYOUT.trBase : ICON_LAYOUT.cornerBase;
    content = (
      <>
        <WeatherIconLayer name={spec.t} layout={targetLayout} />
        <WeatherIconLayer name={spec.b} layout={baseLayout} />
        {isTr && <WeatherIconLayer name="tr" layout={ICON_LAYOUT.trArrow} />}
      </>
    );
  } else {
    content = <WeatherIconLayer name={spec.b} layout={ICON_LAYOUT.single} />;
  }

  return (
    <div
      role="img"
      aria-label={alt}
      style={{ position: "relative", width, height, flexShrink: 0, ...style }}
    >
      {content}
    </div>
  );
}

// 地域時系列予報(VPFD)は天気をweatherCodesではなく「くもり」「雨」のような短い
// テキストでしか返さない。3時間ごとの1コマにつき単一の天気語(「時々」「後」の
// ような複合表現は含まない)なので、キーワードを含むかどうかの単純な判定で
// weatherCode(100/200/300/400系)に割り当て、既存のweatherIconUrlでアイコン化する。
// 気になる点の優先順位は雷>雪>雨>霧>曇>晴(荒天要素を優先して見せる)。
function weatherTextToCode(text) {
  if (!text) return null;
  if (text.includes("雷")) return "300";
  if (text.includes("雪") || text.includes("あられ") || text.includes("ひょう")) return "400";
  if (text.includes("雨")) return "300";
  if (text.includes("霧")) return "200";
  if (text.includes("曇") || text.includes("くもり")) return "200";
  if (text.includes("晴")) return "100";
  return null;
}

const FORECAST_WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

// timeDefines(例: "2026-08-04T00:00:00+09:00")を"8/4(火)"のような短い表示に変換する。
export function formatForecastDayLabel(iso, index) {
  if (index === 0) return "今日";
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}(${FORECAST_WEEKDAY_JA[d.getDay()]})`;
}

// 地域時系列予報(3時間ごと)の時刻ラベル。日付が変わる最初のコマだけ「M/D」を
// 添える(それ以外は「時」だけで十分読める)。
export function formatTimeSeriesHour(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours()}時`;
}

export function formatTimeSeriesDateChanged(iso, prevIso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  if (!prevIso) return true;
  const prev = new Date(prevIso);
  return d.getDate() !== prev.getDate();
}


// 16方位の日本語表記(地域時系列予報のwind.direction)→北を0度とした角度。
const WIND_DIRECTION_DEGREES = {
  "北": 0, "北北東": 22.5, "北東": 45, "東北東": 67.5,
  "東": 90, "東南東": 112.5, "南東": 135, "南南東": 157.5,
  "南": 180, "南南西": 202.5, "南西": 225, "西南西": 247.5,
  "西": 270, "西北西": 292.5, "北西": 315, "北北西": 337.5,
};

export function windDirectionToDegrees(direction) {
  return WIND_DIRECTION_DEGREES[direction] ?? 0;
}


// forecast.json(office単位)から、指定class10Code(天気・降水確率用)・
// amedasCode(気温用)に対応する「今日の天気予報」をまとめて取り出す。
// forecast.jsonは [0]=今日・明日の短期予報, [1]=週間予報 の2要素配列。
function extractTodayForecast(forecastJson, class10Code, amedasCode) {
  if (!Array.isArray(forecastJson) || forecastJson.length === 0) return null;
  const shortTerm = forecastJson[0];
  const weekly = forecastJson[1];

  let weatherCode = null;
  let areaName = null;
  const weatherSeries = shortTerm?.timeSeries?.[0];
  if (weatherSeries) {
    const area = weatherSeries.areas?.find(a => a.area?.code === class10Code);
    if (area?.weatherCodes?.[0]) {
      weatherCode = area.weatherCodes[0];
      areaName = area.area?.name || null;
    }
  }
  if (weatherCode == null && weekly?.timeSeries?.[0]) {
    const area = weekly.timeSeries[0].areas?.find(a => a.area?.code === class10Code);
    if (area?.weatherCodes?.[0]) {
      weatherCode = area.weatherCodes[0];
      areaName = area.area?.name || areaName;
    }
  }

  // 降水確率(短期予報のtimeSeries[1]、6時間ごと。今日時点でまだ発表されていない
  // コマは空文字が入っているため、最初に値が入っているものを代表値として使う)。
  let pop = null;
  const popSeries = shortTerm?.timeSeries?.[1];
  if (popSeries) {
    const area = popSeries.areas?.find(a => a.area?.code === class10Code);
    const p = area?.pops?.find(v => v !== "");
    if (p != null) pop = Number(p);
  }

  // 気温(週間予報のtimeSeries[1]、アメダス単位。今日の最高・最低)。
  let tempMin = null, tempMax = null;
  const weeklyTempSeries = weekly?.timeSeries?.[1];
  if (weeklyTempSeries) {
    const area = weeklyTempSeries.areas?.find(a => a.area?.code === amedasCode);
    if (area) {
      if (area.tempsMin?.[0]) tempMin = Number(area.tempsMin[0]);
      if (area.tempsMax?.[0]) tempMax = Number(area.tempsMax[0]);
    }
  }
  // 週間予報にまだ無ければ、短期予報のtimeSeries[2](当日〜翌日の気温)から拾う。
  if ((tempMin == null || tempMax == null) && shortTerm?.timeSeries?.[2]) {
    const area = shortTerm.timeSeries[2].areas?.find(a => a.area?.code === amedasCode);
    if (area?.temps) {
      const nums = area.temps.filter(v => v !== "").map(Number);
      if (nums.length) {
        if (tempMin == null) tempMin = Math.min(...nums);
        if (tempMax == null) tempMax = Math.max(...nums);
      }
    }
  }

  if (weatherCode == null && pop == null && tempMin == null && tempMax == null) return null;
  return {
    areaName,
    weatherCode,
    telop: weatherCode != null ? weatherTelop(weatherCode) : null,
    pop, tempMin, tempMax,
  };
}


// 週間予報(forecastJson[1])から、1日ごとの{日付・天気・降水確率・最高/最低気温}の
// 配列を作る(index 0=今日 〜 6=1週間後、最大7日分)。3日間表示・週間表示どちらも
// この配列をスライスするだけで作れる。天気・降水確率はclass10Code、気温はamedasCode
// で該当エリアを探す(extractTodayForecastと同じ考え方)。
function extractDailyForecasts(forecastJson, class10Code, amedasCode) {
  if (!Array.isArray(forecastJson) || forecastJson.length < 2) return [];
  const weekly = forecastJson[1];
  const weatherSeries = weekly?.timeSeries?.[0];
  if (!weatherSeries || !weatherSeries.areas || weatherSeries.areas.length === 0) return [];
  // 週間予報は、短期予報と同じ一次細分区域(class10s)コードでは無く、それより
  // 粗い単位(離島などで複数のclass10sをまとめた区域)で発表されることがある。
  // その場合はcodeが完全一致せず該当なし(=天気・気温が全部空欄)になってしまう
  // ため、一致しなければその予報区の代表区域(areas[0])にフォールバックする。
  // 気温側(amedasコード)も同様。
  const weatherArea = weatherSeries.areas.find(a => a.area?.code === class10Code) || weatherSeries.areas[0];
  const tempSeries = weekly?.timeSeries?.[1];
  const tempArea = tempSeries?.areas?.find(a => a.area?.code === amedasCode) || tempSeries?.areas?.[0] || null;
  const timeDefines = weatherSeries.timeDefines || [];

  return timeDefines.map((date, i) => {
    const codeRaw = weatherArea?.weatherCodes?.[i];
    const weatherCode = codeRaw && codeRaw !== "" ? codeRaw : null;
    const popRaw = weatherArea?.pops?.[i];
    const pop = popRaw && popRaw !== "" ? Number(popRaw) : null;
    const minRaw = tempArea?.tempsMin?.[i];
    const maxRaw = tempArea?.tempsMax?.[i];
    return {
      date,
      weatherCode,
      telop: weatherCode != null ? weatherTelop(weatherCode) : null,
      pop,
      tempMin: minRaw && minRaw !== "" ? Number(minRaw) : null,
      tempMax: maxRaw && maxRaw !== "" ? Number(maxRaw) : null,
    };
  });
}


// 緯度経度→今日の天気予報、までを一気通貫でまとめて行う。
export async function fetchCurrentLocationForecast(lat, lon) {
  const resolved = await resolveForecastLocation(lat, lon);
  if (!resolved) throw new Error("最寄りの予報地点を特定できませんでした");

  let result;
  try {
    result = await fetchForecastForResolvedLocation(resolved);
  } catch (err) {
    // 市区町村の行政区分から解決したofficeCode/class10Codeで取得・解析できな
    // かった場合(奄美市など、行政区分の階層とforecast.json側の区域コードの
    // 対応がうまく取れない離島地域で起こりうる)、行政区分を無視して「単純に
    // 一番近いアメダス観測点」から素直に求め直すフォールバックを1回だけ試す。
    console.warn("行政区分ベースの予報取得に失敗。距離ベースの推定に切り替えます:", err);
    const fallbackResolved = await resolveForecastLocation(lat, lon, { ignoreMunicipality: true });
    if (!fallbackResolved) throw err;
    result = await fetchForecastForResolvedLocation(fallbackResolved);
  }
  return result;
}


async function fetchForecastForResolvedLocation(resolved) {
  const res = await fetch(forecastDataUrl(resolveForecastFetchOfficeCode(resolved.officeCode)));
  if (!res.ok) throw new Error(`天気予報の取得に失敗(HTTP ${res.status})`);
  const json = await res.json();
  const forecast = extractTodayForecast(json, resolved.class10Code, resolved.amedasCode);
  const daily = extractDailyForecasts(json, resolved.class10Code, resolved.amedasCode);
  if (!forecast && daily.length === 0) throw new Error("天気予報データを解析できませんでした");
  // 週間予報の1日目(今日)は6時間ごとの詳しい値を持つ短期予報側の値で上書きする
  // (降水確率・気温の精度が高いため)。
  if (daily.length > 0 && forecast) {
    daily[0] = {
      ...daily[0],
      weatherCode: forecast.weatherCode ?? daily[0].weatherCode,
      telop: forecast.telop ?? daily[0].telop,
      pop: forecast.pop ?? daily[0].pop,
      tempMin: forecast.tempMin ?? daily[0].tempMin,
      tempMax: forecast.tempMax ?? daily[0].tempMax,
    };
  }
  return {
    ...(forecast || daily[0] || {}),
    areaName: forecast?.areaName || resolved.stationName,
    stationName: resolved.stationName,
    officeCode: resolved.officeCode,
    class10Code: resolved.class10Code,
    daily,
  };
}


// 地域時系列予報(3時間ごとの天気・風、気温)。天気予報ページ下部の「地域時系列
// 予報を見る」に対応するjmatile版データで、一次細分区域(class10s)コード単位。
// 参考: https://qiita.com/tenpoul/items/f9e026597fcf8405680f
function areaTimeSeriesUrl(class10Code) {
  return `https://www.jma.go.jp/bosai/jmatile/data/wdist/VPFD/${class10Code}.json`;
}

// areaTimeSeries(天気・風、3時間ごと)とpointTimeSeries(気温、代表地点の1時間毎+
// 別立ての最高/最低)は、時刻の刻み方も配列の長さも違う。dateTime文字列をキーに
// 突き合わせて、時刻ごとに{天気・風・気温}をまとめた1本の配列にする。
function parseAreaTimeSeries(json) {
  const area = json?.areaTimeSeries;
  if (!area?.timeDefines) return [];
  const tempByTime = {};
  const point = json?.pointTimeSeries;
  if (point?.timeDefines) {
    point.timeDefines.forEach((td, i) => {
      const raw = point.temperature?.[i];
      tempByTime[td.dateTime] = raw != null && raw !== "" ? Number(raw) : null;
    });
  }
  return area.timeDefines.map((td, i) => {
    const weather = area.weather?.[i] || null;
    return {
      dateTime: td.dateTime,
      weather,
      weatherCode: weatherTextToCode(weather),
      wind: area.wind?.[i] || null,
      temperature: tempByTime[td.dateTime] ?? null,
    };
  });
}

export async function fetchAreaTimeSeries(class10Code) {
  const res = await fetch(areaTimeSeriesUrl(class10Code));
  if (!res.ok) throw new Error(`地域時系列予報の取得に失敗(HTTP ${res.status})`);
  const json = await res.json();
  const entries = parseAreaTimeSeries(json);
  return { entries, pointName: json?.pointTimeSeries?.pointNameJP || null };
}


export async function fetchTideStations() {
  const res = await fetch(TIDE_AREA_URL);
  if (!res.ok) throw new Error(`潮位観測点一覧の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  const stations = [];
  Object.values(data || {}).forEach(class20 => {
    (class20.class30s || []).forEach(class30 => {
      (class30.stations || []).forEach(st => {
        if (st.lat == null || st.lon == null) return;
        stations.push({
          code: st.code,
          name: st.name,
          typeName: st.typeName,
          addr: st.addr,
          reference: st.reference,
          max: st.max || null,
          level4: class30.standard?.level4 ?? null,
          level5: class30.standard?.level5 ?? null,
          areaName: class20.name,
          class20Code: st.parents?.class20 ?? null,
          class30Code: st.parents?.class30 ?? null,
          lat: st.lat,
          lon: st.lon,
        });
      });
    });
  });
  return stations;
}


// 指定地点・指定日の観測値(15秒間隔のtide/departure配列)を取得する。
// dateStrはYYYYMMDD形式(toTideDateStr参照)。
async function fetchTideObs(dateStr, stationCode) {
  const res = await fetch(tideObsUrl(dateStr, stationCode));
  if (!res.ok) throw new Error(`潮位観測値の取得に失敗(HTTP ${res.status})`);
  return res.json();
}


// startDateの暦日〜endDateの暦日までの日数(両端含む)。月またぎ・時刻差は無視して
// 「YYYYMMDDが何日分あるか」だけを見る(fetchTideObsRangeのdaysにそのまま渡す用)。
export function daysBetweenDates(startDate, endDate) {
  const s = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const e = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}


// 指定地点について、当日を含む直近N日分(デフォルト2日=前日+当日)の観測値を取得し、
// 1本の連続した配列に結合する。日をまたぐ津波でも0時で表示が途切れないようにするため。
// 前日ファイルが欠測/取得失敗の場合は、当日から遡って「連続して取得できた分」だけを
// 採用する(=当日分さえ取れれば、以前と同じ1日分の挙動にフォールバックする)。
export async function fetchTideObsRange(stationCode, days = 2) {
  const today = new Date();
  const dateStrs = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dateStrs.push(toTideDateStr(d));
  }
  const settled = await Promise.allSettled(dateStrs.map(ds => fetchTideObs(ds, stationCode)));

  const ordered = [];
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i].status !== "fulfilled") break; // 途切れた時点で遡るのをやめる(古い日だけ欠測でもOK)
    ordered.unshift(settled[i].value);
  }
  if (ordered.length === 0) throw new Error("潮位観測値の取得に失敗");

  return {
    ...ordered[ordered.length - 1], // interval等のメタ情報は当日分を踏襲
    time: ordered[0].time,          // 一番古い日の開始時刻を全体の起点にする
    tide: ordered.flatMap(d => Array.isArray(d.tide) ? d.tide : []),
    departure: ordered.flatMap(d => Array.isArray(d.departure) ? d.departure : []),
  };
}


// startDate〜endDateの暦日(両端含む)について、1地点分の観測値を1日ずつ取得し、
// 1本の配列に結合する。fetchTideObsRangeは「当日を含む直近N日」専用(常に今日を
// 終端にする)なので、過去の津波情報(履歴)を選んで見る時のために、任意の過去の
// 期間を扱えるこちらを別途用意する。取得できなかった日(欠測・レート制限等)は
// 読み飛ばし、取得できた日だけを時系列順に繋げる(最大波さえ拾えれば十分なため、
// fetchTideObsRangeのように欠測で即座に打ち切ることはしない)。
export async function fetchTideObsForDateRange(stationCode, startDate, endDate) {
  const dateStrs = [];
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  while (cur.getTime() <= last.getTime()) {
    dateStrs.push(toTideDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  const settled = await Promise.allSettled(dateStrs.map(ds => fetchTideObs(ds, stationCode)));
  const ordered = settled.filter(s => s.status === "fulfilled").map(s => s.value);
  if (ordered.length === 0) throw new Error("潮位観測値の取得に失敗");

  return {
    ...ordered[ordered.length - 1],
    time: ordered[0].time,
    tide: ordered.flatMap(d => Array.isArray(d.tide) ? d.tide : []),
    departure: ordered.flatMap(d => Array.isArray(d.departure) ? d.departure : []),
  };
}


// 観測された津波の高さ(推定)を、潮位観測データから計算する。
// 気象庁の解説(https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html)の
// 「津波観測に関する情報」が示す考え方どおり、潮位の実測値から天文潮位(推算潮位)を
// 差し引いた値が津波による海面変動の高さにあたる。この値はtide_obsのdeparture配列に
// そのまま「潮位偏差」として入っている(このアプリのTideStationDetailで表示している
// ものと同じ値)ため、追加の逆算はせずdepartureをそのまま使う。
// startMs以降(=警報等の発表時刻以降)で、潮位偏差が正の値(山=海面上昇側)のうち
// 最大のものを返す。引き波による谷(負の値)は津波の「高さ」としては扱わない。
// データの終端は「取得できている最新時点まで」が自動的に上限になるため、終了時刻を
// 別途指定する必要はない。該当データ(正の値)が無ければnull。
export function computeMaxTsunamiHeightCm(obsData, startMs) {
  if (!obsData || !Array.isArray(obsData.departure) || !obsData.time) return null;
  const dayStartMs = new Date(obsData.time).getTime();
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(startMs)) return null;
  const intervalMs = (obsData.interval || 15) * 1000;
  let max = -Infinity;
  let timeMsAtMax = null;
  obsData.departure.forEach((v, i) => {
    if (v == null || v <= 0) return; // 正の値(山)のみを対象にする
    const t = dayStartMs + i * intervalMs;
    if (t < startMs) return; // 警報発表より前の値は対象外
    if (v > max) { max = v; timeMsAtMax = t; }
  });
  if (timeMsAtMax == null) return null;
  return { cm: max, timeMs: timeMsAtMax }; // cm(常に正の値)・観測時刻(エポックms)。該当データが1件も無ければnull
}



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


// 点(lat,lon)が、GeoJSONのリング(座標配列 [[lon,lat], ...])の内側にあるかどうかを
// レイキャスティング法で判定する。
function isPointInRing(lat, lon, ring) {
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


// 点(lat,lon)が、Polygon/MultiPolygonジオメトリの内側(穴を除く)にあるかどうかを判定する。
function isPointInPolygonGeometry(lat, lon, geometry) {
  if (!geometry) return false;
  const testRings = (rings) => {
    if (!rings.length || !isPointInRing(lat, lon, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (isPointInRing(lat, lon, rings[k])) return false; // 穴の内側
    }
    return true;
  };
  if (geometry.type === "Polygon") return testRings(geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some(testRings);
  return false;
}


// 細分区域(areasGeoJSON=細分区域.json)のポリゴンを実際に走査し、点(lat,lon)を
// 含む区域のcode(properties.code)を返す。名前によるあいまい照合と違い、
// 区域境界そのものに基づく判定なので、表記揺れや同名地点による誤判定が起きない。
function findAreaCodeByPoint(areasGeoJSON, lat, lon) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const feature of areasGeoJSON.features) {
    if (isPointInPolygonGeometry(lat, lon, feature.geometry)) {
      return feature.properties?.code ?? null;
    }
  }
  return null;
}


// 緊急地震速報のareas[].name(例:「神奈川県東部」「東京都２３区」)から、
// 細分区域.json(areasGeoJSON)側で同じ名前を持つfeatureのcode一覧を返す。
// EEWの地域名は気象庁の細分区域名と表記が一致することが多いため、まず完全一致を
// 試し、見つからなければ全角数字→半角などのゆらぎを吸収して再試行する。
// 該当が無ければ(=地図側に該当ポリゴンが見つからなければ)空配列を返し、
// その地域の塗りつぶしはあきらめる(誤った区域を塗るよりは安全)。
function normalizeAreaNameForMatch(name) {
  if (!name) return "";
  // 全角数字を半角に変換してから比較する(「２３区」→「23区」)
  return name.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
}

// 細分区域.jsonのfeatureを地域名で探す(完全一致優先、無ければ表記ゆれを吸収した
// あいまい一致)。同名の区域が複数のポリゴンに分かれていることがあるため、
// 該当するfeatureをすべて返す。
export function findAreaFeaturesByName(areasGeoJSON, name) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features) || !name) return [];
  const exact = areasGeoJSON.features.filter(f => f.properties?.name === name);
  if (exact.length > 0) return exact;
  const normalizedTarget = normalizeAreaNameForMatch(name);
  return areasGeoJSON.features.filter(f => normalizeAreaNameForMatch(f.properties?.name) === normalizedTarget);
}


export function findAreaCodesByName(areasGeoJSON, name) {
  return findAreaFeaturesByName(areasGeoJSON, name).map(f => f.properties?.code).filter(c => c != null);
}


// ep.json(気象庁の震央地名区域)のポリゴンを走査し、点(lat,lon)を
// 含む区域の名前(properties.name)を返す。緊急地震速報テスト配信で「地図をタップ
// して震源を指定」した時、タップ地点から震源地名を自動判定するのに使う。
// 該当する区域が無い(海洋の詳細区分に含まれない・データ範囲外など)場合はnull。
export function findEpicenterNameByPoint(epicenterNamesGeoJSON, lat, lon) {
  if (!epicenterNamesGeoJSON || !Array.isArray(epicenterNamesGeoJSON.features) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const feature of epicenterNamesGeoJSON.features) {
    if (isPointInPolygonGeometry(lat, lon, feature.geometry)) {
      return feature.properties?.name ?? null;
    }
  }
  return null;
}


// 観測点マスタ(stations)から、eqdbの観測点名(name)に対応する地点を探し、
// 区域コード(area.code)を補完する。
// eqdbは観測点の緯度経度(lat/lon)を直接返してくるため、まずareasGeoJSON(細分区域の
// ポリゴン)に対する点-in-多角形判定で区域を確定させる。これは区域境界そのものに
// 基づく判定なので、観測点名の表記揺れや同名地点があっても誤判定しない。
// (以前は観測点マスタとの名前照合だけで区域を推定しており、名前が一致しない/
//  複数の地点に一致してしまうケースで「区域が塗られない」「違う区域の色が塗られる」
//  ことがあった。)
// areasGeoJSONが無い、または該当ポリゴンが見つからない場合のみ、次点として
// 観測点マスタとの名前照合(ベストエフォート)にフォールバックする:
//   1. 地点名が完全一致
//   2. 見つからなければ、地点名が部分一致(どちらかがどちらかを含む)するもの
//   3. それでも見つからなければ、緯度経度が最も近い観測点を採用する
//      (ただしあまりに離れた地点を誤って採用しないよう、約0.05度以内という上限を設ける)
// 観測点マスタ(stations)から、eqdbの観測点名(name)に最も一致する地点を探す。
// findAreaCodeByStationNameと同じマッチング方針(名前の完全一致→部分一致→
// 緯度経度が最も近い地点、の順)を使うが、区域コードだけでなく都道府県名・
// 市区町村名も一緒に取り出したいため、マッチング処理そのものを共通化している。
//
// 【重要】eqdbの観測点名(例: "苫前町旭＊")は市区町村名から始まり、都道府県名は
// 含まれない(気象庁 震度データベースAPIの実際のレスポンスで確認済み)。
// そのため都道府県は文字列解析では判別できず、緯度経度・地点名を観測点マスタと
// 突き合わせて、マスタ側が持つpref.name(都道府県名)を借りてくる必要がある。
function findBestStationMatch(stations, name, lat, lon) {
  if (!stations || stations.length === 0) return null;

  let candidates = name ? stations.filter(s => s.name === name) : [];

  if (candidates.length === 0 && name) {
    candidates = stations.filter(s =>
      s.name.includes(name) || name.includes(s.name) ||
      (s.city && s.city.name && name.includes(s.city.name))
    );
  }

  let fellBackToAll = false;
  if (candidates.length === 0) {
    if (lat == null || lon == null) return null;
    candidates = stations;
    fellBackToAll = true;
  }

  if (candidates.length === 1) return candidates[0];
  if (lat == null || lon == null) return candidates[0] || null;

  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const cLat = parseFloat(c.lat), cLon = parseFloat(c.lon);
    if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
    const dLat = cLat - lat, dLon = cLon - lon;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  if (!best) return null;
  if (fellBackToAll) {
    const cLat = parseFloat(best.lat), cLon = parseFloat(best.lon);
    if (Math.abs(cLat - lat) > 0.05 || Math.abs(cLon - lon) > 0.05) return null;
  }
  return best;
}


function findAreaCodeByStationName(stations, name, lat, lon, areasGeoJSON) {
  const byPoint = findAreaCodeByPoint(areasGeoJSON, lat, lon);
  if (byPoint) return byPoint;

  const match = findBestStationMatch(stations, name, lat, lon);
  return match?.area?.code || null;
}


// eqdbの観測点名(name)・緯度経度から、観測点マスタ上の都道府県名・市区町村名を
// 借りてくる。マッチした市区町村名がnameの先頭に含まれていれば、見出しと
// 二重表示にならないようそこを取り除いた残りをaddrとして一緒に返す
// (例: マスタ側city.name="苫前町"、name="苫前町旭＊" → addr="旭＊")。
// マッチしなかった場合はpref/cityともnullとし、addrは元のnameのまま返す。
function resolvePrefCityForEqdbPoint(stations, name, lat, lon) {
  const match = findBestStationMatch(stations, name, lat, lon);
  const pref = match?.pref?.name || null;
  const city = match?.city?.name || null;
  let addr = name;
  if (city && name && name.startsWith(city)) {
    const rest = name.slice(city.length);
    if (rest) addr = rest;
  }
  return { pref, city, addr };
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
