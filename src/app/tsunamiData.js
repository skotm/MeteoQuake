import { formatQuakeTime } from "./quakeCards";



/* ─────────────────────────────────────────────────────
   津波情報(P2P地震情報 JMATsunami, code:552)
   https://api.p2pquake.net/v2/history?codes=552
   気象庁が発表する津波予報区ごとの津波予報・警報を取得する。
   区分(grade)は MajorWarning(大津波警報) > Warning(津波警報) >
   Watch(津波注意報) > NonEffective(津波予報・若干の海面変動) > Unknown(調査中)
   の順に危険度が高い。1件のレコードに複数の予報区(areas)が含まれるため、
   一覧には「その時点で最も危険度が高いgrade」を代表として表示する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_TSUNAMI_HISTORY_URL_BASE = "https://api.p2pquake.net/v2/history?codes=552";
export const TSUNAMI_FETCH_LIMIT = 50; // 地震に比べて発表頻度が低いため、地震ほど多くの件数は要らない

export const TSUNAMI_GRADE_INFO = {
  MajorWarning: { label: "大津波警報", weight: 4, color: "#BF5AF2" },
  Warning:      { label: "津波警報",   weight: 3, color: "#FF453A" },
  Watch:        { label: "津波注意報", weight: 2, color: "#FFD60A" },
  NonEffective: { label: "津波予報",   weight: 1, color: "#64D2FF" },
  Unknown:      { label: "調査中",     weight: 0, color: "#8E8E93" },
};
export const TSUNAMI_GRADE_FALLBACK = { label: "情報", weight: 0, color: "#8E8E93" };

export function tsunamiGradeInfo(grade) {
  return TSUNAMI_GRADE_INFO[grade] || TSUNAMI_GRADE_FALLBACK;
}

// 観測点の丸・観測された津波の高さバーの色は、予報区の公式なグレード(警報等の
// 種類)ではなく、実際に観測された高さの大小そのものに応じて塗り分ける
// (0.2〜1m=注意報色、1〜3m=警報色、3m以上=大津波警報色、それ未満・未観測は薄グレー)。
// 「観測点」欄の丸は今どれくらいの実況かが一目で分かるように、という考え方。
const TSUNAMI_DOT_DEFAULT_COLOR = "#B9B9C0"; // 観測なし・微弱の間の薄グレー
// 観測された津波の高さ(m)から、相当する警報グレードのキーを求める
// (0.2m未満はnull=グレード相当なし)。地図の観測点の丸・バーの色分けと、
// 右上の凡例のラダー表示(TsunamiGradeLegend)の両方で、しきい値を1箇所に
// まとめておくために使う。
export function tsunamiHeightBandGrade(heightM) {
  if (heightM == null) return null;
  const abs = Math.abs(heightM);
  if (abs >= 3) return "MajorWarning";
  if (abs >= 1) return "Warning";
  if (abs >= 0.2) return "Watch";
  return null;
}
export function tsunamiHeightBandColor(heightM) {
  const grade = tsunamiHeightBandGrade(heightM);
  return grade ? tsunamiGradeInfo(grade).color : TSUNAMI_DOT_DEFAULT_COLOR;
}

// tsunami-areas.json(津波予報区の海岸線)の各featureは properties.name に
// 予報区名を持つ。表示中の津波情報のareas(name+grade)を突き合わせて、
// 該当する予報区だけをgradeの色で塗り、それ以外は透明にするmatch式を作る。
export function buildTsunamiAreaColorExpr(areas) {
  if (!areas || areas.length === 0) return "rgba(0,0,0,0)";
  const expr = ["match", ["get", "name"]];
  const seen = new Set();
  for (const a of areas) {
    if (!a.name || seen.has(a.name)) continue; // 同名予報区が重複していたら最初の1件を優先
    seen.add(a.name);
    expr.push(a.name, tsunamiGradeInfo(a.grade).color);
  }
  if (seen.size === 0) return "rgba(0,0,0,0)";
  expr.push("rgba(0,0,0,0)"); // 対象外の予報区は透明(=非表示)
  return expr;
}

// P2P地震情報APIの1レコード(JMATsunami)を、アプリ内で使う形に変換する
export function toTsunamiCard(item) {
  const areas = Array.isArray(item.areas) ? item.areas.map(a => ({
    name: a.name || "不明な予報区",
    grade: a.grade || "Unknown",
    immediate: !!a.immediate,
    firstHeightCondition: a.firstHeight?.condition || null,
    firstHeightTime: a.firstHeight?.arrivalTime || null,
    maxHeightDescription: a.maxHeight?.description || null,
  })) : [];

  // 全予報区の中で最も危険度が高いgradeを、一覧表示・バッジ色の代表として使う。
  let maxGrade = null;
  let maxWeight = -1;
  areas.forEach(a => {
    const w = tsunamiGradeInfo(a.grade).weight;
    if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
  });

  return {
    id: item.id,
    time: formatQuakeTime(item.time),
    cancelled: !!item.cancelled,
    areas,
    maxGrade: item.cancelled ? null : maxGrade,
  };
}

// 同一idの重複を除いて、新しい順に並べ直す
export function dedupeTsunamiList(list) {
  const byId = new Map();
  for (const t of list) byId.set(t.id, t);
  return Array.from(byId.values()).sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

// 直近の津波情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
export async function fetchRecentTsunamis(limit) {
  const res = await fetch(`${P2PQUAKE_TSUNAMI_HISTORY_URL_BASE}&limit=${limit}`);
  if (!res.ok) throw new Error(`P2P地震情報 津波情報の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return dedupeTsunamiList(data.map(toTsunamiCard));
}

/* ─────────────────────────────────────────────────────
   過去の津波情報(津波タブ「過去」モード)

   【重要】直近一覧(fetchRecentTsunamis)や当初の実装では、地震・EEW等すべての
   コードを1つの領域(capped collection)で共有する/history?codes=552 を使っていたが、
   これは発表頻度の低い津波情報がすぐ押し出されてしまい、offsetで遡っても
   「過去の津波が見つかりません」になりやすい。
   → 津波予報だけを独立して保持している専用API /v2/jma/tsunami に切り替える
     (地震情報の/v2/jma/quakeに相当する、津波版のエンドポイント)。
   さらに気象庁自身が公開している一覧(list.json)も合わせて取得し、両方を
   統合することで、より確実に過去分を取得できるようにする。
     (以前作ったindex.html版アプリのfetchJMATsunamiHistory()と同じ考え方)。
   ───────────────────────────────────────────────────── */
const JMA_TSUNAMI_LIST_URL = "https://www.jma.go.jp/bosai/tsunami/data/list.json";
const JMA_TSUNAMI_HISTORY_LIMIT = 40; // list.json自体は新しい順に並んでいるため、先頭から取得する件数

// 気象庁のReportDateTime("2024-08-08T20:30:00+09:00"のようなISO風文字列、常にJST)を、
// アプリ内で使っている"YYYY/MM/DD HH:mm:ss"形式(P2P地震情報側と揃える。ソート・
// 表示(TsunamiListRowのslice(5,16)等)の両方でこの形式を前提にしているため)に変換する。
function jmaIsoToSlash(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}/${mo}/${d} ${h}:${mi}:${s}`;
}

// 気象庁の個別報(Head/Body形式のJSON)を、アプリ内の津波カード形式(toTsunamiCardと同じ形)に変換する。
function jmaTsunamiReportToCard(report, reportDatetime) {
  const head = report?.Head;
  const issueTime = head?.ReportDateTime || reportDatetime;
  const isCancel = head?.InfoType === "取消";
  const areas = [];
  const forecast = report?.Body?.Tsunami?.Forecast;
  if (forecast?.Item) {
    const items = Array.isArray(forecast.Item) ? forecast.Item : [forecast.Item];
    items.forEach(item => {
      const areaName = item?.Area?.Name || "";
      const kindName = item?.Category?.Kind?.Name || "";
      if (!areaName || kindName.includes("解除")) return;
      let grade = "Unknown";
      if (kindName.includes("大津波")) grade = "MajorWarning";
      else if (kindName.includes("警報")) grade = "Warning";
      else if (kindName.includes("注意報")) grade = "Watch";
      else if (kindName.includes("海面変動") || kindName.includes("予報")) grade = "NonEffective";
      if (grade === "Unknown") return;
      areas.push({
        name: areaName,
        grade,
        immediate: !!item?.FirstHeight?.Condition && item.FirstHeight.Condition.includes("ただちに"),
        firstHeightCondition: item?.FirstHeight?.Condition || null,
        firstHeightTime: item?.FirstHeight?.ArrivalTime || null,
        maxHeightDescription: item?.MaxHeight?.TsunamiHeight?.Description || null,
      });
    });
  }
  let maxGrade = null, maxWeight = -1;
  areas.forEach(a => {
    const w = tsunamiGradeInfo(a.grade).weight;
    if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
  });
  return {
    id: `jma_${reportDatetime}`,
    time: jmaIsoToSlash(issueTime),
    cancelled: isCancel,
    areas,
    maxGrade: isCancel ? null : maxGrade,
  };
}

// 気象庁 津波情報一覧(list.json)を取得し、先頭(新しい順)からJMA_TSUNAMI_HISTORY_LIMIT件、
// 各個別報を取得して津波カードに変換する。1件でも取得に失敗した場合はその1件だけを
// null化して除外し、全体は継続する。
export async function fetchJmaTsunamiHistory(limit = JMA_TSUNAMI_HISTORY_LIMIT) {
  const listRes = await fetch(JMA_TSUNAMI_LIST_URL);
  if (!listRes.ok) throw new Error(`気象庁 津波情報一覧の取得に失敗(HTTP ${listRes.status})`);
  const list = await listRes.json();
  if (!Array.isArray(list)) return [];
  const targets = list.slice(0, limit);
  const cards = await Promise.all(targets.map(async item => {
    try {
      const res = await fetch(`https://www.jma.go.jp/bosai/tsunami/data/${item.json}`);
      if (!res.ok) return null;
      return jmaTsunamiReportToCard(await res.json(), item.reportDatetime);
    } catch {
      return null;
    }
  }));
  return dedupeTsunamiList(cards.filter(Boolean));
}

// 直近一覧(fetchRecentTsunamis, /v2/history?codes=552)とは別の、津波予報専用のJSON API。
// /historyは地震情報等すべてのコードと容量を共有するcapped collectionのため、
// 発表頻度の低い津波情報はすぐ押し出されて過去に遡りにくいが、こちらは津波予報だけを
// 独立して保持しているため、より確実に過去分を取得できる
// (レート制限は/historyの60リクエスト/分より厳しい10リクエスト/分なので、
// 呼びすぎないよう「もっと見る」を押した時だけ叩く)。
const P2PQUAKE_JMA_TSUNAMI_URL = "https://api.p2pquake.net/v2/jma/tsunami";
export const TSUNAMI_HISTORY_PAGE_SIZE = 100; // このAPIの1リクエストあたりの最大件数

export async function fetchTsunamiHistoryPage(offset, limit = TSUNAMI_HISTORY_PAGE_SIZE) {
  const res = await fetch(`${P2PQUAKE_JMA_TSUNAMI_URL}?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`過去の津波情報の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return dedupeTsunamiList(data.map(toTsunamiCard));
}

// 気象庁一覧(primary)とP2P地震情報一覧(supplementary)を統合する。同じ発表が
// 双方に出てくることがあるため、発表時刻が1時間以内に近い場合は重複とみなして
// supplementary側を捨てる(以前のindex.html版アプリと同じ判定基準)。
export function mergeTsunamiSources(primary, supplementary) {
  const merged = [...primary];
  supplementary.forEach(s => {
    const sTime = new Date(s.time).getTime();
    const isDup = merged.some(p => Math.abs(new Date(p.time).getTime() - sTime) < 60 * 60 * 1000);
    if (!isDup) merged.push(s);
  });
  return dedupeTsunamiList(merged);
}
