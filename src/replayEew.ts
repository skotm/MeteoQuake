/**
 * replayEew.ts
 * ------------------------------------------------------------
 * リプレイで使う緊急地震速報(EEW)データ。JmaEewParser(v0.4.0以降)が出力する
 * 「.eew.json」の `normalized` を読み込み、リプレイの再生時刻に合わせて
 * アプリ内のEEWカード(liveFeeds.jsのtoEewCardと同じ形)を組み立てる。
 *
 * ・震度データ(.bin)と一緒に読み込んでも、EEWだけで読み込んでも使える。
 *   EEWだけの場合は、EEWの時刻範囲に合わせた「値が空のフレーム」を作り、
 *   既存のリプレイ(再生・一時停止・シーク・倍速)をそのまま使い回す。
 * ・表示するかどうかは、現在時刻ではなく「再生時刻(データ時刻)」で決める。
 *   ライブのEEWのような受信時刻(receivedLocalAt)のタイムアウトは使わない。
 * ・気象庁の公開履歴は警報のみなので、すべて警報(isWarnLevel:true)として扱う。
 */
import type { IntensityDeltaMessage } from "./realtimeProtocolClient";

export interface ReplayEewArea {
  name: string;
  minIntensityKey: string | null;
  maxIntensityKey: string | null;
  openEnded: boolean;
}

export interface ReplayEewReport {
  serial: number;
  issuedAtMs: number;
  isFinal: boolean;
  maxIntensityKey: string | null;
  areas: ReplayEewArea[];
}

export interface ReplayEewData {
  eventId: string;
  originTimeMs: number;
  hypocenterName: string | null;
  latitude: number | null;
  longitude: number | null;
  depthKm: number | null;
  magnitude: number | null;
  reports: ReplayEewReport[]; // issuedAtMsの昇順
  startMs: number; // 再生範囲の先頭(最初の報/発生の少し前)
  endMs: number;   // 再生範囲の末尾(最終報+表示を残す時間)
  warnings: string[];
}

/** 最終報(最後に届いた報)の後も、画面にEEWを残す時間。ライブのEEW_STALE_MSと同じ値。 */
export const REPLAY_EEW_KEEP_MS = 90000;
/** EEWだけで再生する時、最初の報より前に置く余白。 */
const LEAD_IN_MS = 10000;
/** EEWだけの再生で作るフレームの最大数(異常に長い範囲で重くならないように)。 */
const MAX_SYNTHETIC_FRAMES = 3 * 60 * 60;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** .eew.jsonの文字列を読み込む。形式が違う・使えない場合はErrorを投げる。 */
export function parseReplayEewJson(text: string): ReplayEewData {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("EEWファイルをJSONとして読み込めませんでした。");
  }
  const n = raw?.normalized;
  if (!n || typeof n !== "object") {
    throw new Error("このファイルには正規化データがありません。JmaEewParser v0.4.0以降で作成した .eew.json を選択してください。");
  }
  if (n.formatVersion !== 1) {
    throw new Error(`未対応のEEWファイル形式です(formatVersion: ${String(n.formatVersion)})。`);
  }
  const ev = n.event || {};
  const reportsRaw: any[] = Array.isArray(n.reports) ? n.reports : [];
  const reports: ReplayEewReport[] = reportsRaw
    .filter((r) => isNum(r?.issuedAtMs))
    .map((r) => ({
      serial: isNum(r.serial) ? r.serial : 0,
      issuedAtMs: r.issuedAtMs,
      isFinal: !!r.isFinal,
      maxIntensityKey: typeof r.maxIntensityKey === "string" ? r.maxIntensityKey : null,
      areas: (Array.isArray(r.areas) ? r.areas : [])
        .filter((a: any) => a && typeof a.name === "string" && a.name)
        .map((a: any) => ({
          name: a.name,
          minIntensityKey: typeof a.minIntensityKey === "string" ? a.minIntensityKey : null,
          maxIntensityKey: typeof a.maxIntensityKey === "string" ? a.maxIntensityKey : null,
          openEnded: !!a.openEnded,
        })),
    }))
    .sort((a, b) => a.issuedAtMs - b.issuedAtMs || a.serial - b.serial);

  if (reports.length === 0) {
    throw new Error("発表時刻のある報が1件もありません。JmaEewParserの「確認が必要な点」を確認してください。");
  }
  if (!isNum(ev.latitude) || !isNum(ev.longitude)) {
    throw new Error("震源の緯度・経度が数値で取得できていないため再生できません。");
  }
  // 最終報の印が付いていない場合でも、最後の報を最終報として扱う。
  reports[reports.length - 1].isFinal = true;

  const originTimeMs = isNum(ev.originTimeMs) ? ev.originTimeMs : reports[0].issuedAtMs;
  const startMs = Math.min(originTimeMs, reports[0].issuedAtMs) - LEAD_IN_MS;
  const endMs = reports[reports.length - 1].issuedAtMs + REPLAY_EEW_KEEP_MS;
  return {
    eventId: String(ev.eventId || `eew_${originTimeMs}`),
    originTimeMs,
    hypocenterName: typeof ev.hypocenterName === "string" ? ev.hypocenterName : null,
    latitude: ev.latitude,
    longitude: ev.longitude,
    depthKm: isNum(ev.depthKm) ? ev.depthKm : null,
    magnitude: isNum(ev.magnitude) ? ev.magnitude : null,
    reports,
    startMs,
    endMs,
    warnings: Array.isArray(n.warnings) ? n.warnings.filter((w: unknown) => typeof w === "string") : [],
  };
}

/** UTCミリ秒を、アプリのEEWカードのoriginTime形式(JSTの "YYYY/MM/DD HH:mm:ss")にする。 */
export function formatJstSlash(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * 再生時刻 timeMs(UTCミリ秒)に画面へ出すEEWカードを返す(0件または1件)。
 *  ・最初の報より前 → なし
 *  ・以降 → issuedAtMs <= timeMs の最新の報
 *  ・最終報から REPLAY_EEW_KEEP_MS を過ぎたら → なし
 * カードの形は liveFeeds.js の toEewCard と同じ(source は "replay")。
 */
export function buildReplayEewAt(data: ReplayEewData | null, timeMs: number | null): any[] {
  if (!data || timeMs == null || !Number.isFinite(timeMs)) return [];
  let current: ReplayEewReport | null = null;
  for (const r of data.reports) {
    if (r.issuedAtMs <= timeMs) current = r;
    else break;
  }
  if (!current) return [];
  const last = data.reports[data.reports.length - 1];
  if (timeMs >= last.issuedAtMs + REPLAY_EEW_KEEP_MS) return [];

  return [{
    id: `replay_${data.eventId}_${current.serial}`,
    eventId: `replay_${data.eventId}`,
    serial: String(current.serial),
    cancelled: false,
    isTraining: false,
    originTime: formatJstSlash(data.originTimeMs),
    // 地図のP波・S波の円はこちらを優先して使う(文字列を端末のタイムゾーンで解釈しないため)。
    originTimeMs: data.originTimeMs,
    arrivalTime: null,
    isAssumedHypocenter: false,
    place: data.hypocenterName || "震源地不明",
    reducedPlace: null,
    latitude: data.latitude,
    longitude: data.longitude,
    depth: data.depthKm != null && data.depthKm >= 0 ? Math.round(data.depthKm) : null,
    magnitude: data.magnitude != null && data.magnitude > 0 ? data.magnitude : null,
    areas: current.areas.map((a) => ({
      pref: "",
      name: a.name,
      scaleFrom: null,
      scaleTo: null,
      maxIntensityKey: a.maxIntensityKey ?? "?",
      isPlum: false,
    })),
    maxIntensityKey: current.maxIntensityKey ?? "?",
    isPlum: false,
    source: "replay",
    isReplay: true,
    isFinal: current.isFinal,
    isWarnLevel: true,
    receivedLocalAt: current.issuedAtMs,
    cancelledLocalAt: null,
  }];
}

/**
 * EEWだけで再生する時の、値が空のフレーム列(1秒刻み)。先頭がベースライン。
 * 既存のリプレイ(useReplayPlayer)の再生・シーク・倍速をそのまま使うための土台。
 */
export function buildEewOnlyFrames(data: ReplayEewData): IntensityDeltaMessage[] {
  const startSec = Math.floor(data.startMs / 1000);
  const endSec = Math.ceil(data.endMs / 1000);
  const count = Math.min(Math.max(2, endSec - startSec + 1), MAX_SYNTHETIC_FRAMES);
  const frames: IntensityDeltaMessage[] = new Array(count);
  for (let i = 0; i < count; i++) frames[i] = { dataTime: new Date((startSec + i) * 1000), entries: [] };
  return frames;
}

/**
 * EEWの時刻が、読み込んでいる震度ファイルの範囲に入っているかの注意文(入っていれば null)。
 * 範囲外だと、再生してもEEWが出ないため。
 */
export function eewRangeNote(frames: IntensityDeltaMessage[], data: ReplayEewData): string | null {
  if (frames.length === 0) return null;
  const from = frames[0].dataTime.getTime();
  const to = frames[frames.length - 1].dataTime.getTime();
  const firstIssued = data.reports[0].issuedAtMs;
  const lastIssued = data.reports[data.reports.length - 1].issuedAtMs;
  if (lastIssued < from || firstIssued > to) {
    return "EEWの時刻が、読み込んだ震度ファイルの範囲外です。再生してもEEWは表示されません。";
  }
  if (firstIssued < from || lastIssued > to) {
    return "EEWの一部が、読み込んだ震度ファイルの範囲外です。範囲外の報は表示されません。";
  }
  return null;
}
