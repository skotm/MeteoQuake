/* Wolfx Open API: jma_tsunami(全国の津波警報・予報の現在の状態)
   https://wolfx.jp/docs/open-api
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

/** 公式の津波観測報(VTSE51/52)の観測点1件。観測値と沿岸推定は別物として扱う。 */
export interface WolfxTsunamiObservedStation {
  areaName: string;
  name: string;
  code: string | null;
  /** 沖合の観測(VTSE52)の観測機器。例: "ＧＰＳ波浪計"。沿岸の観測点では null。 */
  sensor: string | null;
  /** 最大波の高さ(m)。「巨大」「高い」「以上」などの定性・下限表現の時は null で、text に文言が入る。 */
  maxHeightM: number | null;
  maxText: string | null;
  maxTime: string | null; // "YYYY/MM/DD HH:mm:ss"(JST)
  maxTimeMs: number | null; // 同じ時刻のエポックms(端末のタイムゾーンに依存しない比較・表示用)
  firstTime: string | null;
}

export interface WolfxTsunamiObservations {
  reportId: string | null;
  time: string | null;
  cancelled: boolean;
  observed: WolfxTsunamiObservedStation[];
  estimated: WolfxTsunamiObservedStation[]; // 沿岸での推定(観測値ではない)
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
  /** 関連する津波観測報。無ければ空配列。予報区(areas)は上書きしない。 */
  observations: WolfxTsunamiObservations[];
}

/**
 * active: 警報・注意報・予報あり / clear: 公式に解除・津波なし /
 * expired: Wolfxは正常(trusted・信頼期限内)で、最後の発表の有効期限が切れている(失効) /
 * untrusted: 確認できない(trustedでない・信頼期限切れ・想定外のstatusなど)
 * expiredは「津波なし」とは言い切れない(clearではない)。カードは出さず、失効した旨だけ知らせる。
 */
export type WolfxTsunamiState = "active" | "clear" | "expired" | "untrusted";

export interface WolfxTsunamiResult {
  state: WolfxTsunamiState;
  rawStatus: string;
  reason: string;
  validUntilMs: number | null;
  card: WolfxTsunamiCard | null; // active または clear のとき(clearは取消済みカード)
  eventIds: string[];
  /** expiredのときだけ。失効した最後の発表(表示用。timeは日本時間の"YYYY/MM/DD HH:mm:ss")。 */
  lastReport?: { title: string | null; time: string | null };
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

// 第1波の説明文。実データでは firstWave.condition("ただちに津波来襲と予測"、"第１波の到達を確認"など)。
// 古い想定の firstWave.text にも備える。
function firstWaveCondition(a: any): string {
  const fw = a?.firstWave;
  if (typeof fw?.condition === "string" && fw.condition) return fw.condition;
  if (typeof fw?.text === "string" && fw.text) return fw.text;
  return "";
}

function waveText(w: any): string | null {
  if (!w || typeof w !== "object") return null;
  // 実データ: text("３ｍ"、"１０ｍ超")が最も正確。無ければ数値の高さ(+「超」「以上」)、
  // それも無ければ状態の文言(「観測中」「推定中」「重要」など)を使う。
  if (typeof w.text === "string" && w.text) return w.text;
  if (typeof w.height === "number" && Number.isFinite(w.height)) {
    return `${w.height}m${typeof w.heightCondition === "string" ? w.heightCondition : ""}`;
  }
  if (typeof w.condition === "string" && w.condition) return w.condition;
  return null;
}

function parseObservedStations(list: any): WolfxTsunamiObservedStation[] {
  const out: WolfxTsunamiObservedStation[] = [];
  for (const a of Array.isArray(list) ? list : []) {
    // observed: 予報区(name)の下に観測点(stations)が並ぶ。estimated: 沿岸の推定点が平たく並ぶ(区域なし)。
    const hasStations = Array.isArray(a?.stations);
    const areaName = hasStations && typeof a?.name === "string" ? a.name : "";
    const stations: any[] = hasStations ? a.stations : [a];
    for (const st of stations) {
      if (typeof st?.name !== "string" || !st.name) continue;
      const mw = st?.maxWave;
      const h = typeof mw?.height === "number" && Number.isFinite(mw.height) ? mw.height : null;
      const text = waveText(mw);
      const maxTime = utcIsoToJstSlash(mw?.time);
      const maxTimeMsRaw = typeof mw?.time === "string" ? Date.parse(mw.time) : NaN;
      const firstTime = utcIsoToJstSlash(st?.firstWave?.time);
      if (h == null && !text && !maxTime && !firstTime) continue; // 波情報が無い観測点は載せない
      out.push({ areaName, name: st.name, code: typeof st?.code === "string" ? st.code : null, maxTimeMs: Number.isFinite(maxTimeMsRaw) ? maxTimeMsRaw : null, sensor: typeof st?.sensor === "string" && st.sensor ? st.sensor : null, maxHeightM: h, maxText: text, maxTime, firstTime });
    }
  }
  return out;
}

function parseObservations(data: any): WolfxTsunamiObservations[] {
  const out: WolfxTsunamiObservations[] = [];
  for (const o of Array.isArray(data?.observations) ? data.observations : []) {
    const cancelled = o?.status === "cancelled";
    const observed = cancelled ? [] : parseObservedStations(o?.observed);
    const estimated = cancelled ? [] : parseObservedStations(o?.estimated);
    if (observed.length === 0 && estimated.length === 0) continue;
    out.push({
      reportId: typeof o?.id === "string" ? o.id : null,
      time: utcIsoToJstSlash(o?.time) ?? utcIsoToJstSlash(o?.issuedAt),
      cancelled,
      observed,
      estimated,
    });
  }
  return out;
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
  const observations = parseObservations(data);

  // 失効: Wolfx自体は正常(trusted・信頼期限内)で、最後の公式発表の有効期限が切れている。
  // 予報区は空だが「安全」を意味しないため、clearにはせず、カードも出さない。
  if (rawStatus === "expired") {
    const title = typeof data?.report?.title === "string" && data.report.title ? data.report.title : null;
    return { ...base, state: "expired", card: null, lastReport: { title, time } };
  }

  if (rawStatus === "cleared" || rawStatus === "none_reported") {
    return { ...base, state: "clear", card: { id, time, cancelled: true, areas: [], maxGrade: null, source: "wolfx", eventIds, comment, observations: [] } };
  }
  if (rawStatus === "active" || rawStatus === "forecast_only") {
    const areas: WolfxTsunamiArea[] = [];
    for (const a of Array.isArray(data?.areas) ? data.areas : []) {
      const grade = LEVEL_TO_GRADE[a?.level];
      if (!grade || typeof a?.name !== "string") continue;
      areas.push({
        name: a.name,
        grade,
        // 「ただちに津波来襲と予想」は、第1波の説明文に入る(P2P側の判定と同じ)。
        immediate: firstWaveCondition(a).includes("ただちに"),
        firstHeightCondition: firstWaveCondition(a) || null,
        firstHeightTime: utcIsoToJstSlash(a?.firstWave?.time),
        maxHeightDescription: waveText(a?.maxWave),
      });
    }
    // 空の予報区は安全を意味しない(公式仕様)ため、確認できない扱いにする
    if (areas.length === 0) return { ...base, state: "untrusted", card: null };
    let maxGrade: WolfxTsunamiGrade | null = null;
    for (const a of areas) if (!maxGrade || GRADE_WEIGHT[a.grade] > GRADE_WEIGHT[maxGrade]) maxGrade = a.grade;
    return { ...base, state: "active", card: { id, time, cancelled: false, areas, maxGrade, source: "wolfx", eventIds, comment, observations } };
  }
  return { ...base, state: "untrusted", card: null };
}

/**
 * 津波観測報(複数の報)を、観測点ごとに最新のもの1件にまとめる。
 * 同じ観測点が続報で更新された時は、発表時刻の新しい報の値を採用する(時刻が無い報は最も古い扱い)。
 * observed: 沿岸・沖合の観測点 / estimated: 沿岸での推定点(観測値ではない)。
 */
export function mergeWolfxObservations(observations: WolfxTsunamiObservations[] | undefined | null): {
  observed: WolfxTsunamiObservedStation[];
  estimated: WolfxTsunamiObservedStation[];
} {
  const sorted = [...(observations ?? [])].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  const observed = new Map<string, WolfxTsunamiObservedStation>();
  const estimated = new Map<string, WolfxTsunamiObservedStation>();
  for (const o of sorted) {
    if (o.cancelled) continue;
    for (const st of o.observed) observed.set(`${st.areaName}|${st.code ?? st.name}`, st);
    for (const st of o.estimated) estimated.set(`${st.areaName}|${st.code ?? st.name}`, st);
  }
  return { observed: [...observed.values()], estimated: [...estimated.values()] };
}

/**
 * Wolfx(気象庁の津波観測点)の観測点を、潮位計の観測点(気象庁の潮位API)に、名前で対応づける。
 * 両者の観測点コードは体系が違うため、コードでは突き合わせられない。
 * 予報区名が分かる時は、その予報区に属する潮位計だけを候補にする(同名・類似名の取り違え防止)。
 * 完全一致を優先し、無ければ一方がもう一方を含む場合(例:「むつ市関根浜」と「関根浜」)を採用する。
 */
export function matchTideStationByName<T extends { name: string; tsunamiAreaName?: string }>(
  tideStations: T[],
  areaName: string,
  name: string
): T | null {
  const norm = (s: string) => s.replace(/\s/g, "");
  const n = norm(name);
  if (!n) return null;
  const candidates = areaName ? tideStations.filter((st) => st.tsunamiAreaName === areaName) : tideStations;
  const exact = candidates.find((st) => norm(st.name) === n);
  if (exact) return exact;
  if (n.length < 2) return null;
  return candidates.find((st) => {
    const m = norm(st.name);
    return m.length >= 2 && (n.includes(m) || m.includes(n));
  }) ?? null;
}
