import { haversineKm } from "./geo";

/* ─────────────────────────────────────────────────────
   地震検知テスト連動の緊急地震速報シミュレーション(非推奨・自己責任の実験的機能)。
   MeteoQuakeの震源推定(epicenterEstimation.ts)の結果を、テスト用EEWカードとして表示する。
   気象庁の緊急地震速報ではない。

   【実際の地震を誤ってEEW表示しないための多層防御】
   R1 隔離      : 連動中は、検知・推定に渡す値をシミュレーション値のみにする(App.jsxのeffectiveRealtimeValues)。
   R2 二重条件  : EEW化する推定は、(a)元の検知点が全てシミュレーション対象の観測点、
                  (b)推定の発生時刻がシミュレーション開始の前後の許容内、を満たすものだけ。
   R3 実EEW優先 : 本物のEEWが発表されたら連動シミュレーションを中止する(isRealEewActive)。
   R4 識別      : source/ID接頭辞/isSimulationで、本物と常に区別できる。
   ───────────────────────────────────────────────────── */

export const SIM_EEW_SOURCE = "shake-test-sim";
export const SIM_EEW_ID_PREFIX = "simeew_";
// 推定の発生時刻が、シミュレーション開始(=真の発生時刻)から、これより前にずれていても許容する(ms)。
// 推定は検知が少ない早い段階ほどずれるため、余裕を持たせている。
export const SIM_EEW_ORIGIN_SLACK_MS = 15000;
// 続報を出す最小間隔(ms)
export const SIM_EEW_MIN_UPDATE_INTERVAL_MS = 1000;
// 続報を出す条件: 前回の発報から、位置・M・深さのいずれかがこれ以上変わった時
export const SIM_EEW_POS_THRESHOLD_KM = 3;
export const SIM_EEW_MAG_THRESHOLD = 0.1;
export const SIM_EEW_DEPTH_THRESHOLD_KM = 10;
// 発報済みの推定が、この時間以上消えたまま(テストは継続中)なら取消にする(ms)
export const SIM_EEW_VANISH_CANCEL_MS = 5000;
// テストが自然終了して最終報にした後、一覧に残す時間(ms)
export const SIM_EEW_FINAL_LINGER_MS = 10000;

export function isSimEew(e) {
  return !!e && e.source === SIM_EEW_SOURCE;
}

// 本物の緊急地震速報が発表中か。テスト(isTest)・シミュレーション・訓練報・取消済みは数えない。
export function isRealEewActive(eews) {
  return (eews || []).some(e => !!e && !e.cancelled && !e.isTest && !e.isTraining && !isSimEew(e));
}

// 連動シミュレーションが生成している観測点id(perStationのキー)の和集合。
export function collectSimStationIds(linkedTests) {
  const ids = new Set();
  for (const t of linkedTests || []) {
    if (!t?.perStation) continue;
    for (const id of t.perStation.keys()) ids.add(id);
  }
  return ids;
}

// R2(a): 検知イベントの検知点が全てシミュレーション対象の観測点か。
// event: shakeDetection.tsのイベント({ detections: [{ id, ... }] })。無い・空なら不可。
export function isSimulationOnlyEvent(event, simStationIds) {
  if (!event || !Array.isArray(event.detections) || event.detections.length === 0) return false;
  if (!simStationIds || simStationIds.size === 0) return false;
  return event.detections.every(d => simStationIds.has(d.id));
}

// R2(b): 推定の発生時刻(エポックms)が合致するシミュレーションを返す(複数なら開始時刻が最も近いもの)。
// 合致しなければnull。シミュレーションの真の発生時刻=startedAt。
export function findOwnerTest(est, linkedTests, nowMs = Date.now()) {
  if (!est || !Number.isFinite(est.originTime)) return null;
  let best = null;
  let bestGap = Infinity;
  for (const t of linkedTests || []) {
    if (!t || !Number.isFinite(t.startedAt)) continue;
    if (est.originTime < t.startedAt - SIM_EEW_ORIGIN_SLACK_MS) continue;
    if (est.originTime > nowMs + 2000) continue; // 未来の発生時刻はあり得ない
    const gap = Math.abs(est.originTime - t.startedAt);
    if (gap < bestGap) { bestGap = gap; best = t; }
  }
  return best;
}

// 発報に必要な値(位置・M)が揃っているか。
export function canIssueFromEstimate(est) {
  return !!est
    && Number.isFinite(est.lat) && Number.isFinite(est.lon)
    && Number.isFinite(est.magnitude) && Number.isFinite(est.depthKm);
}

// 前回の発報内容(rec: { lat, lon, depthKm, magnitude, issuedAt })から、続報を出すべきか。
export function shouldIssueFollowUp(rec, est, nowMs) {
  if (!rec || !canIssueFromEstimate(est)) return false;
  if (nowMs - rec.issuedAt < SIM_EEW_MIN_UPDATE_INTERVAL_MS) return false;
  return haversineKm(rec.lat, rec.lon, est.lat, est.lon) >= SIM_EEW_POS_THRESHOLD_KM
    || Math.abs(rec.magnitude - roundMag(est.magnitude)) >= SIM_EEW_MAG_THRESHOLD - 1e-9
    || Math.abs(rec.depthKm - est.depthKm) >= SIM_EEW_DEPTH_THRESHOLD_KM;
}

function roundMag(m) {
  return Math.round(m * 10) / 10;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// "YYYY/MM/DD HH:mm:ss"(端末のローカル時刻。MapCanvasのEEW円アニメーションと同じ解釈)
export function formatSimOriginTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fallbackSimPlace(lat, lon) {
  return `推定震源(北緯${lat.toFixed(2)}度 東経${lon.toFixed(2)}度)`;
}

// 第1報のカードを組み立てる。areas・maxIntensityKey・isWarnLevelは呼び出し側で計算済みのものを渡す。
export function buildSimEewCard({ eventId, est, place, areas, maxIntensityKey, isWarnLevel, simTestId, nowMs }) {
  const id = `${SIM_EEW_ID_PREFIX}${eventId}`;
  return {
    id, eventId: id,
    serial: "1",
    cancelled: false,
    isTraining: false,
    originTime: formatSimOriginTime(est.originTime),
    arrivalTime: null,
    isAssumedHypocenter: false,
    place: place || fallbackSimPlace(est.lat, est.lon),
    reducedPlace: "シミュレーション",
    latitude: est.lat, longitude: est.lon, depth: est.depthKm,
    magnitude: roundMag(est.magnitude),
    areas,
    maxIntensityKey,
    isTest: true,
    isSimulation: true,
    source: SIM_EEW_SOURCE,
    simTestId,
    isFinal: false,
    isWarnLevel: !!isWarnLevel,
    isPlum: false, // PLUM法は震源を仮定した別方式なので、推定結果は常に通常のEEWとして扱う
    receivedLocalAt: nowMs,
    cancelledLocalAt: null,
  };
}

// 続報(報番号+1、位置・M・震度分布を更新)。警報は一度なったら予報に戻さない。
export function buildSimEewFollowUp(card, { est, place, areas, maxIntensityKey, isWarnLevel, nowMs }) {
  return {
    ...card,
    serial: String((parseInt(card.serial, 10) || 1) + 1),
    originTime: formatSimOriginTime(est.originTime),
    place: place || fallbackSimPlace(est.lat, est.lon),
    latitude: est.lat, longitude: est.lon, depth: est.depthKm,
    magnitude: roundMag(est.magnitude),
    areas,
    maxIntensityKey,
    isWarnLevel: card.isWarnLevel === true ? true : !!isWarnLevel,
    receivedLocalAt: nowMs,
  };
}
