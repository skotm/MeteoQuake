import { intensityLabelToKey } from "../quake/intensityScale.jsx";
import { maxScaleToIntensityKey, toQuakeCard, toTsunamiCard } from "./p2p.js";

/* ─────────────────────────────────────────────────────
   緊急地震速報(警報) (P2P地震情報 EEW, code:556)
   https://api.p2pquake.net/v2/history?codes=556 相当のスキーマがWebSocketで届く。
   気象庁の「緊急地震速報(警報)」の内容そのものであり、本アプリではこれを
   ライブ受信のみで扱う(過去ログを一覧表示する意味が薄いため /history は叩かない)。

   P2P地震情報のEEWスキーマには、kmoni直叩き版(index.html)にあった
   report_num・is_final・alertflgに相当するフィールドが無い。そのため:
     ・「第◯報」相当は issue.serial をそのまま使う
     ・「最終報」の判定はできないため、一定時間(EEW_STALE_MS)続報が
       来なければ自動的に消すタイムアウト方式でライフサイクルを管理する
     ・警報級以外(予報のみ)のEEWはこのAPIには流れてこないため、
       kmoni版にあった「警報/予報」の区別は行わない(常に警報級として扱う)
   ───────────────────────────────────────────────────── */
export const EEW_STALE_MS = 90000;
        // 最終報(とみなせる、最後に届いた続報)から、この時間表示を残してから自動的に消す
export const EEW_CANCEL_LINGER_MS = 8000;
 // 取消受信後、この時間はパネルに「取消」表示を残してから消す
export const EEW_MAX_CONCURRENT = 3;
      // 同時に画面へ出すEEWの最大件数(UIが煩雑にならないよう抑える)
export const EEW_P_WAVE_SPEED_KM_S = 6.0;
 // P波の伝播速度(kmoni版index.htmlと同じ簡易値)
export const EEW_S_WAVE_SPEED_KM_S = 3.5;
 // S波の伝播速度

// 起動直後、既に発表中のEEWがあれば取りこぼさないよう、/historyを1回だけ
// 見に行くための設定。WebSocketは「接続した後に届いたもの」しか拾えないため、
// アプリを開いた時点で既に緊急地震速報が発表されていた場合、WebSocketだけでは
// 次の続報が来るまで何も表示されない、という抜けが起きる。それを防ぐための
// 起動時バックフィル。ただし本当に「今起きている」ものだけを拾いたいので、
// 受信時刻がこの新しさ(ミリ秒)以内のものだけを反映し、古いものは無視する。
const EEW_HISTORY_URL = "https://api.p2pquake.net/v2/history?codes=556&limit=1";

const EEW_HISTORY_FRESHNESS_MS = 90000;


// areas[]のscaleFrom/scaleToから、この地震の「最大予測震度」をINTENSITY_LABELの
// キー形式に変換する。99("〜程度以上")は震度7相当として扱う。
function eewMaxScaleKey(areas) {
  let max = -Infinity;
  for (const a of areas) {
    const s = typeof a.scaleTo === "number" ? a.scaleTo : (typeof a.scaleFrom === "number" ? a.scaleFrom : null);
    if (s != null && s > max) max = s;
  }
  if (max === -Infinity || max < 0) return "?";
  if (max >= 99) return "7";
  return maxScaleToIntensityKey(max);
}


// P2P地震情報APIの1レコード(EEW, code:556)を、アプリ内で使う形に変換する
function toEewCard(item) {
  const eq = item.earthquake || {};
  const hypo = eq.hypocenter || {};
  const areas = Array.isArray(item.areas) ? item.areas.map(a => {
    const scaleFrom = typeof a.scaleFrom === "number" ? a.scaleFrom : null;
    const scaleTo = typeof a.scaleTo === "number" ? a.scaleTo : null;
    return {
      pref: a.pref || "",
      name: a.name || "",
      scaleFrom,
      scaleTo,
      // 地図の塗りつぶし用に、この地域の予測震度を内部キー("5-"等)に変換しておく。
      // scaleTo(上限側)を優先し、無ければscaleFromを使う。
      maxIntensityKey: eewMaxScaleKey([{ scaleFrom, scaleTo }]),
      // kindCode: 10/11=通常(到達予測あり)、19=PLUM法(主要動の到達予想なし)
      isPlum: a.kindCode === "19",
    };
  }) : [];

  return {
    id: item.id,
    // eventId(issue.eventId)を同一地震の識別キーとして使う。続報は同じeventIdで届く。
    eventId: item.issue?.eventId || item.id,
    serial: item.issue?.serial || null,
    cancelled: !!item.cancelled,
    isTraining: !!item.test,
    originTime: eq.originTime || null,
    arrivalTime: eq.arrivalTime || null,
    isAssumedHypocenter: eq.condition === "仮定震源要素",
    place: hypo.name || "震源地不明",
    reducedPlace: hypo.reduceName || null,
    latitude: typeof hypo.latitude === "number" && hypo.latitude !== -200 ? hypo.latitude : null,
    longitude: typeof hypo.longitude === "number" && hypo.longitude !== -200 ? hypo.longitude : null,
    depth: typeof hypo.depth === "number" && hypo.depth >= 0 ? Math.round(hypo.depth) : null,
    magnitude: typeof hypo.magnitude === "number" && hypo.magnitude > 0 ? hypo.magnitude : null,
    areas,
    maxIntensityKey: eewMaxScaleKey(areas),
    // areas[]全件がPLUM法(kindCode:19)の場合のみPLUM法発表とみなす(1件でも通常判定が
    // 混じっていれば、通常の到達予測ありとして扱う)。areas未着の初回はfalse。
    isPlum: areas.length > 0 && areas.every(a => a.isPlum),
    // 複数ソース併用(Wolfx優先)のための出どころ情報。P2P地震情報には「最終報」
    // フィールドが無いため、isFinalは常にfalse(タイムアウト方式で最終扱いする)。
    // また、P2P地震情報のEEW(code:556)は警報級しか配信されないため、
    // isWarnLevelは常にtrue。
    source: "p2pquake",
    isFinal: false,
    isWarnLevel: true,
  };
}


// 緯度・経度・半径(km)から、地図に描く円(GeoJSON Polygon)の頂点座標を作る。
// 球面上の測地線オフセット(標準的な"destination point"の公式)を使っており、
// 日本周辺の震源から数百km程度の範囲であれば十分な精度で円になる。
export function eewCirclePolygon(lat, lon, radiusKm, steps = 64) {
  if (!(radiusKm > 0) || lat == null || lon == null) return null;
  const R = 6371; // 地球の平均半径(km)
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const angularDist = radiusKm / R;
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    const destLat = Math.asin(
      Math.sin(latRad) * Math.cos(angularDist) +
      Math.cos(latRad) * Math.sin(angularDist) * Math.cos(bearing)
    );
    const destLon = lonRad + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDist) * Math.cos(latRad),
      Math.cos(angularDist) - Math.sin(latRad) * Math.sin(destLat)
    );
    coords.push([destLon * 180 / Math.PI, destLat * 180 / Math.PI]);
  }
  return coords;
}


// 発生時刻からの経過秒・震源の深さ・波の伝播速度(km/s)から、
// 地表面での円の半径(km)を求める(斜距離→水平距離への変換込み)。
// 経過前(elapsedSec<=0)や、まだ波が地表に届いていない(slant<=depth)場合は0を返す。
export function eewWaveSurfaceRadiusKm(elapsedSec, depthKm, speedKmS) {
  if (!(elapsedSec > 0)) return 0;
  const slant = speedKmS * elapsedSec;
  const depth = depthKm != null && depthKm >= 0 ? depthKm : 10;
  if (slant <= depth) return 0;
  return Math.sqrt(slant * slant - depth * depth);
}


// 起動時バックフィル用: /historyから直近のEEWを1件だけ取得し、それが
// 「十分新しい(EEW_HISTORY_FRESHNESS_MS以内)」場合だけtoEewCard()して返す。
// 訓練配信(test:true)や、取得自体に失敗した場合、十分新しくない場合はnullを返す。
export async function fetchLatestFreshEew() {
  const res = await fetch(EEW_HISTORY_URL);
  if (!res.ok) return null;
  const list = await res.json();
  const latest = Array.isArray(list) ? list[0] : null;
  if (!latest || latest.test) return null;
  // "time"(受信時刻)は"YYYY/MM/DD HH:mm:ss.SSS"想定だが、念のため"-"区切りも
  // "/"に正規化してから解釈する(他のJMA系フィールドと表記ゆれがあるため)。
  const receivedMs = latest.time ? new Date(latest.time.replace(/-/g, "/")).getTime() : NaN;
  if (!Number.isFinite(receivedMs)) return null;
  if (Date.now() - receivedMs > EEW_HISTORY_FRESHNESS_MS) return null; // 既に終わっていそうな古い発表は無視
  return toEewCard(latest);
}


/* ─────────────────────────────────────────────────────
   Wolfx Open API — JMA緊急地震速報 (jma_eew)
   https://wolfx.jp/apidoc
   P2P地震情報のEEW(code:556)には無い、isFinal(最終報かどうか)・
   isWarn(警報/予報の区別)・isAssumption(PLUM法かどうか)を直接持っている。
   そのため、両方を受信しつつWolfxを優先する(同じeventIdについて、Wolfx由来の
   データがあればP2P地震情報側の更新では上書きしない)方針にしている。
   実際のJMA配信を中継しているだけの非公式プロジェクトである点はP2P地震情報と
   同様。専用のWebSocket接続がもう1本必要になる。
   ───────────────────────────────────────────────────── */
const WOLFX_EEW_WS_URL = "wss://ws-api.wolfx.jp/jma_eew";

const WOLFX_EEW_HTTP_URL = "https://api.wolfx.jp/jma_eew.json";


// Wolfxの1レコード(jma_eew)を、アプリ内で使う共通のEEWカード形式(toEewCardと
// 同じ形)に変換する。WarnArea[]のShindo1/Shindo2・MaxIntensityは"5弱"のような
// 表示用文字列で来るため、intensityLabelToKey()で内部キーへ変換する。
function toEewCardFromWolfx(data) {
  const areas = Array.isArray(data.WarnArea) ? data.WarnArea.map(a => ({
    pref: "", // Wolfxは都道府県単位を分けて返さないため空にしておく
    name: a.Chiiki || "",
    scaleFrom: null, // 内部的にはscaleコードではなくmaxIntensityKeyを直接使うため未使用
    scaleTo: null,
    // Wolfxは震度を"5弱"のような表示用文字列で返してくる。Shindo2(上限側)を
    // 優先し、無ければShindo1を使って内部キーへ変換する(P2P地震情報のscaleTo優先と同じ考え方)。
    maxIntensityKey: intensityLabelToKey(a.Shindo2 || a.Shindo1),
    isPlum: !!data.isAssumption,
  })) : [];

  return {
    id: `wolfx_${data.EventID}_${data.Serial}`,
    // EventIDは気象庁が発表した地震そのものの識別子であり、P2P地震情報の
    // issue.eventIdと同一の値になる(どちらも気象庁の原情報をそのまま中継して
    // いるため)。これを共通の識別キーとして使い、2つのソースを統合する。
    eventId: String(data.EventID),
    serial: data.Serial != null ? String(data.Serial) : null,
    cancelled: !!data.isCancel,
    isTraining: !!data.isTraining,
    originTime: data.OriginTime || null,
    arrivalTime: null,
    isAssumedHypocenter: !!data.isAssumption,
    place: data.Hypocenter || "震源地不明",
    reducedPlace: null,
    latitude: typeof data.Latitude === "number" ? data.Latitude : null,
    longitude: typeof data.Longitude === "number" ? data.Longitude : null,
    depth: typeof data.Depth === "number" && data.Depth >= 0 ? Math.round(data.Depth) : null,
    magnitude: typeof data.Magunitude === "number" && data.Magunitude > 0 ? data.Magunitude : null,
    areas,
    maxIntensityKey: intensityLabelToKey(data.MaxIntensity),
    isPlum: !!data.isAssumption,
    source: "wolfx",
    // Wolfxは「最終報かどうか」を直接教えてくれる。第1報などisFinal:falseの間は
    // 通常どおりEEW_STALE_MSのタイムアウトで生存管理されるが、真の最終報が来た
    // ことが分かっている点が、P2P地震情報だけの場合との一番の違い。
    isFinal: !!data.isFinal,
    // isWarn:trueなら警報、falseなら予報。Wolfxは予報段階から配信してくれる
    // ため、P2P地震情報より早いタイミングで拾える。UI側で警報/予報を出し分ける。
    isWarnLevel: data.isWarn !== false,
  };
}


// WebSocketで受信した1件を、JMA緊急地震速報(type:"jma_eew")であれば変換して返す。
// 訓練報(isTraining)は対象外。警報・予報のどちらも表示対象とする
// (Wolfxならではの予報段階の速報も活かすため)。
function wolfxMessageToEewCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.type !== "jma_eew") return null; // ハートビート等を除外
  if (data.isTraining) return null;
  return toEewCardFromWolfx(data);
}


// 起動時バックフィル用(Wolfx版)。HTTP GETは直近1件のスナップショットを返す
// ため、それが十分新しければ取り込む。P2P地震情報側のfetchLatestFreshEew()と
// 同時に叩き、どちらが先に届いてもhandleIncomingEew側のマージロジックが
// Wolfx優先で正しく解決する。
export async function fetchLatestFreshEewFromWolfx() {
  const res = await fetch(WOLFX_EEW_HTTP_URL);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || data.isTraining) return null;
  const announcedMs = data.AnnouncedTime ? new Date(data.AnnouncedTime.replace(/-/g, "/")).getTime() : NaN;
  if (!Number.isFinite(announcedMs)) return null;
  if (Date.now() - announcedMs > EEW_HISTORY_FRESHNESS_MS) return null;
  return toEewCardFromWolfx(data);
}


/**
 * Wolfxの緊急地震速報WebSocketに接続し、受信するたびにonEewを呼ぶ。
 * P2P地震情報のconnectQuakeWebSocket()とは完全に独立した、別のWebSocket接続。
 * 接続が切れた場合は一定間隔で自動的に再接続を試みる。
 * 戻り値のclose()を呼ぶと再接続をやめて確実に切断する。
 */
export function connectWolfxEewWebSocket(onEew, onStatusChange) {
  let ws = null;
  let closedByCaller = false;
  let reconnectTimer = null;

  function connect() {
    if (closedByCaller) return;
    ws = new WebSocket(WOLFX_EEW_WS_URL);

    ws.onopen = () => {
      onStatusChange?.("open");
    };

    ws.onmessage = (event) => {
      const eew = wolfxMessageToEewCard(event.data);
      if (eew) onEew?.(eew);
    };

    ws.onerror = (e) => {
      console.error("Wolfx緊急地震速報WebSocketエラー:", e);
    };

    ws.onclose = () => {
      onStatusChange?.("closed");
      if (closedByCaller) return;
      reconnectTimer = setTimeout(connect, 5000);
    };
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}


/* ─────────────────────────────────────────────────────
   P2P地震情報 WebSocket API (v2)
   wss://api.p2pquake.net/v2/ws
   地震情報(code:551)・津波情報(code:552)・緊急地震速報(code:556)を含む
   全情報がリアルタイムでpushされてくる。
   地震・津波の最新一覧は起動時に /history で1回だけ取得し(履歴はWebSocketでは
   遡れないため)、以降はこのWebSocketで届いた新着分だけを一覧に追加していく。
   緊急地震速報(EEW)は履歴を扱わず、WebSocketのライブ受信のみで管理する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_WS_URL = "wss://api.p2pquake.net/v2/ws";


// WebSocketで受信した1件を、地震情報(code:551)であれば変換して返す。
// 対象外(津波予報や緊急地震速報など、このアプリでまだ扱っていない種別)はnullを返す。
// 以前は震源(hypocenter.name)が無いレコード(震度速報・震源に関する情報)を
// ここで弾いていたが、それだと確定報が出るまでその地震自体が見れなかったため、
// earthquakeオブジェクト自体が無い(不完全な)レコードだけを除外するようにした。
function wsMessageToQuakeCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.code !== 551) return null;
  if (!data.earthquake) return null;
  return toQuakeCard(data);
}


// WebSocketで受信した1件を、津波情報(code:552)であれば変換して返す。
function wsMessageToTsunamiCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.code !== 552) return null;
  return toTsunamiCard(data);
}


// WebSocketで受信した1件を、緊急地震速報(code:556)であれば変換して返す。
// test:true(訓練・切替試験の配信)は実際の地震と紛らわしいため対象外にする。
function wsMessageToEewCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.code !== 556) return null;
  if (data.test) return null;
  return toEewCard(data);
}


/**
 * P2P地震情報のWebSocketに接続し、地震情報(code:551)を受信するたびにonQuakeを、
 * 津波情報(code:552)を受信するたびにonTsunamiを、緊急地震速報(code:556)を
 * 受信するたびにonEewを呼ぶ。1本の接続で全部を賄う
 * (種別ごとに別々の接続を開くと無駄にコネクション数が増えてしまうため)。
 * 接続が切れた場合は一定間隔で自動的に再接続を試みる。
 * 戻り値のclose()を呼ぶと再接続をやめて確実に切断する。
 */
export function connectQuakeWebSocket(onQuake, onTsunami, onEew, onStatusChange) {
  let ws = null;
  let closedByCaller = false;
  let reconnectTimer = null;

  function connect() {
    if (closedByCaller) return;
    ws = new WebSocket(P2PQUAKE_WS_URL);

    ws.onopen = () => {
      onStatusChange?.("open");
    };

    ws.onmessage = (event) => {
      const quake = wsMessageToQuakeCard(event.data);
      if (quake) { onQuake(quake); return; }
      const tsunami = wsMessageToTsunamiCard(event.data);
      if (tsunami) { onTsunami?.(tsunami); return; }
      const eew = wsMessageToEewCard(event.data);
      if (eew) onEew?.(eew);
    };

    ws.onerror = (e) => {
      console.error("P2P地震情報WebSocketエラー:", e);
    };

    ws.onclose = () => {
      onStatusChange?.("closed");
      if (closedByCaller) return;
      // 5秒後に再接続を試みる(サーバー再起動・回線切断などからの復帰用)
      reconnectTimer = setTimeout(connect, 5000);
    };
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}
