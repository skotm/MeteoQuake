/* Wolfx Open API: jma_tsunami(全国の津波警報・予報の現在の状態)
   https://wolfx.jp/apidoc
   重要な注意(公式仕様):
   ・areasが空でも「安全」ではない。status が expired / unknown / uninitialized の間は
     「状態を確認できない」として扱い、決して「津波の心配なし」と表示しない。
   ・validUntil(信頼期限)は、サーバーが切れた後も届かなくなるため、クライアント側でも判定する。
   ・observations(VTSE51/52の観測報)は予報区(VTSE41)を上書きしない。ここでは未使用。 */

export type WolfxTsunamiGrade = "MajorWarning" | "Warning" | "Watch" | "NonEffective";

export interface WolfxTsunamiArea {
  name: string;
  grade: WolfxTsunamiGrade;
  immediate: boolean;
  firstHeightCondition: string | null;
  firstHeightTime: string | null;
  maxHeightDescription: string | null;
}

export interface WolfxTsunamiCard {
  id: string;
  time: string; // "YYYY/MM/DD HH:mm:ss"(JST)
  cancelled: boolean;
  areas: WolfxTsunamiArea[];
  maxGrade: WolfxTsunamiGrade | null;
  source: "wolfx";
  eventIds: string[];
  comment: string;
}

/** active: 警報・注意報・予報あり / clear: 公式に解除・津波なし / untrusted: 確認できない */
export type WolfxTsunamiState = "active" | "clear" | "untrusted";

export interface WolfxTsunamiResult {
  state: WolfxTsunamiState;
  rawStatus: string;
  reason: string;
  validUntilMs: number | null;
  card: WolfxTsunamiCard | null; // active または clear のとき(clearは取消済みカード)
  eventIds: string[];
}

const LEVEL_TO_GRADE: Record<string, WolfxTsunamiGrade | undefined> = {
  major_warning: "MajorWarning",
  warning: "Warning",
  advisory: "Watch",
  forecast: "NonEffective",
};
const GRADE_WEIGHT: Record<WolfxTsunamiGrade, number> = { MajorWarning: 4, Warning: 3, Watch: 2, NonEffective: 1 };

/** UTC RFC3339 → "YYYY/MM/DD HH:mm:ss"(JST)。解釈できなければ null。 */
export function utcIsoToJstSlash(iso: unknown): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function waveText(w: any): string | null {
  if (!w || typeof w !== "object") return null;
  if (typeof w.text === "string" && w.text) return w.text;
  if (typeof w.height === "number" && Number.isFinite(w.height)) return `${w.height}m`;
  return null;
}

export function parseWolfxTsunami(data: any, nowMs: number): WolfxTsunamiResult {
  const rawStatus = typeof data?.status === "string" ? data.status : "unknown";
  const reason = typeof data?.reason === "string" ? data.reason : "";
  const validUntilMs = typeof data?.validUntil === "string" && data.validUntil ? Date.parse(data.validUntil) : NaN;
  const eventIds: string[] = Array.isArray(data?.report?.eventIds) ? data.report.eventIds.filter((x: unknown) => typeof x === "string") : [];
  const base = { rawStatus, reason, validUntilMs: Number.isFinite(validUntilMs) ? validUntilMs : null, eventIds };

  const withinTrust = data?.trusted === true && Number.isFinite(validUntilMs) && nowMs < validUntilMs;
  if (!withinTrust) return { ...base, state: "untrusted", card: null };

  const time = utcIsoToJstSlash(data?.report?.time) ?? utcIsoToJstSlash(data?.report?.issuedAt) ?? "";
  const comment = [data?.comments?.warning, data?.comments?.forecast, data?.comments?.text]
    .filter((s: unknown) => typeof s === "string" && s).join("\n");
  const id = `wolfx_${data?.report?.id ?? time}`;

  if (rawStatus === "cleared" || rawStatus === "none_reported") {
    return { ...base, state: "clear", card: { id, time, cancelled: true, areas: [], maxGrade: null, source: "wolfx", eventIds, comment } };
  }
  if (rawStatus === "active" || rawStatus === "forecast_only") {
    const areas: WolfxTsunamiArea[] = [];
    for (const a of Array.isArray(data?.areas) ? data.areas : []) {
      const grade = LEVEL_TO_GRADE[a?.level];
      if (!grade || typeof a?.name !== "string") continue;
      areas.push({
        name: a.name,
        grade,
        immediate: false,
        firstHeightCondition: typeof a?.firstWave?.text === "string" && a.firstWave.text ? a.firstWave.text : null,
        firstHeightTime: utcIsoToJstSlash(a?.firstWave?.time),
        maxHeightDescription: waveText(a?.maxWave),
      });
    }
    // 空の予報区は安全を意味しない(公式仕様)ため、確認できない扱いにする
    if (areas.length === 0) return { ...base, state: "untrusted", card: null };
    let maxGrade: WolfxTsunamiGrade | null = null;
    for (const a of areas) if (!maxGrade || GRADE_WEIGHT[a.grade] > GRADE_WEIGHT[maxGrade]) maxGrade = a.grade;
    return { ...base, state: "active", card: { id, time, cancelled: false, areas, maxGrade, source: "wolfx", eventIds, comment } };
  }
  return { ...base, state: "untrusted", card: null };
}
