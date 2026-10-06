import { QUAKE_FETCH_LIMIT_DEFAULT, clampQuakeFetchLimit } from "../settings/prefs.js";
import { P2PQUAKE_HISTORY_URL_BASE, dedupeQuakeList, toQuakeCard } from "./p2p.js";

/* ─────────────────────────────────────────────────────
   気象庁 推計震度分布(estimated_intensity_map) 連携
   震度5弱以上の地震選択時、気象庁が発表する250mメッシュの推計震度分布画像を
   地図上に重ねて表示する。過去に別アプリ(index.html版)で実装済みのロジックを
   MapLibre GL JS向けに移植したもの。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_LIST_URL = "https://www.jma.go.jp/bosai/estimated_intensity_map/data/list.json";

// 一覧データの発生時刻とP2P地震情報側の発生時刻がぴったり一致しないことがあるため、
// 差がこの範囲内(1分以内)なら同じ地震とみなす。
const EST_INTENSITY_MATCH_TOLERANCE_MS = 60 * 1000;

// この震度分布は震度5弱以上の地震でのみ気象庁から発表される。
export const EST_INTENSITY_MIN_INTENSITY_KEYS = ["5-", "5+", "6-", "6+", "7"];


// 気象庁の1次地域メッシュコード(4桁)から、画像を貼り付ける緯度経度範囲(矩形)を計算する。
// 上2桁が緯度方向・下2桁が経度方向のメッシュ番号で、1次メッシュは緯度2/3度×経度1度。
export function meshCodeToBounds(meshCode) {
  const latStart = parseInt(meshCode.substring(0, 2), 10) / 1.5;
  const lonStart = parseInt(meshCode.substring(2, 4), 10) + 100;
  const latEnd = latStart + 2 / 3;
  const lonEnd = lonStart + 1;
  return { latStart, lonStart, latEnd, lonEnd };
}


// 選択中の地震の発生時刻・最大震度から、該当する推計震度分布データを検索する。
// 対象外(震度5弱未満)・該当データなし・取得失敗の場合はnullを返す
// (呼び出し側では「表示しない」扱いにするだけで、エラー扱いにはしない)。
export async function fetchEstimatedIntensityMatch(quakeTimeStr, maxIntensityKey) {
  if (!EST_INTENSITY_MIN_INTENSITY_KEYS.includes(maxIntensityKey)) return null;
  if (!quakeTimeStr) return null;

  const targetTimeMs = new Date(quakeTimeStr).getTime();
  if (Number.isNaN(targetTimeMs)) return null;

  const res = await fetch(EST_INTENSITY_LIST_URL);
  if (!res.ok) throw new Error(`推計震度分布一覧の取得に失敗しました (${res.status})`);
  const list = await res.json();
  if (!Array.isArray(list)) return null;

  for (const item of list) {
    const at = item?.hypo?.at;
    if (!at) continue;
    const itemTimeMs = new Date(at).getTime();
    if (Number.isNaN(itemTimeMs)) continue;
    if (Math.abs(itemTimeMs - targetTimeMs) <= EST_INTENSITY_MATCH_TOLERANCE_MS) {
      if (Array.isArray(item.mesh_num) && item.url) return item;
      return null;
    }
  }
  return null;
}


/* ─────────────────────────────────────────────────────
   推計震度分布 画像 → ベクター(GeoJSON)変換
   参考: 【気象庁HP】推計震度分布図のGeoJSONデータを無料で取得したい！！
         https://qiita.com/ZeroQuake/items/e6dd2691fe8fa5e2b3b2
   気象庁の画像(800×800px)は250mメッシュ(1メッシュ=2.5px)を表現しているため、
   拡大するとアンチエイリアスで境界がぼやける。ズームしても輪郭が鮮明なままになるよう、
   画像を1度だけピクセル解析し、320×320の格子(メッシュ)ごとに震度階級を判定して
   ポリゴン(塗り)・境界線(隣接メッシュと震度階級が異なる辺のみ)に変換する。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_GRID_SIZE = 320;


// 気象庁の公式配色(推計震度分布画像で使われている色)と震度階級の対応。
// 画像は圧縮等で色が微妙にずれることがあるため、RGB各値の差分16未満を許容して判定する
// (元記事の閾値をそのまま採用)。
const EST_INTENSITY_COLOR_TABLE = [
  { key: "4",  r: 250, g: 230, b: 150 },
  { key: "5-", r: 255, g: 230, b: 0   },
  { key: "5+", r: 255, g: 153, b: 0   },
  { key: "6-", r: 255, g: 40,  b: 0   },
  { key: "6+", r: 165, g: 0,   b: 33  },
  { key: "7",  r: 180, g: 0,   b: 104 },
];


// ピクセルの色から、最も近い震度階級を選ぶ(周囲から推測するのではなく、
// あくまでそのピクセル自身の色を根拠にする)。
// 境界(色の変わり目)は元画像でアンチエイリアスがかかっており、6色のどれとも
// 「ぴったり一致」しない中間色になっていることがある。以前は許容誤差(閾値)を
// 決めて外れたものを「データなし」にしていたが、それだと本来は震度が付いている
// はずのメッシュまで欠落して見えてしまう。実際にはその中間色は隣り合う2つの
// 震度色のどちらかに近いはずなので、6色のうち最も色が近いものを選ぶ方が、
// 周囲のメッシュから推測するよりも本来のデータに忠実。
function classifyEstIntensityColor(r, g, b, a) {
  if (a <= 50) return null; // 透明(=本当にデータが無い場所)
  let best = null;
  let bestDist = Infinity;
  for (const c of EST_INTENSITY_COLOR_TABLE) {
    const dist = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (dist < bestDist) { bestDist = dist; best = c.key; }
  }
  return best;
}


// 画像を読み込む。getImageData()でピクセルを読み取るため、crossOriginを明示的に指定し、
// キャンバスが「汚染」されて読み取り不能にならないようにする。
export function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像の読み込みに失敗しました: ${url}`));
    img.src = url;
  });
}


// 気象庁の1次地域メッシュコードから、東隣・北隣など指定方向に1つずれたメッシュコードを計算する。
// (上2桁=緯度方向のメッシュ番号、下2桁=経度方向のメッシュ番号。それぞれ±1が隣接メッシュにあたる)
// 範囲外(0〜99を超える)になる場合はnullを返す。
export function offsetMeshCode(meshCode, dLatCode, dLonCode) {
  const latCode = parseInt(meshCode.substring(0, 2), 10) + dLatCode;
  const lonCode = parseInt(meshCode.substring(2, 4), 10) + dLonCode;
  if (latCode < 0 || latCode > 99 || lonCode < 0 || lonCode > 99) return null;
  return String(latCode).padStart(2, "0") + String(lonCode).padStart(2, "0");
}


// 1枚の推計震度分布画像(1次メッシュ分)を、250mメッシュ単位の格子(320×320、
// grid[i][j] = 震度キー or 該当なしはnull)に分解する。
export function buildEstIntensityGridFromImage(img) {
  const GRID = EST_INTENSITY_GRID_SIZE;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 800;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, 800, 800);
  // クロスオリジンで汚染されたcanvasの場合、ここでSecurityErrorが投げられる
  // (呼び出し側でtry/catchして「表示しない」扱いにフォールバックする)。
  const imgData = ctx.getImageData(0, 0, 800, 800).data;

  // アンチエイリアスの影響を受けない「元の色を完全に反映するピクセル」だけを
  // 参照する(x: 5n+1,5n+3 / y: 5m+1,5m+4 のパターンで交互に2px・3pxずつ進む)。
  const grid = Array.from({ length: GRID }, () => new Array(GRID).fill(null));
  let y = 1;
  for (let i = 0; i < GRID; i++) {
    let x = 1;
    for (let j = 0; j < GRID; j++) {
      const idx = (y * 800 + x) * 4;
      grid[i][j] = classifyEstIntensityColor(
        imgData[idx], imgData[idx + 1], imgData[idx + 2], imgData[idx + 3]
      );
      x += (j % 2 === 0) ? 3 : 2;
    }
    y += (i % 2 === 0) ? 2 : 3;
  }
  return grid;
}


// 250mメッシュの格子(grid)から塗り用ポリゴンを作る。
// 同じ震度階級が隣接するメッシュを1枚の四角形にまとめる(矩形統合)ことで、
// 250mメッシュ1枚ごとにポリゴンを作った場合(広い震度5弱の範囲などで数万枚になり、
// MapLibre側の描画処理が重くフリーズの原因になる)と比べ、ポリゴン数を大幅に減らす。
// 同じ色のポリゴン同士が隣接する境目にGPU描画特有の細い隙間が出る問題もあわせて解消する。
export function buildEstIntensityFillFeatures(grid, meshBounds) {
  const { latStart: lat, lonStart: lng, latEnd: lat2, lonEnd: lng2 } = meshBounds;
  const GRID = EST_INTENSITY_GRID_SIZE;

  const rectangles = mergeGridIntoRectangles(grid, GRID);
  return rectangles.map(rect => {
    const North = lat2 + ((lat - lat2) / GRID) * rect.i0;
    const South = lat2 + ((lat - lat2) / GRID) * (rect.i1 + 1);
    const West = lng + ((lng2 - lng) / GRID) * rect.j0;
    const East = lng + ((lng2 - lng) / GRID) * (rect.j1 + 1);
    return {
      type: "Feature",
      properties: { intensity: rect.intensity },
      geometry: {
        type: "Polygon",
        coordinates: [[[West, North], [East, North], [East, South], [West, South], [West, North]]],
      },
    };
  });
}


// 250mメッシュの格子(grid)から、震度階級が変わる境目だけの線分を作る。
// 1次メッシュ画像は複数枚(mesh_num)を並べて1つの地震の範囲を表すため、画像の端(=1次メッシュの
// 継ぎ目)をそのまま「データなし」として扱うと、実際は同じ震度が続いているだけの場所にも
// 誤って境界線を引いてしまう(隣の画像との継ぎ目に黒い線が入って見える不具合の原因)。
// これを避けるため、東隣・南隣のメッシュの格子(あれば)を渡してもらい、画像の端では
// そちらの値を参照して判定する。
//
// 境界線は2種類に分けて返す。
// ・outerCoords: 色が付いた範囲と「データなし(=地図の背景)」との境目。
//   暗い地図の背景に対して黒線だと見えにくいため、呼び出し側で白線にする。
// ・innerCoords: 震度階級同士(4と5-など)の境目。両側とも明るい色なので、
//   今まで通り黒線のままでよい。
export function buildEstIntensityLineCoords(grid, meshBounds, neighborGrids = {}) {
  const { latStart: lat, lonStart: lng, latEnd: lat2, lonEnd: lng2 } = meshBounds;
  const GRID = EST_INTENSITY_GRID_SIZE;
  const { eastGrid, southGrid } = neighborGrids;

  const outerCoords = [];
  const innerCoords = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const intensity = grid[i][j];
      if (!intensity) continue;

      const North = lat2 + ((lat - lat2) / GRID) * i;
      const South = lat2 + ((lat - lat2) / GRID) * (i + 1);
      const West = lng + ((lng2 - lng) / GRID) * j;
      const East = lng + ((lng2 - lng) / GRID) * (j + 1);

      // 右隣: 同じ画像内ならgrid[i][j+1]、画像の右端(j+1がGRID)なら東隣メッシュの
      // 同じ行・左端(列0)を参照する(東隣メッシュが無ければ本当にデータなし=null)。
      const rightIntensity = j + 1 < GRID ? grid[i][j + 1] : (eastGrid ? eastGrid[i][0] : null);
      if (rightIntensity !== intensity) {
        (rightIntensity ? innerCoords : outerCoords).push([[East, North], [East, South]]);
      }
      // 下隣: 同じ画像内ならgrid[i+1][j]、画像の下端(i+1がGRID)なら南隣メッシュの
      // 同じ列・上端(行0)を参照する(南隣メッシュが無ければ本当にデータなし=null)。
      const bottomIntensity = i + 1 < GRID ? grid[i + 1][j] : (southGrid ? southGrid[0][j] : null);
      if (bottomIntensity !== intensity) {
        (bottomIntensity ? innerCoords : outerCoords).push([[West, South], [East, South]]);
      }
    }
  }
  return { outerCoords, innerCoords };
}


// 格子(grid[i][j] = 震度キー or null)を、同じ震度階級が連続する矩形の集まりに変換する。
// 手順: ① 各行ごとに横方向へ連続する同じ値をひとまとめの区間(ラン)にする
//       ② 上の行から縦方向に伸ばせる区間(j0・j1・intensityが完全一致)は1つの矩形として延長し、
//          伸ばせなくなった時点で確定させる
// (震源付近のような大きな塊はこれでほぼ1枚〜数枚の矩形にまとまり、ポリゴン数が劇的に減る)
function mergeGridIntoRectangles(grid, GRID) {
  const finished = [];
  let openRects = []; // 直前の行まで伸びている矩形: { j0, j1, intensity, i0, i1 }

  for (let i = 0; i < GRID; i++) {
    // この行の横方向のラン(連続区間)を作る
    const runs = [];
    let j = 0;
    while (j < GRID) {
      const intensity = grid[i][j];
      if (!intensity) { j++; continue; }
      let j1 = j;
      while (j1 + 1 < GRID && grid[i][j1 + 1] === intensity) j1++;
      runs.push({ j0: j, j1, intensity });
      j = j1 + 1;
    }

    const nextOpenRects = [];
    for (const run of runs) {
      // 直前の行で同じ範囲・同じ震度階級の矩形が伸びてきていれば、そのまま延長する
      const match = openRects.find(r => r.j0 === run.j0 && r.j1 === run.j1 && r.intensity === run.intensity && r.i1 === i - 1);
      if (match) {
        match.i1 = i;
        nextOpenRects.push(match);
      } else {
        nextOpenRects.push({ j0: run.j0, j1: run.j1, intensity: run.intensity, i0: i, i1: i });
      }
    }

    // 今回延長されなかった(=これ以上下に続かない)矩形は確定させる
    for (const r of openRects) {
      if (!nextOpenRects.includes(r)) finished.push(r);
    }
    openRects = nextOpenRects;
  }
  finished.push(...openRects); // 最後の行まで伸びていた分を確定させる

  return finished;
}


// 現在の震度配色スキームから、MapLibreの"fill-color"に使うmatch式を組み立てる。
// (推計震度分布も、他の震度表示と同じアプリ内配色に合わせて塗るため)
export function buildEstIntensityFillColorExpr(colorScheme) {
  const expr = ["match", ["get", "intensity"]];
  for (const c of EST_INTENSITY_COLOR_TABLE) {
    expr.push(c.key, (colorScheme.colors[c.key] || colorScheme.colors["0"]).bg);
  }
  expr.push("rgba(0,0,0,0)"); // 該当なし(通常は発生しない)
  return expr;
}


// 震央分布(circleレイヤー)の色分けに使う、震度キーの全パターン。
// "5"/"6"(弱/強の区分が無い旧震度階級)も含める。QUAKE_COLOR_SCHEMESの各配色は
// これらを既にスキーム内の色(5弱/6弱と同じ色)として持っているため、そのまま
// 拾えば「今ある配色に従う」ことになる。
const QUAKE_INTENSITY_KEYS = ["0", "1", "2", "3", "4", "5", "5-", "5+", "6", "6-", "6+", "7", "?"];


// 震央分布を「最大震度が大きいものほど上(=後から描画)」にするための重み。
// 数字が大きいほど後で描画される=他の丸に重なった時に上に来る。
// "5"/"6"(旧震度階級)は、実際の強さとしては5弱/6弱相当なのでそこに合わせておく。
// "?"(不明)は最も弱い扱いにする。
export const QUAKE_INTENSITY_RANK = {
  "?": -1, "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
  "5": 5, "5-": 5, "5+": 6, "6": 7, "6-": 7, "6+": 8, "7": 9,
};


// 現在の震度配色スキームから、震央分布(circle-color)の塗り用match式を組み立てる。
// P2P地震一覧・近傍地震検索・データベース検索、どの震央分布も同じ配色ルールで塗る。
export function buildEpicenterCircleColorExpr(colorScheme) {
  const expr = ["match", ["get", "scaleKey"]];
  for (const key of QUAKE_INTENSITY_KEYS) {
    expr.push(key, (colorScheme.colors[key] || colorScheme.colors["0"]).bg);
  }
  expr.push((colorScheme.colors["?"] || colorScheme.colors["0"]).bg);
  return expr;
}


// 震央分布(circle-stroke-color)用のmatch式。基本は塗りと同じ色だが、
// 気象庁配色の震度1はほぼ白(#F2F2FF)のため、塗りと同色の縁だとライトモードの
// (白系の)地図に溶け込んでしまう。ライトモードの時だけ縁を薄いグレーにする
// (ダークモードは暗い地図に対してそのままでも十分見えるため据え置き)。
export function buildEpicenterCircleStrokeColorExpr(colorScheme, mode) {
  const expr = ["match", ["get", "scaleKey"]];
  for (const key of QUAKE_INTENSITY_KEYS) {
    const useGray = colorScheme.id === "jma" && key === "1" && mode === "light";
    expr.push(key, useGray ? "#C7C7CC" : (colorScheme.colors[key] || colorScheme.colors["0"]).bg);
  }
  expr.push((colorScheme.colors["?"] || colorScheme.colors["0"]).bg);
  return expr;
}


// 直近の地震情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
// limit: 設定画面で指定された取得件数(1〜1000、デフォルト100)。
//
// 注意1: P2P地震情報APIの /history は1回のリクエストにつき limit を1〜100までしか
// 指定できない(仕様: https://www.p2pquake.net/develop/json_api_v2/ の /history 参照)。
// 100件を超える件数が設定されている場合、limit=100 のリクエストを offset をずらしながら
// 複数回叩いて必要件数を積み上げる(例: 300件なら3回)。
//
// 注意2: 同APIの offset は「1週間以上古い情報は取得できない場合がある」仕様のため、
// 直近1週間の地震が指定件数に満たない場合、それ以上ページを進めても同じ内容が
// 返ってくることがある。これを区別せずに積み上げると、後段の重複排除で結局同じ
// 件数に収束してしまい「件数を増やしても表示が変わらない」ように見えてしまう。
// → 各ページのidをseenIdsで追跡し、新規idが1件も無いページに当たった時点で
//   「これ以上遡れない」とみなして打ち切る。
const P2PQUAKE_API_PAGE_SIZE = 100;


export async function fetchRecentQuakes(limit = QUAKE_FETCH_LIMIT_DEFAULT) {
  const target = clampQuakeFetchLimit(limit);
  const results = [];
  const seenIds = new Set();
  let offset = 0;

  while (results.length < target) {
    const pageSize = Math.min(P2PQUAKE_API_PAGE_SIZE, target - results.length);
    const res = await fetch(`${P2PQUAKE_HISTORY_URL_BASE}&limit=${pageSize}&offset=${offset}`);
    if (!res.ok) throw new Error(`地震情報の取得に失敗しました (${res.status})`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break; // これ以上遡れる情報が無い

    const newItems = page.filter(item => item?.id != null && !seenIds.has(item.id));
    if (newItems.length === 0) break; // 新規レコードが無い = 同じ内容が返ってきている(offsetの限界に到達)
    for (const item of newItems) seenIds.add(item.id);
    results.push(...newItems);

    offset += page.length;

    // 返ってきた件数がリクエストしたページサイズより少なければ、これ以上古い情報は無い
    if (page.length < pageSize) break;
  }

  // 以前は「震源(hypocenter.name)が無いレコード」を丸ごと除外していたが、
  // これだと震度速報(ScalePrompt, 震源不明)や震源に関する情報(Destination,
  // 震度分布なし)がまるごと一覧から消えてしまい、確定報(DetailScale)が
  // 出るまでその地震自体が見えなくなってしまっていた。
  // → earthquakeオブジェクト自体が無いレコード(不完全なデータ)だけ除外し、
  //   段階ごとの情報の組み合わせはdedupeQuakeList(mergeQuakeCards)に任せる。
  const list = results
    .filter(item => item.earthquake)
    .map(toQuakeCard);
  return dedupeQuakeList(list);
}


// 「津波を引き起こした地震」検索のフォールバック用。気象庁 震度データベース(eqdb)は
// 直近の地震(発表から3日程度)がまだ反映されていないことがあるため、その場合の
// 代わりに、直近の地震情報一覧(P2P地震情報, /history?codes=551)を遡って同じ
// 時間窓[winStart, winEnd]の地震を探す。fetchRecentQuakesと同じoffsetページング
// 方式を使う(P2P地震情報のoffsetは「1週間以上古い情報は取得できない場合がある」
// 仕様のため、3日以内という前提の呼び出しと相性が良い)。
// 該当する中でМ(マグニチュード)が最大のものを1件返す(無ければnull)。
export async function findCausingQuakeFromP2p(winStart, winEnd) {
  const winStartMs = winStart.getTime();
  const winEndMs = winEnd.getTime();
  let offset = 0;
  const matches = [];
  const seenIds = new Set();

  for (let page = 0; page < 10; page++) { // 安全のため最大10ページ(1000件)までで打ち切る
    const res = await fetch(`${P2PQUAKE_HISTORY_URL_BASE}&limit=${P2PQUAKE_API_PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) break;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;

    let sawAnyAtOrAfterWindowStart = false;
    for (const item of items) {
      if (item?.id == null || seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      const eq = item.earthquake;
      if (!eq?.hypocenter?.name || !eq?.time) continue;
      const t = new Date(eq.time).getTime();
      if (!Number.isFinite(t)) continue;
      if (t >= winStartMs) sawAnyAtOrAfterWindowStart = true;
      if (t >= winStartMs && t <= winEndMs) matches.push(item);
    }

    offset += items.length;
    if (items.length < P2PQUAKE_API_PAGE_SIZE) break; // これ以上遡れる情報が無い
    // このページに窓の開始時刻以降のレコードが1件も無かった(=全部それより古かった)
    // なら、これ以上遡っても窓に入るものは無いので打ち切る。
    if (!sawAnyAtOrAfterWindowStart) break;
  }

  if (matches.length === 0) return null;
  const cards = matches
    .filter(item => item.earthquake && item.earthquake.hypocenter && item.earthquake.hypocenter.name)
    .map(toQuakeCard);
  if (cards.length === 0) return null;
  cards.sort((a, b) => (b.magnitude ?? -Infinity) - (a.magnitude ?? -Infinity));
  return cards[0];
}
