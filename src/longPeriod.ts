/**
 * 長周期地震動階級(気象庁「長周期地震動に関する観測情報」, 電文VXSE62)の整理。
 * データ源: Wolfx Open API の jma_earthquake_detail (https://api.wolfx.jp/jma_earthquake_detail.json)
 *
 * 分かっていること(サンプルJSONによる):
 *  ・階級は文字列の"0"〜"4"。無い時はnull。
 *  ・都道府県(prefs)・細分区域(areas)には階級があるが、市区町村(cities)はVXSE62では空。
 *  ・観測点(areas[].stations)に階級があり、観測点コードの先頭5桁が市区町村コード。
 *    そのため、市区町村ごとの階級は「同じ5桁の観測点の最大階級」として自前で求める。
 *    (観測点がある市区町村だけ。観測点のない市区町村は出せない。)
 *  ・eventIdは発生時刻(JST・秒まで)の14桁。
 *  ・観測情報は、地震の約10分後に発表される。
 */

export interface LongPeriodCity { code: string; name: string; lg: number; /** 都道府県名(分かる場合のみ) */ pref?: string }
export interface LongPeriodArea { name: string; lg: number }

export interface LongPeriodEvent {
  /** 14桁のeventId(発生時刻JST、秒まで)。 */
  eventId: string;
  /** 最大長周期地震動階級(0〜4)。 */
  maxLg: number;
  /** 観測情報(VXSE62)が最初に発表された時刻(ms)。リプレイで「まだ出ていない」判定に使う。 */
  issuedAtMs: number | null;
  /** 市区町村ごとの階級(階級の高い順)。観測点の階級0のみの市区町村は含めない。 */
  cities: LongPeriodCity[];
  /** 細分区域ごとの階級(階級の高い順、階級0は含めない)。 */
  areas: LongPeriodArea[];
  /** 震央地名(突き合わせの補助)。 */
  hypocenterName: string | null;
}

/** 区域名(「熊本県熊本」「東京都２３区」など)の先頭から都道府県名を取り出す。分からなければnull。 */
export function prefOfAreaName(name: string): string | null {
  const m = /^(北海道|東京都|大阪府|京都府|.{2,3}?県)/.exec(String(name || ""));
  return m ? m[1] : null;
}

export function parseLg(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
}

/** 観測点名の先頭から、市区町村の表示名を取り出す。
 * 「八代市平山新町」→「八代市」、「名古屋市中区栄」→「名古屋市中区」、「芦北町芦北」→「芦北町」。
 * 町名自体に「町/村」を含む町(大町町など)は、取り違える場合がある。 */
export function cityNameFromStationName(name: string): string {
  const s = String(name || "");
  const m = s.match(/^.+?市(?:[^市町村区]{1,4}区)?/);
  if (m) return m[0];
  const m2 = s.match(/^.+?[区町村]/);
  return m2 ? m2[0] : s;
}

function parseIssuedMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 1つのevent(jma_earthquake_detailのevents[]の1件)から、長周期の情報を取り出す。
 * 長周期の観測情報(VXSE62)が無い、または階級が1つも分からないeventはnullを返す。 */
export function parseLongPeriodEvent(ev: any): LongPeriodEvent | null {
  if (!ev || typeof ev.eventId !== "string" || !Array.isArray(ev.reports)) return null;
  let maxLg: number | null = null;
  let issuedAtMs: number | null = null;
  const cityMap = new Map<string, LongPeriodCity>();
  const areaMap = new Map<string, LongPeriodArea>();
  let found = false;
  for (const r of ev.reports) {
    if (!r || r.product !== "VXSE62" || r.status === "cancelled") continue;
    const o = r.observation;
    if (!o) continue;
    found = true;
    const iss = parseIssuedMs(r.issuedAt) ?? parseIssuedMs(r.time);
    if (iss != null && (issuedAtMs == null || iss < issuedAtMs)) issuedAtMs = iss;
    const mx = parseLg(o.maxLongPeriod);
    if (mx != null && (maxLg == null || mx > maxLg)) maxLg = mx;
    for (const a of Array.isArray(o.areas) ? o.areas : []) {
      const lg = parseLg(a?.lg);
      if (lg != null && lg > 0 && typeof a.name === "string") {
        const cur = areaMap.get(a.name);
        if (!cur || cur.lg < lg) areaMap.set(a.name, { name: a.name, lg });
      }
      if (lg != null && (maxLg == null || lg > maxLg)) maxLg = lg;
      for (const st of Array.isArray(a?.stations) ? a.stations : []) {
        const slg = parseLg(st?.lg);
        const code = typeof st?.code === "string" ? st.code.slice(0, 5) : "";
        if (slg == null || slg <= 0 || code.length !== 5) continue;
        const cur = cityMap.get(code);
        if (!cur || cur.lg < slg) cityMap.set(code, { code, name: cityNameFromStationName(st.name), lg: slg, pref: prefOfAreaName(a.name) ?? undefined });
        if (maxLg == null || slg > maxLg) maxLg = slg;
      }
    }
  }
  if (!found || maxLg == null) return null;
  const byLgDesc = <T extends { lg: number; name: string }>(a: T, b: T) => b.lg - a.lg || a.name.localeCompare(b.name, "ja");
  const hypo = Array.isArray(ev.hypocenters) && typeof ev.hypocenters[0]?.name === "string" ? ev.hypocenters[0].name : null;
  return {
    eventId: ev.eventId,
    maxLg,
    issuedAtMs,
    cities: [...cityMap.values()].sort(byLgDesc),
    areas: [...areaMap.values()].sort(byLgDesc),
    hypocenterName: hypo,
  };
}

/** HTTP/WebSocketの応答(全件{events:[...]}、または1件のevent)から、長周期のあるeventだけを返す。 */
export function parseLongPeriodPayload(data: any): LongPeriodEvent[] {
  const list = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : (data && typeof data.eventId === "string" ? [data] : []);
  const out: LongPeriodEvent[] = [];
  for (const ev of list) {
    const p = parseLongPeriodEvent(ev);
    if (p) out.push(p);
  }
  return out;
}

/** 14桁eventId(JST)から、分までのキー "YYYY/MM/DD HH:mm" を作る。 */
export function eventIdMinuteKey(eventId: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}$/.exec(eventId);
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : null;
}

/** 地震カードの発生時刻("YYYY/MM/DD HH:mm:ss"など)から、分までのキーを作る。 */
export function cardMinuteKey(time: unknown): string | null {
  if (typeof time !== "string") return null;
  const m = /^(\d{4})[\/-](\d{2})[\/-](\d{2})[ T](\d{2}):(\d{2})/.exec(time);
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : null;
}

export interface LongPeriodCardLike { time?: string; place?: string }

/** 地震カードに対応する長周期のeventを探す。
 * 発生時刻(分)が同じものを候補にし、複数あれば震央地名が同じものを選ぶ(それも決まらなければ対応なし)。
 * eqdbのカードも同じ形式のtimeを持つ。 */
export function findLongPeriodFor(card: LongPeriodCardLike, events: Iterable<LongPeriodEvent>): LongPeriodEvent | null {
  const key = cardMinuteKey(card.time);
  if (!key) return null;
  const cands: LongPeriodEvent[] = [];
  for (const e of events) if (eventIdMinuteKey(e.eventId) === key) cands.push(e);
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0];
  const same = cands.filter((e) => e.hypocenterName && e.hypocenterName === card.place);
  return same.length === 1 ? same[0] : null;
}

/** カードの配列に、長周期の情報(longPeriodInfo)と最大階級(longPeriod)を付ける。
 * nowMsを渡すと(リプレイ用)、観測情報の発表がnowMsより後のものは付けない。階級0は付けない。 */
export function attachLongPeriod<T extends LongPeriodCardLike>(
  cards: T[], events: Map<string, LongPeriodEvent>, nowMs: number | null = null,
): Array<T & { longPeriod?: number | null; longPeriodInfo?: LongPeriodEvent | null }> {
  if (events.size === 0) return cards;
  const list = [...events.values()];
  let changed = false;
  const out = cards.map((c) => {
    const e = findLongPeriodFor(c, list);
    if (!e || e.maxLg < 1) return c;
    if (nowMs != null && e.issuedAtMs != null && e.issuedAtMs > nowMs) return c;
    changed = true;
    return { ...c, longPeriod: e.maxLg, longPeriodInfo: e };
  });
  return changed ? out : cards;
}

/** 地震情報テスト配信用: 階級maxLgと、地震カードの観測点から、ダミーの長周期の情報を作る。
 * 市区町村は、観測点名から取り出した名前ごとに、その市区町村の最大震度が大きい順に並べ、
 * 上位1/3に最大階級、次の1/3に階級-1、その次に階級-2を割り当てる(1未満は出さない)。
 * 観測点が無ければ(震度速報だけの時など)、細分区域名を階級maxLgのareasにする。 */
export function buildTestLongPeriodInfo(
  card: { time?: string; place?: string; points?: Array<{ addr: string; scale: number; isArea?: boolean }> },
  maxLg: number,
  issuedAtMs: number | null = null,
): LongPeriodEvent {
  const cityMax = new Map<string, number>();
  const areaMax = new Map<string, number>();
  for (const p of card.points ?? []) {
    if (p.isArea) { areaMax.set(p.addr, Math.max(areaMax.get(p.addr) ?? -1, p.scale)); continue; }
    const name = cityNameFromStationName(p.addr);
    cityMax.set(name, Math.max(cityMax.get(name) ?? -1, p.scale));
  }
  const ranked = [...cityMax.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
  const third = Math.max(1, Math.ceil(ranked.length / 3));
  const cities: LongPeriodCity[] = [];
  ranked.forEach(([name], i) => {
    const lg = maxLg - Math.floor(i / third);
    if (lg >= 1) cities.push({ code: `test${i}`, name, lg });
  });
  const areas: LongPeriodArea[] = cities.length > 0 ? [] : [...areaMax.keys()].slice(0, 6).map((name) => ({ name, lg: maxLg }));
  return { eventId: "test", maxLg, issuedAtMs, cities, areas, hypocenterName: card.place ?? null };
}
