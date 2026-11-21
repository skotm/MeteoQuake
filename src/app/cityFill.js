/* ─────────────────────────────────────────────────────
   市区町村単位の震度塗りつぶし(ズームを上げた時に、細分区域塗りから切り替わる)。

   地図のポリゴンは warning_areas.json(気象庁の警報等の発表区域。市区町村単位、1,821件)を使う。
   観測点マスタ(stations)の市区町村コードとは、次の点で一致しないため、対応表を作って結びつける:
     ・一致するコードがある(大半)            → そのポリゴン1枚
     ・1つの市が複数のポリゴンに分割されている → 上5桁が同じポリゴンすべて(例: 富山市 1620100 → 1620111〜13)
     ・政令指定都市の「区」                  → 親の市のポリゴン(例: 横浜鶴見区 1410100 → 横浜市 1410011/12)
                                                  区のコードは「県2桁+市1桁+区2桁」で、親は「上3桁+00」で始まる
   政令市の区は区ごとの形状データが無いため、市単位(の最大震度)で塗られる。
   ───────────────────────────────────────────────────── */

const INTENSITY_ORDER = ["0", "1", "2", "3", "4", "5", "5-", "5u", "5+", "6", "6-", "6+", "7"];

/** warning_areas.json(GeoJSON FeatureCollection)から、対応づけ用の索引と、地図用の軽量GeoJSONを作る。 */
export function buildCityFillData(rawGeoJson) {
  const exact = new Set();
  const byPrefix5 = new Map(); // 上5桁 → コード[]
  const features = [];
  for (const f of rawGeoJson?.features || []) {
    const code = f?.properties?.regioncode;
    if (!code || !f.geometry) continue; // コードが無いもの(離島・埋立地など)は塗り分けの対象外
    exact.add(code);
    const p5 = code.slice(0, 5);
    if (!byPrefix5.has(p5)) byPrefix5.set(p5, []);
    byPrefix5.get(p5).push(code);
    // 地図に載せるのはコードと形だけ(余分なプロパティを持たせず、メモリを抑える)
    features.push({ type: "Feature", properties: { regioncode: code }, geometry: f.geometry });
  }
  return { index: { exact, byPrefix5, cache: new Map() }, collection: { type: "FeatureCollection", features } };
}

/** 観測点の市区町村コード(7桁)・市区町村名から、塗るポリゴンのコード配列を返す(無ければ空配列)。 */
export function resolveCityPolygonCodes(index, cityCode, cityName) {
  if (!cityCode) return [];
  const key = `${cityCode}|${cityName || ""}`;
  const cached = index.cache.get(key);
  if (cached) return cached;
  let result = [];
  if (index.exact.has(cityCode)) {
    result = [cityCode];
  } else if (index.byPrefix5.has(cityCode.slice(0, 5))) {
    result = index.byPrefix5.get(cityCode.slice(0, 5));
  } else if (cityName && cityName.endsWith("区")) {
    // 政令市の区 → 親の市(上3桁+"00")
    const parent = index.byPrefix5.get(`${cityCode.slice(0, 3)}00`);
    if (parent) result = parent;
  }
  index.cache.set(key, result);
  return result;
}

/** 解決済みの観測点から、ポリゴンコードごとの最大震度キーを集計する(区域単位の点=isAreaは対象外)。 */
export function aggregateByCity(resolvedPoints, index) {
  const maxByCity = new Map(); // ポリゴンコード → 震度キー
  for (const p of resolvedPoints || []) {
    if (p.isArea || !p.cityCode) continue;
    const order = INTENSITY_ORDER.indexOf(p.intensityKey);
    if (order < 0) continue;
    for (const code of resolveCityPolygonCodes(index, p.cityCode, p.city)) {
      const cur = maxByCity.get(code);
      if (!cur || order > INTENSITY_ORDER.indexOf(cur)) maxByCity.set(code, p.intensityKey);
    }
  }
  return maxByCity;
}

/** 切り替えズーム z の前後 ±0.4 で、細分区域塗り→市区町村塗りへ重なりながら切り替えるための式。 */
export const CITY_FILL_CROSSFADE = 0.4;
export function cityFillOpacityExpr(zoom, showCity, opacity) {
  const lo = Math.max(0, zoom - CITY_FILL_CROSSFADE);
  const hi = zoom + CITY_FILL_CROSSFADE;
  return showCity
    ? ["interpolate", ["linear"], ["zoom"], lo, 0, hi, opacity]
    : ["interpolate", ["linear"], ["zoom"], lo, opacity, hi, 0];
}
