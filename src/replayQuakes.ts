/**
 * リプレイ時刻での「地震タブの並び」を再現する(MeteoQuakeがその時刻に動いていたら、という想定)。
 *
 * 取得済みの地震(最終形の地震カード)を元に、リプレイ時刻 T での見え方を作る。
 *   - リプレイ時間より前に発生した地震 … 最終形のまま表示する。
 *   - リプレイ時間内に発生した地震 … 擬似的に段階を踏んで表示する。
 *       最大震度3以上: 発生+1分30秒 震度速報 → +1分 震源情報 → +1分 詳細(確定)
 *       最大震度2以下: 発生+3分30秒 に詳細(確定)のみ
 *     それより前の時刻には一覧に出さない。
 * カードの形は app/quakeCards.js の toQuakeCard / eqdb.js の buildEqdbQuakeCard と同じ。
 */

export const REPLAY_QUAKE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const PROMPT_DELAY_MS = 90_000;
export const DESTINATION_DELAY_MS = 60_000;
export const DETAIL_DELAY_MS = 60_000;
/** 震度2以下の地震が詳細として出るまで(= 震度3以上の地震の詳細が出るまでと同じ)。 */
export const SMALL_QUAKE_DETAIL_DELAY_MS = PROMPT_DELAY_MS + DESTINATION_DELAY_MS + DETAIL_DELAY_MS;

export type ReplayQuakeStage = "prompt" | "destination" | "detail";

export interface ReplayQuakeCardLike {
  id: string;
  time: string; // "YYYY/MM/DD HH:mm:ss"(日本時間)
  maxIntensity?: string;
  [key: string]: unknown;
}

export interface ReplayRange {
  startMs: number;
  endMs: number;
}

/** "YYYY/MM/DD HH:mm:ss"(日本時間)をUTCミリ秒にする。解釈できなければnull。 */
export function parseQuakeTimeMs(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(time);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0) - 9 * 3600_000;
  return Number.isFinite(ms) ? ms : null;
}

const BELOW_SHINDO3 = new Set(["0", "1", "2", "?", "", "undefined"]);

/** 最大震度が震度3以上か(震度速報が出る地震か)。不明("?")は3未満として扱う。 */
export function isShindo3OrMore(maxIntensity: string | undefined): boolean {
  return !BELOW_SHINDO3.has(String(maxIntensity ?? ""));
}

export interface QuakeStageTimes {
  promptMs: number | null;
  destinationMs: number | null;
  detailMs: number;
}

export function quakeStageTimes(t0: number, maxIntensity: string | undefined): QuakeStageTimes {
  if (isShindo3OrMore(maxIntensity)) {
    const promptMs = t0 + PROMPT_DELAY_MS;
    const destinationMs = promptMs + DESTINATION_DELAY_MS;
    return { promptMs, destinationMs, detailMs: destinationMs + DETAIL_DELAY_MS };
  }
  return { promptMs: null, destinationMs: null, detailMs: t0 + SMALL_QUAKE_DETAIL_DELAY_MS };
}

/** 時刻 nowMs における発表段階。まだ何も出ていなければnull。 */
export function quakeStageAt(t0: number, maxIntensity: string | undefined, nowMs: number): ReplayQuakeStage | null {
  const t = quakeStageTimes(t0, maxIntensity);
  if (nowMs >= t.detailMs) return "detail";
  if (t.destinationMs != null && nowMs >= t.destinationMs) return "destination";
  if (t.promptMs != null && nowMs >= t.promptMs) return "prompt";
  return null;
}

function asPrompt<T extends ReplayQuakeCardLike>(card: T): T {
  return {
    ...card,
    stage: "prompt",
    place: "震源調査中",
    magnitude: null,
    depth: null,
    latitude: null,
    longitude: null,
    hypocenters: undefined,
    points: [],
    resolvedPoints: undefined,
    domesticTsunami: "Unknown",
    freeFormComment: null,
  };
}

function asDestination<T extends ReplayQuakeCardLike>(card: T): T {
  // 震源は判明しているが、震度分布はまだ無い(最大震度は「調査中」)。
  return {
    ...card,
    stage: "destination",
    maxIntensity: "?",
    points: [],
    resolvedPoints: undefined,
    domesticTsunami: "Unknown",
    freeFormComment: null,
  };
}

/**
 * リプレイ時刻 nowMs での地震一覧(新しい順)。
 * cards は取得済みの最終形の地震カード。range はリプレイの時間範囲。
 */
export function replayQuakesAt<T extends ReplayQuakeCardLike>(cards: readonly T[], nowMs: number, range: ReplayRange): T[] {
  const out: { card: T; t0: number }[] = [];
  for (const card of cards) {
    const t0 = parseQuakeTimeMs(card.time);
    if (t0 == null) continue;
    if (t0 > nowMs) continue; // まだ発生していない
    if (t0 < range.startMs) {
      out.push({ card, t0 }); // リプレイ開始前の地震は最終形のまま
      continue;
    }
    const stage = quakeStageAt(t0, card.maxIntensity, nowMs);
    if (stage == null) continue;
    const shown = stage === "prompt" ? asPrompt(card) : stage === "destination" ? asDestination(card) : { ...card, stage: "detail" };
    out.push({ card: shown as T, t0 });
  }
  out.sort((a, b) => b.t0 - a.t0);
  return out.map(e => e.card);
}

/** 一覧の同一性判定用。id と段階が同じなら、同じ表示とみなせる。 */
export function replayQuakeSignature(list: readonly ReplayQuakeCardLike[]): string {
  return list.map(q => `${q.id}:${String((q as { stage?: string }).stage ?? "")}:${q.maxIntensity ?? ""}`).join("|");
}

/** 取得する期間(リプレイ開始の7日前〜リプレイ終了)。 */
export function replayQuakeFetchRange(range: ReplayRange): ReplayRange {
  return { startMs: range.startMs - REPLAY_QUAKE_LOOKBACK_MS, endMs: range.endMs };
}

/** ミリ秒(UTC)を日本時間の "YYYY-MM-DD" と "HH:mm" にする(eqdbの検索条件用)。 */
export function toJstDateAndTime(ms: number): { date: string; time: string } {
  const d = new Date(ms + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}
