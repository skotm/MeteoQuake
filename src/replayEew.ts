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
 * ・警報の対象地域は、eewWarningAreas.ts の共通ルールで決める(警報になる前の報は予報として扱い、対象地域は出さない)。
 */
import type { IntensityDeltaMessage } from "./realtimeProtocolClient";
import { advanceWarningAreas, type WarningAreaCandidate } from "./eewWarningAreas.ts";

export interface ReplayEewArea {
  name: string;
  minIntensityKey: string | null;
  maxIntensityKey: string | null;
  openEnded: boolean;
}

export interface ReplayEewHypocenter {
  latitude: number;
  longitude: number;
  depthKm: number | null;
  magnitude: number | null;
}

export interface ReplayEewReport {
  serial: number;
  issuedAtMs: number;
  isFinal: boolean;
  /** キャンセル報(取消)か。 */
  isCancel: boolean;
  /** その報の震源。ファイルに無ければ、事例全体の震源を入れてある。 */
  hypocenter: ReplayEewHypocenter;
  maxIntensityKey: string | null;
  /** 最大震度が「〜程度以上」としか分からない報(予報区ごとの予測が無い初期の報)。 */
  maxIntensityOpenEnded: boolean;
  /** 長周期地震動階級の予想(地域名と階級)。 */
  longPeriod: Array<{ name: string; grade: number }>;
  areas: ReplayEewArea[];
}

export interface ReplayEewData {
  eventId: string;
  originTimeMs: number;
  /** 地震波検知時刻(UTCミリ秒)。ファイルに無ければnull。リプレイはここから始める。 */
  detectionTimeMs: number | null;
  hypocenterName: string | null;
  reports: ReplayEewReport[]; // issuedAtMsの昇順
  startMs: number; // 再生範囲の先頭(最初の報/発生の少し前)
  endMs: number;   // 再生範囲の末尾(最終報+表示を残す時間)
  warnings: string[];
}

/** 最終報(最後に届いた報)の後も、画面にEEWを残す時間。ライブのEEW_STALE_MSと同じ値。 */
export const REPLAY_EEW_KEEP_MS = 90000;
/** 取消(キャンセル報)の後に、「取消」の表示を残す時間。ライブのEEW_CANCEL_LINGER_MSと同じ値。 */
export const REPLAY_EEW_CANCEL_KEEP_MS = 10000;
const keepMsAfter = (r: { isCancel: boolean }) => (r.isCancel ? REPLAY_EEW_CANCEL_KEEP_MS : REPLAY_EEW_KEEP_MS);
/** EEWだけで再生する時、最初の報より前に置く余白。 */
const LEAD_IN_MS = 10000;
/** EEWだけの再生で作るフレームの最大数(異常に長い範囲で重くならないように)。 */
const MAX_SYNTHETIC_FRAMES = 3 * 60 * 60;

// 地域名に混ざったページの案内文(「このページのトップへ」など)。古いEEWファイルにも入っていることがあるため、
// 読み込み時にも除く。JmaEewParserのisPlausibleAreaNameと同じ判定。
const PAGE_CHROME = /(トップへ|ホームページ|ページ|サイトマップ|プライバシー|著作権|お問い合わせ|ご意見|リンク|免責|利用上の注意|ご利用|ナビゲーション|メニュー)/;
const isPlausibleAreaName = (name: string) => !!name && name.length <= 24 && !PAGE_CHROME.test(name);

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
  const eventHypo = {
    latitude: isNum(ev.latitude) ? ev.latitude : null,
    longitude: isNum(ev.longitude) ? ev.longitude : null,
    depthKm: isNum(ev.depthKm) ? ev.depthKm : null,
    magnitude: isNum(ev.magnitude) ? ev.magnitude : null,
  };
  const withTime = reportsRaw.filter((r) => isNum(r?.issuedAtMs));
  if (withTime.length === 0) {
    throw new Error("発表時刻のある報が1件もありません。JmaEewParserの「確認が必要な点」を確認してください。");
  }
  // 各報の震源は、その報の震源要素があればそれ、無ければ事例全体の震源を使う。
  // 深さ・Mが報側で取れていない時は、事例全体の値で補う。
  const reports: ReplayEewReport[] = [];
  let skipped = 0;
  for (const r of withTime.sort((a, b) => a.issuedAtMs - b.issuedAtMs || (a.serial ?? 0) - (b.serial ?? 0))) {
    const h = r.hypocenter && isNum(r.hypocenter.latitude) && isNum(r.hypocenter.longitude) ? r.hypocenter : null;
    const latitude = h ? h.latitude : eventHypo.latitude;
    const longitude = h ? h.longitude : eventHypo.longitude;
    if (latitude == null || longitude == null) { skipped++; continue; }
    reports.push({
      serial: isNum(r.serial) ? r.serial : 0,
      issuedAtMs: r.issuedAtMs,
      isFinal: !!r.isFinal,
      isCancel: !!r.isCancel,
      hypocenter: {
        latitude,
        longitude,
        depthKm: h && isNum(h.depthKm) ? h.depthKm : eventHypo.depthKm,
        magnitude: h && isNum(h.magnitude) ? h.magnitude : eventHypo.magnitude,
      },
      maxIntensityKey: typeof r.maxIntensityKey === "string" ? r.maxIntensityKey : null,
      maxIntensityOpenEnded: !!r.maxIntensityOpenEnded,
      longPeriod: (Array.isArray(r.longPeriod) ? r.longPeriod : [])
        .filter((a: any) => a && typeof a.name === "string" && typeof a.grade === "number" && isPlausibleAreaName(a.name.trim()))
        .map((a: any) => ({ name: a.name, grade: a.grade })),
      areas: (Array.isArray(r.areas) ? r.areas : [])
        .filter((a: any) => a && typeof a.name === "string" && isPlausibleAreaName(a.name.trim()))
        .map((a: any) => ({
          name: a.name,
          minIntensityKey: typeof a.minIntensityKey === "string" ? a.minIntensityKey : null,
          maxIntensityKey: typeof a.maxIntensityKey === "string" ? a.maxIntensityKey : null,
          openEnded: !!a.openEnded,
        })),
    });
  }
  if (reports.length === 0) {
    throw new Error("震源の緯度・経度が数値で取得できていないため再生できません。JmaEewParserで緯度・経度を入力してから保存し直してください。");
  }
  // 最終報の印が付いていない場合でも、最後の報を最終報として扱う。
  reports[reports.length - 1].isFinal = true;

  const originTimeMs = isNum(ev.originTimeMs) ? ev.originTimeMs : reports[0].issuedAtMs;
  const detectionTimeMs = isNum(ev.detectionTimeMs) ? ev.detectionTimeMs : null;
  const startMs = Math.min(originTimeMs, detectionTimeMs ?? Infinity, reports[0].issuedAtMs) - LEAD_IN_MS;
  const endMs = reports[reports.length - 1].issuedAtMs + keepMsAfter(reports[reports.length - 1]);
  const warnings: string[] = Array.isArray(n.warnings) ? n.warnings.filter((w: unknown) => typeof w === "string") : [];
  if (skipped > 0) warnings.push(`震源の位置が無い報が${skipped}件あり、再生から除きました。`);
  return {
    eventId: String(ev.eventId || `eew_${originTimeMs}`),
    originTimeMs,
    detectionTimeMs,
    hypocenterName: typeof ev.hypocenterName === "string" ? ev.hypocenterName : null,
    reports,
    startMs,
    endMs,
    warnings,
  };
}

/**
 * 再生の開始時刻(UTCミリ秒)。地震の発生時刻から始める。
 * (発生時刻がファイルに無い場合、読み込み時に第1報の発表時刻で補っている。)
 */
export function replayStartMs(data: ReplayEewData): number {
  return data.originTimeMs;
}

/** UTCミリ秒を、アプリのEEWカードのoriginTime形式(JSTの "YYYY/MM/DD HH:mm:ss")にする。 */
export function formatJstSlash(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * PLUM法の報か。PLUM法のEEWは、震源・Mが求まらないため、仮定震源要素として
 * M1.0・深さ10kmで発表される。この値の報はPLUM法として扱う。
 */
export function isPlumHypocenter(h: { depthKm: number | null; magnitude: number | null }): boolean {
  return h.magnitude != null && Math.abs(h.magnitude - 1.0) < 0.05 && h.depthKm != null && Math.round(h.depthKm) === 10;
}

const INTENSITY_RANK = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];
const rankOf = (key: string | null) => (key == null ? -1 : INTENSITY_RANK.indexOf(key));

/** 1つの報から、警報の対象地域を決めるための候補を作る(震度4以上=対象、5弱以上または長周期階級3以上=強い)。 */
function warningCandidates(r: ReplayEewReport): WarningAreaCandidate[] {
  const byName = new Map<string, WarningAreaCandidate>();
  for (const a of r.areas) {
    const rank = rankOf(a.maxIntensityKey);
    byName.set(a.name, { name: a.name, isTarget: rank >= 4, isStrong: rank >= 5 });
  }
  for (const lp of r.longPeriod) {
    const cur = byName.get(lp.name) ?? { name: lp.name, isTarget: false, isStrong: false };
    if (lp.grade >= 3) { cur.isTarget = true; cur.isStrong = true; }
    byName.set(lp.name, cur);
  }
  return [...byName.values()];
}

/**
 * current までの報から、警報の対象地域を返す(共通ルールは eewWarningAreas.ts)。
 * 地域ごとの予想震度は、その地域が最後に出た報の値(今の報に無ければ前の値のまま)。
 * 警報になる前の報は、対象地域なし(空)。
 */
export function warningAreasAt(reports: ReplayEewReport[], current: ReplayEewReport): ReplayEewArea[] {
  let names = new Set<string>();
  const latest = new Map<string, ReplayEewArea>();
  for (const r of reports) {
    if (r.isCancel) { if (r === current) break; continue; }
    for (const a of r.areas) latest.set(a.name, a);
    for (const lp of r.longPeriod) if (!latest.has(lp.name)) latest.set(lp.name, { name: lp.name, minIntensityKey: null, maxIntensityKey: null, openEnded: false });
    names = advanceWarningAreas(names, warningCandidates(r)).names;
    if (r === current) break;
  }
  return [...names].map((n) => latest.get(n)).filter((a): a is ReplayEewArea => !!a);
}

/** その報の時点で警報になっているか。 */
export function isWarnLevelAt(reports: ReplayEewReport[], current: ReplayEewReport): boolean {
  let names = new Set<string>();
  for (const r of reports) {
    if (!r.isCancel) names = advanceWarningAreas(names, warningCandidates(r)).names;
    if (r === current) break;
  }
  return names.size > 0;
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
  if (timeMs >= last.issuedAtMs + keepMsAfter(last)) return [];
  const areas = current.isCancel ? [] : warningAreasAt(data.reports, current);
  const isWarn = isWarnLevelAt(data.reports, current);
  const isPlum = !current.isCancel && isPlumHypocenter(current.hypocenter);

  return [{
    id: `replay_${data.eventId}_${current.serial}`,
    eventId: `replay_${data.eventId}`,
    serial: String(current.serial),
    cancelled: current.isCancel,
    isTraining: false,
    originTime: formatJstSlash(data.originTimeMs),
    // 地図のP波・S波の円はこちらを優先して使う(文字列を端末のタイムゾーンで解釈しないため)。
    originTimeMs: data.originTimeMs,
    arrivalTime: null,
    isAssumedHypocenter: isPlum,
    place: data.hypocenterName || "震源地不明",
    reducedPlace: null,
    latitude: current.hypocenter.latitude,
    longitude: current.hypocenter.longitude,
    depth: current.hypocenter.depthKm != null && current.hypocenter.depthKm >= 0 ? Math.round(current.hypocenter.depthKm) : null,
    magnitude: current.hypocenter.magnitude != null && current.hypocenter.magnitude > 0 ? current.hypocenter.magnitude : null,
    areas: areas.map((a) => ({
      pref: "",
      name: a.name,
      scaleFrom: null,
      scaleTo: null,
      maxIntensityKey: a.maxIntensityKey ?? "?",
      isPlum,
    })),
    maxIntensityKey: current.maxIntensityKey ?? "?",
    isPlum,
    source: "replay",
    isReplay: true,
    isFinal: current.isFinal,
    isWarnLevel: isWarn,
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
 * 震度ファイルのフレームを、EEWの再生範囲(startMs〜endMs)まで空のフレームで延ばす。
 * EEWの一部が震度ファイルの範囲外でも、地震の発生時刻から再生を始められるようにするため。
 * 範囲外の間は震度の値が変わらず、EEWだけが進む。EEWが震度ファイルと全く重ならない時は、そのまま返す。
 */
export function extendFramesForEew(bin: IntensityDeltaMessage[], data: ReplayEewData): IntensityDeltaMessage[] {
  if (bin.length === 0) return bin;
  const from = bin[0].dataTime.getTime();
  const to = bin[bin.length - 1].dataTime.getTime();
  const firstIssued = data.reports[0].issuedAtMs;
  const lastIssued = data.reports[data.reports.length - 1].issuedAtMs;
  if (lastIssued < from || firstIssued > to) return bin;
  const before: IntensityDeltaMessage[] = [];
  const startSec = Math.max(Math.floor(data.startMs / 1000), Math.ceil(from / 1000) - MAX_SYNTHETIC_FRAMES);
  for (let s = startSec; s * 1000 < from; s++) before.push({ dataTime: new Date(s * 1000), entries: [] });
  const after: IntensityDeltaMessage[] = [];
  const endSec = Math.min(Math.ceil(data.endMs / 1000), Math.floor(to / 1000) + MAX_SYNTHETIC_FRAMES);
  for (let s = Math.floor(to / 1000) + 1; s <= endSec; s++) after.push({ dataTime: new Date(s * 1000), entries: [] });
  if (before.length === 0 && after.length === 0) return bin;
  return [...before, ...bin, ...after];
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
    return "EEWの一部が、読み込んだ震度ファイルの範囲外です。範囲外の間は、震度は表示されず、EEWだけを再生します。";
  }
  return null;
}
