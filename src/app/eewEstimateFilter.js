import { haversineKm } from "./geo";

/* ─────────────────────────────────────────────────────
   緊急地震速報(EEW)が発表されている地震の震源推定の抑制。

   EEWが発表されている地震については、気象庁の推定のほうが信頼できるため、
   自前の震源推定(epicenterEstimation.ts)の結果は表示しない。
   次の3つを全て満たす推定を「そのEEWと同じ地震の推定」とみなして消す。
   - 対象EEW: 取消でない、震源の緯度経度と発生時刻が分かっている、PLUM法でない
     (PLUM法は観測点の揺れから仮定した震源で、震源推定と並べて見せたいので
     抑制しない)
   - 推定位置が、EEWの震源から EEW_ESTIMATE_SUPPRESS_RADIUS_KM 以内
   - 推定の発生時刻が、EEWの発生時刻の前後 EEW_ESTIMATE_SUPPRESS_TIME_WINDOW_MS 以内
   距離だけでなく時刻も見るので、EEW震源付近で別の時刻に起きた地震(余震など)の
   推定は消えない。
   ───────────────────────────────────────────────────── */

// 推定が大きくずれる早い段階や、大きな地震(震源域が広い)でも、同じ地震の推定を
// 取りこぼさないよう余裕を持たせた距離。実データのリプレイで推定誤差は
// 最大でも100km程度(docs/changes_2026-09-30.md 参照)だった。
export const EEW_ESTIMATE_SUPPRESS_RADIUS_KM = 150;
// EEWの発生時刻と推定の発生時刻のずれの許容(前後)
export const EEW_ESTIMATE_SUPPRESS_TIME_WINDOW_MS = 10000;

// EEWの発生時刻("YYYY/MM/DD HH:mm:ss"。ハイフン区切りも可)をエポックmsにする。
// MapCanvasのEEW円アニメーションと同じ解釈(端末のローカル時刻として読む)。
// 取れなければNaN。
export function eewOriginTimeMs(eew) {
  if (!eew || typeof eew.originTime !== "string") return NaN;
  return new Date(eew.originTime.replace(/-/g, "/")).getTime();
}

// 推定を抑制する根拠になるEEWか
export function isSuppressingEew(eew) {
  return !!eew
    && !eew.cancelled
    && !eew.isPlum
    && typeof eew.latitude === "number"
    && typeof eew.longitude === "number"
    && Number.isFinite(eewOriginTimeMs(eew));
}

// estimates: Map<eventId, estimateEpicenter()の戻り値 | null>
//   (originTimeはエポックms。発生時刻が無い推定は時刻が合わないので抑制しない)
// 戻り値: 抑制対象を除いた新しいMap(抑制対象が無ければ入力をそのまま返す)
export function filterEstimatesNearEew(
  estimates,
  eews,
  radiusKm = EEW_ESTIMATE_SUPPRESS_RADIUS_KM,
  timeWindowMs = EEW_ESTIMATE_SUPPRESS_TIME_WINDOW_MS,
) {
  if (!estimates || estimates.size === 0) return estimates;
  const active = (eews || []).filter(isSuppressingEew).map(e => ({
    lat: e.latitude, lon: e.longitude, originMs: eewOriginTimeMs(e),
  }));
  if (active.length === 0) return estimates;

  const filtered = new Map();
  for (const [eventId, est] of estimates) {
    const sameQuake = est && est.lat != null && est.lon != null && Number.isFinite(est.originTime)
      && active.some(e =>
        Math.abs(est.originTime - e.originMs) <= timeWindowMs
        && haversineKm(est.lat, est.lon, e.lat, e.lon) <= radiusKm);
    if (!sameQuake) filtered.set(eventId, est);
  }
  return filtered;
}
