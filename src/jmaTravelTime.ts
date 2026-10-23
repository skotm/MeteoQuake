/**
 * jmaTravelTime.ts
 * ------------------------------------------------------------
 * 気象庁が公開しているJMA2001走時表(震央距離×深さ→P波/S波の走時)を使った、
 * epicenterEstimation.ts向けの走時計算モジュール。
 *
 * 従来のtravelTimeMs(epicenterEstimation.ts)は「P波速度一律6.8km/s」の
 * 定速モデル(斜距離をピタゴラスの定理で求めるだけ)だったが、実際の地殻は
 * 層構造を持ち速度が深さで変わるため、特に遠方・深発では誤差が大きくなる。
 * JMA2001走時表はこの層構造を反映した気象庁の実際の震源計算でも使われて
 * いる理論走時テーブル(震央距離0〜2000km・深さ0〜700kmの2次元グリッド)。
 *
 * 【データの入手方法(このモジュール自体はデータを内包していない)】
 * 気象庁の配布ページ(https://www.data.jma.go.jp/eqev/data/bulletin/catalog/
 * appendix/trtime/trt_j.html)から tjma2001.zip をダウンロードし、
 * scripts/build-jma-travel-time.mjs で変換した public/jma-travel-time.json
 * を、App起動時にfetchしてsetJmaTravelTimeTable()に渡す想定
 * (App.tsx側の配線は別途必要。詳細はスクリプトのコメント参照)。
 * テーブルが読み込まれていない間は、travelTimeMs側が自動的に従来の
 * 定速モデルにフォールバックするため、このデータファイルが無くても
 * アプリ自体は(精度は従来通りのまま)問題なく動作する。
 *
 * 【走時表フォーマット(気象庁公式仕様)】
 * 1行が1つの(深さ, 震央距離)の組に対応し、以下の固定長フィールドを持つ
 * (01: 相名P, 03-10: P波走時(秒), 12: 相名S, 14-21: S波走時(秒),
 *  23-25: 深さ(km), 28-32: 震央距離(km))。連続する空白を1つに詰めてから
 *  空白区切りで分割すると ["P", <P走時>, "S", <S走時>, <深さ>, <震央距離>]
 *  の6要素になる。
 *
 * 【グリッド間隔(気象庁公式仕様)】
 * 震央距離: 0〜50kmは2km刻み、50〜200kmは5km刻み、200〜2000kmは10km刻み。
 * 深さ: 0〜50kmは2km刻み、50〜200kmは5km刻み、200〜700kmは10km刻み。
 * 間隔が一様でないため、単純な配列インデックス計算ではなく、実際の
 * グリッド値の配列に対する二分探索+線形補間(二次元なので双線形補間)で
 * 値を求める。
 */

export interface JmaTravelTimeTable {
  distances: number[]; // 昇順、km
  depths: number[]; // 昇順、km
  // 行優先(depths.length × distances.length)。値が無い(表の穴)場所はNaN。
  pTimesSec: Float32Array;
  sTimesSec: Float32Array;
}

export interface JmaTravelTimeResult {
  pTimeSec: number;
  sTimeSec: number | null; // 表の穴等でS波だけ欠けている場合はnull
}

/**
 * 気象庁配布のtjma2001ファイル(zipを展開した生テキスト)をパースする。
 * scripts/build-jma-travel-time.mjs から呼び出す想定(ビルド時の1回きりの
 * 変換用)だが、実行時に生テキストを直接読み込みたい場合にも使えるよう
 * ここに置いてある。
 */
export function parseJmaTravelTimeTable(text: string): JmaTravelTimeTable {
  const distanceSet = new Set<number>();
  const depthSet = new Set<number>();
  const rows: { depth: number; distance: number; p: number; s: number }[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.replace(/\s+/g, " ").split(" ");
    if (parts.length < 6) continue;
    const p = parseFloat(parts[1]);
    const s = parseFloat(parts[3]);
    const depth = parseInt(parts[4], 10);
    const distance = parseInt(parts[5], 10);
    if (!Number.isFinite(p) || !Number.isFinite(depth) || !Number.isFinite(distance)) continue;
    rows.push({ depth, distance, p, s: Number.isFinite(s) ? s : NaN });
    distanceSet.add(distance);
    depthSet.add(depth);
  }

  const distances = [...distanceSet].sort((a, b) => a - b);
  const depths = [...depthSet].sort((a, b) => a - b);
  const distIndex = new Map(distances.map((d, i) => [d, i]));
  const depthIndex = new Map(depths.map((d, i) => [d, i]));

  const pTimesSec = new Float32Array(depths.length * distances.length).fill(NaN);
  const sTimesSec = new Float32Array(depths.length * distances.length).fill(NaN);
  for (const row of rows) {
    const di = depthIndex.get(row.depth);
    const xi = distIndex.get(row.distance);
    if (di == null || xi == null) continue;
    const idx = di * distances.length + xi;
    pTimesSec[idx] = row.p;
    sTimesSec[idx] = row.s;
  }

  return { distances, depths, pTimesSec, sTimesSec };
}

// value(v)を挟む配列arrの隣接インデックス[lo, hi]と、その区間内での
// 線形補間係数t(0〜1)を返す。範囲外はクランプする(lo=hi=端、t=0)。
function bracket(arr: number[], v: number): [number, number, number] {
  const n = arr.length;
  if (n === 0) return [0, 0, 0];
  if (v <= arr[0]) return [0, 0, 0];
  if (v >= arr[n - 1]) return [n - 1, n - 1, 0];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid;
  }
  const span = arr[hi] - arr[lo];
  const t = span > 0 ? (v - arr[lo]) / span : 0;
  return [lo, hi, t];
}

/**
 * (震央距離km, 深さkm)から、双線形補間でP波・S波の走時(秒)を求める。
 * tableがnull、または補間に必要な4隅のいずれかが表の穴(NaN)の場合はnullを
 * 返す(呼び出し側で従来の定速モデルにフォールバックする)。
 */
export function lookupJmaTravelTime(
  table: JmaTravelTimeTable | null,
  distanceKm: number,
  depthKm: number
): JmaTravelTimeResult | null {
  if (!table || table.distances.length === 0 || table.depths.length === 0) return null;
  const { distances, depths, pTimesSec, sTimesSec } = table;
  const [xLo, xHi, tx] = bracket(distances, distanceKm);
  const [dLo, dHi, td] = bracket(depths, depthKm);
  const nx = distances.length;
  const idx = (di: number, xi: number) => di * nx + xi;

  function bilerp(arr: Float32Array): number | null {
    const v00 = arr[idx(dLo, xLo)];
    const v01 = arr[idx(dLo, xHi)];
    const v10 = arr[idx(dHi, xLo)];
    const v11 = arr[idx(dHi, xHi)];
    if (!Number.isFinite(v00) || !Number.isFinite(v01) || !Number.isFinite(v10) || !Number.isFinite(v11)) return null;
    const top = v00 + (v01 - v00) * tx;
    const bottom = v10 + (v11 - v10) * tx;
    return top + (bottom - top) * td;
  }

  const pTimeSec = bilerp(pTimesSec);
  if (pTimeSec == null) return null;
  const sTimeSec = bilerp(sTimesSec);
  return { pTimeSec, sTimeSec };
}

// 実行中のアプリ全体で共有する、読み込み済みテーブル(モジュール変数)。
// App起動時に一度だけpublic/配下のJSONをfetchしてsetJmaTravelTimeTable()を
// 呼ぶ想定(詳細はscripts/build-jma-travel-time.mjsのコメント参照)。
let currentTable: JmaTravelTimeTable | null = null;

export function setJmaTravelTimeTable(table: JmaTravelTimeTable | null) {
  currentTable = table;
}

export function getJmaTravelTimeTable(): JmaTravelTimeTable | null {
  return currentTable;
}

// fetchしたJSON(distances, depths, pTimesSec, sTimesSecを普通の配列として
// 持つ)を、Float32Arrayを使う内部形式に変換する。App.tsx側のfetch処理から
// 呼ぶ想定。
export function tableFromJSON(json: {
  distances: number[];
  depths: number[];
  pTimesSec: number[];
  sTimesSec: number[];
}): JmaTravelTimeTable {
  return {
    distances: json.distances,
    depths: json.depths,
    pTimesSec: Float32Array.from(json.pTimesSec),
    sTimesSec: Float32Array.from(json.sTimesSec),
  };
}
