/**
 * Wolfx Open API の jma_earthquake_detail のevent(1件)を、アプリの地震カード
 * (P2P地震情報のtoQuakeCardと同じ形)に変換する。
 *
 * ・震度速報(VXSE51)→震源に関する情報(VXSE52)→震源・震度に関する情報(VXSE53)の順に電文が増える。
 *   stageは、持っている電文の最も進んだものに合わせる(prompt / destination / detail)。
 * ・観測点の震度(points)は、VXSE53の市区町村→観測点から作る。VXSE51しか無い間は、
 *   細分区域ごとの震度(isArea:true)を使う。
 * ・震度は文字列("1"〜"4","5-","5+","6-","6+","7")。アプリ内のキーと同じ表記。
 * ・idは"wolfx_<eventId>"で、電文が増えても変わらない(一覧で選択中の地震が途中で外れないため)。
 */

export interface WolfxPoint { pref: string; addr: string; scale: number; isArea: boolean }
export interface WolfxQuakeCard {
  id: string;
  time: string;
  issueTime: string | null;
  stage: "prompt" | "destination" | "detail";
  place: string;
  maxIntensity: string;
  isForeign: boolean;
  magnitude: number | null;
  depth: number | null;
  longPeriod: null;
  latitude: number | null;
  longitude: number | null;
  points: WolfxPoint[];
  domesticTsunami: string;
  freeFormComment: string | null;
  source: "wolfx";
}

const INT_TO_SCALE: Record<string, number> = {
  "0": 0, "1": 10, "2": 20, "3": 30, "4": 40, "5-": 45, "5+": 50, "6-": 55, "6+": 60, "7": 70,
};

function intToScale(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const s = v.replace("弱", "-").replace("強", "+").trim();
  return s in INT_TO_SCALE ? INT_TO_SCALE[s] : null;
}

/** 震度の文字列を、アプリ内の震度キー("0"〜"4","5-","5+","6-","6+","7","5u","?")にする。 */
export function intToIntensityKey(v: unknown): string {
  if (typeof v !== "string") return "?";
  if (v.includes("未入電")) return "5u";
  const sc = intToScale(v);
  if (sc == null) return "?";
  const inv: Record<number, string> = { 0: "0", 10: "1", 20: "2", 30: "3", 40: "4", 45: "5-", 50: "5+", 55: "6-", 60: "6+", 70: "7" };
  return inv[sc] ?? "?";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** UTCのISO文字列を、日本時間の"YYYY/MM/DD HH:mm:ss"にする。 */
export function isoToJstDisplay(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** 津波に関する文(comments.forecast)から、アプリ内のdomesticTsunami値を作る。 */
export function tsunamiFromForecast(text: unknown): string {
  const s = typeof text === "string" ? text : "";
  if (/大津波警報/.test(s)) return "MajorWarning";
  if (/津波警報/.test(s)) return "Warning";
  if (/津波注意報/.test(s)) return "Watch";
  if (/若干の海面変動/.test(s)) return "NonEffective";
  if (/津波の心配はありません/.test(s)) return "None";
  if (/調査中/.test(s)) return "Checking";
  return "Unknown";
}

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function wolfxEventToQuakeCard(ev: any): WolfxQuakeCard | null {
  if (!ev || typeof ev.eventId !== "string" || !Array.isArray(ev.reports)) return null;
  const reports = ev.reports.filter((r: any) => r && r.status !== "cancelled");
  const by = (p: string) => reports.filter((r: any) => r.product === p).sort((a: any, b: any) => String(a.issuedAt).localeCompare(String(b.issuedAt)));
  const v51 = by("VXSE51").at(-1), v52 = by("VXSE52").at(-1), v53 = by("VXSE53").at(-1);
  const main = v53 || v52 || v51;
  if (!main) return null; // 長周期だけ・更新のお知らせだけのeventは地震情報として出さない
  if (ev.status === "cancelled") return null;

  const stage: WolfxQuakeCard["stage"] = v53 ? "detail" : v52 ? "destination" : "prompt";
  const hypos: any[] = Array.isArray(ev.hypocenters) ? ev.hypocenters : [];
  const detailSrc = v53 || v52 || reports.find((r: any) => r.hypocenter != null);
  const hypo = hypos[typeof detailSrc?.hypocenter === "number" ? detailSrc.hypocenter : 0] ?? hypos[0] ?? null;

  const originIso = (v53 || v52 || reports.find((r: any) => r.originTime))?.originTime
    ?? reports.find((r: any) => r.originTime)?.originTime ?? null;
  const time = isoToJstDisplay(originIso) ?? (/^\d{14}$/.test(ev.eventId)
    ? `${ev.eventId.slice(0, 4)}/${ev.eventId.slice(4, 6)}/${ev.eventId.slice(6, 8)} ${ev.eventId.slice(8, 10)}:${ev.eventId.slice(10, 12)}:00` : "");

  // 観測(震度)の出どころ: VXSE53 > VXSE51
  const obsRep = v53?.observation ? v53 : (v51?.observation ? v51 : null);
  const obs = obsRep?.observation ?? null;
  const prefs: any[] = Array.isArray(obs?.prefs) ? obs.prefs : [];
  const points: WolfxPoint[] = [];
  if (obs) {
    if (v53?.observation && Array.isArray(obs.cities) && obs.cities.length > 0) {
      const areas: any[] = Array.isArray(obs.areas) ? obs.areas : [];
      for (const c of obs.cities) {
        const area = areas[typeof c.area === "number" ? c.area : -1];
        const prefName = prefs[typeof area?.pref === "number" ? area.pref : -1]?.name ?? "";
        for (const st of Array.isArray(c.stations) ? c.stations : []) {
          const sc = intToScale(st.int);
          if (sc == null || typeof st.name !== "string") continue;
          points.push({ pref: prefName, addr: st.name.replace(/＊/g, "*"), scale: sc, isArea: false });
        }
      }
    } else if (Array.isArray(obs.areas)) {
      for (const a of obs.areas) {
        const sc = intToScale(a.int);
        if (sc == null || typeof a.name !== "string") continue;
        points.push({ pref: prefs[typeof a.pref === "number" ? a.pref : -1]?.name ?? "", addr: a.name, scale: sc, isArea: true });
      }
    }
  }

  let maxIntensity = obs ? intToIntensityKey(obs.maxIntensity) : "?";
  if (maxIntensity === "?" && points.length > 0) {
    const mx = points.reduce((m, p) => Math.max(m, p.scale), -1);
    const inv: Record<number, string> = { 0: "0", 10: "1", 20: "2", 30: "3", 40: "4", 45: "5-", 50: "5+", 55: "6-", 60: "6+", 70: "7" };
    maxIntensity = inv[mx] ?? "?";
  }

  const latest = reports.slice().sort((a: any, b: any) => String(a.issuedAt).localeCompare(String(b.issuedAt))).at(-1);
  const forecastSrc = (v53 || v52 || v51)?.comments?.forecast;
  const depthRaw = asNum(hypo?.depth);
  const mag = asNum((v53 || v52)?.magnitude);

  return {
    id: `wolfx_${ev.eventId}`,
    time,
    issueTime: typeof latest?.issuedAt === "string" ? latest.issuedAt : null,
    stage,
    place: typeof hypo?.name === "string" && hypo.name ? hypo.name : (stage === "prompt" ? "震源調査中" : "震源地不明"),
    maxIntensity,
    isForeign: false,
    magnitude: mag != null && mag > 0 ? mag : null,
    depth: depthRaw != null && depthRaw >= 0 ? Math.round(depthRaw) : null,
    longPeriod: null,
    latitude: asNum(hypo?.latitude),
    longitude: asNum(hypo?.longitude),
    points,
    domesticTsunami: tsunamiFromForecast(forecastSrc),
    freeFormComment: typeof v53?.comments?.note === "string" ? v53.comments.note : null,
    source: "wolfx",
  };
}

/** 新しい発生時刻の順に並べたカードを返す。 */
export function wolfxPayloadToQuakeCards(data: any): WolfxQuakeCard[] {
  const list = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : (data && typeof data.eventId === "string" ? [data] : []);
  const out: WolfxQuakeCard[] = [];
  for (const ev of list) { const c = wolfxEventToQuakeCard(ev); if (c) out.push(c); }
  return out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}
