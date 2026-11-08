/**
 * spatialIndex.ts
 * ------------------------------------------------------------
 * 観測点の近傍探索用の、格子(グリッド)方式の空間インデックス。
 *
 * 「半径R km以内の観測点」を探す時、全観測点との距離を計算する(総当たり、O(N²))代わりに、緯度経度を
 * 一定の大きさの格子に区切って、観測点を格子ごとに保管しておく。検索では、検索点の周りの格子に入っている
 * 観測点だけを、候補として返す。候補は、半径に入ることが「保証されない」(格子の角などの余計な点を含む)
 * ので、呼び出し側が、これまでどおり実際の距離を計算して、半径で絞り込む。ただし、半径内にある観測点が
 * 候補から漏れることは無い(漏れないように、格子の大きさと検索範囲を、安全側に見積もる)。
 *
 * 返す候補は、元の配列の添字の昇順。呼び出し側が、総当たりの時と同じ順序で処理できる(距離が同じ観測点の
 * 並び順が変わらない)ようにするため。
 *
 * 格子で安全に扱えない場合(緯度が極に近い・日付変更線をまたぐ・座標が不正)は、全観測点を候補として返す
 * (総当たりと同じ結果になる)。
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface GridIndex {
  /** (lat, lon)から半径radiusKm以内にある観測点を、必ず含む候補の添字(昇順)。 */
  query(lat: number, lon: number, radiusKm: number): number[];
}

// 緯度1度の長さ(km)の下限。実際は約111.19km。格子と検索範囲を「度」に換算する時、これより小さい値で
// kmを割ると、度が大きめに見積もられ(安全側)、半径内の観測点を取りこぼさない。
const KM_PER_DEG_LAT_MIN = 110;
// 緯度がこれ以上(検索範囲の端)の場合は、経度方向の長さが極端に縮むので、格子を使わない。
const MAX_SAFE_ABS_LAT_DEG = 85;

export function buildGridIndex(points: GeoPoint[], cellKm: number): GridIndex {
  const cellDeg = Math.max(cellKm, 1) / KM_PER_DEG_LAT_MIN;
  const cells = new Map<number, number[]>();
  // 座標が有限でない観測点は、格子に入れられない。総当たりでは「距離がNaNなので半径で除外されない」
  // 扱いになるため、同じ結果になるよう、常に候補に含める。
  const wild: number[] = [];
  const keyOf = (ci: number, cj: number) => (ci + 100000) * 1_000_000 + (cj + 100000);
  for (let i = 0; i < points.length; i++) {
    const { lat, lon } = points[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { wild.push(i); continue; }
    const key = keyOf(Math.floor(lat / cellDeg), Math.floor(lon / cellDeg));
    const list = cells.get(key);
    if (list) list.push(i); else cells.set(key, [i]);
  }
  const all = points.map((_, i) => i);

  return {
    query(lat: number, lon: number, radiusKm: number): number[] {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusKm)) return all;
      const dLat = radiusKm / KM_PER_DEG_LAT_MIN;
      const latHi = Math.min(Math.abs(lat) + dLat, 89.9);
      if (latHi >= MAX_SAFE_ABS_LAT_DEG) return all;
      const dLon = radiusKm / (KM_PER_DEG_LAT_MIN * Math.cos((latHi * Math.PI) / 180));
      if (lon - dLon < -180 || lon + dLon > 180) return all;
      const i0 = Math.floor((lat - dLat) / cellDeg), i1 = Math.floor((lat + dLat) / cellDeg);
      const j0 = Math.floor((lon - dLon) / cellDeg), j1 = Math.floor((lon + dLon) / cellDeg);
      const out: number[] = wild.length ? [...wild] : [];
      for (let ci = i0; ci <= i1; ci++) {
        for (let cj = j0; cj <= j1; cj++) {
          const list = cells.get(keyOf(ci, cj));
          if (list) for (const idx of list) out.push(idx);
        }
      }
      out.sort((a, b) => a - b);
      return out;
    },
  };
}
