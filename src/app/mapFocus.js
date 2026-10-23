// 緊急地震速報(EEW)の第一報・揺れ検知の視点移動に共通の処理。
//
// ■ 方式: 「見せたい点が画面内に収まるようにfitBoundsする」
//   - 画面のうち、フローティング(横画面なら左のパネル、縦画面なら下のシート)に隠れていない
//     部分(=見える地図の領域)を、fitBoundsのpaddingで指定する。これにより、見せたい点の
//     範囲は「フローティングを除いた部分」の中心に、全部が収まるように表示される。
//     フローティングの大きさは、DOMの [data-floating-panel] 要素の実測で求める
//     (縦画面ではシートを開閉して高さが変わるため、固定値では合わない)。
//   - 点が少ない/1点の時でも寄りすぎないよう、最低でも FOCUS_MIN_SPAN_KM の範囲は表示する。
//   - ズームの上限は FOCUS_MAX_ZOOM、点が全国に広がる場合は収まるところまで引く。
//
// ■ 揺れ検知では、イベントが育って観測点が増えた時に、観測点が画面の端からはみ出しそうに
//   なったら(pointsNeedRefit)、もう一度fitして調整する。
export const FOCUS_MAX_ZOOM = 7.5;
export const FOCUS_MIN_SPAN_KM = 140;   // 点が少なくても、この範囲(km)は画面に収める
export const FOCUS_EDGE_MARGIN_PX = 28; // 見える領域の端からこの距離(px)以内に入ったら「はみ出しそう」
export const FOCUS_FIT_EXTRA_PX = 64;    // fitする時に、端から離しておく余白(はみ出し判定の余白より広くする)

const BASE_INSET = { top: 72, right: 24, bottom: 24, left: 24 };

// 地図コンテナのうち、フローティングに隠れている分(px)を、fitBoundsのpadding形式で返す。
export function getFloatingInsets(map, isWide) {
  const container = map.getContainer();
  const cr = container.getBoundingClientRect();
  const insets = { ...BASE_INSET };
  const panel = typeof document !== "undefined" ? document.querySelector("[data-floating-panel]") : null;
  if (panel) {
    const pr = panel.getBoundingClientRect();
    if (isWide) insets.left = Math.max(insets.left, pr.right - cr.left + 16);
    else insets.bottom = Math.max(insets.bottom, cr.bottom - pr.top + 16);
  } else {
    // パネルが取得できない時の目安(横画面: 左のパネル+タブ、縦画面: 下のシート)
    if (isWide) insets.left = 460; else insets.bottom = 220;
  }
  // 見える領域が小さくなりすぎないように上限を設ける
  insets.left = Math.min(insets.left, cr.width * 0.65);
  insets.bottom = Math.min(insets.bottom, cr.height * 0.6);
  return insets;
}

function boundsOf(points, minSpanKm) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of points) {
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  }
  const midLat = (minLat + maxLat) / 2, midLon = (minLon + maxLon) / 2;
  const halfLat = minSpanKm / 111 / 2;
  const halfLon = minSpanKm / (111 * Math.max(0.2, Math.cos(midLat * Math.PI / 180))) / 2;
  if (maxLat - minLat < halfLat * 2) { minLat = midLat - halfLat; maxLat = midLat + halfLat; }
  if (maxLon - minLon < halfLon * 2) { minLon = midLon - halfLon; maxLon = midLon + halfLon; }
  return [[minLon, minLat], [maxLon, maxLat]];
}

// points: { lat, lon }[] が、フローティングを除いた部分の中心に、全部収まるよう移動する。
export function focusMapOnPoints(map, points, isWide, options = {}) {
  if (!map || !points || points.length === 0) return;
  const reducedMotion = typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // fitした直後の点が、すぐ「端からはみ出しそう」(pointsNeedRefit)と判定されて、毎回
  // 調整し直す動きにならないよう、fitの余白は、はみ出し判定の余白より広く取る
  // (全周に同じ幅を足すので、フローティングを除いた部分の中心は変わらない)。
  const ins = getFloatingInsets(map, isWide);
  const extra = FOCUS_FIT_EXTRA_PX;
  map.fitBounds(boundsOf(points, options.minSpanKm ?? FOCUS_MIN_SPAN_KM), {
    padding: { top: ins.top + extra, right: ins.right + extra, bottom: ins.bottom + extra, left: ins.left + extra },
    maxZoom: options.maxZoom ?? FOCUS_MAX_ZOOM,
    duration: reducedMotion ? 0 : (options.duration ?? 1000),
  });
}

// 点のどれかが、見える領域(フローティングを除いた部分)の端からはみ出している/
// はみ出しそうなら true。
export function pointsNeedRefit(map, points, isWide) {
  if (!map || !points || points.length === 0) return false;
  const cr = map.getContainer().getBoundingClientRect();
  const ins = getFloatingInsets(map, isWide);
  const m = FOCUS_EDGE_MARGIN_PX;
  for (const p of points) {
    const px = map.project([p.lon, p.lat]);
    if (px.x < ins.left + m || px.x > cr.width - ins.right - m || px.y < ins.top + m || px.y > cr.height - ins.bottom - m) return true;
  }
  return false;
}
