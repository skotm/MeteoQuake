


/* ─────────────────────────────────────────────────────
   潮位計(津波タブ「潮位計」モード)
   気象庁 統合地図ページ(map.html#contents=tidelevel)が使っている非公式JSON API。
   ・観測点一覧(静的、めったに変わらない): tide_area.json
   ・観測値(1地点1日1ファイル、15秒間隔): tide_obs_{YYYYMMDD}_{地点コード}.json
   ───────────────────────────────────────────────────── */
const TIDE_AREA_URL = "https://www.jma.go.jp/bosai/tidelevel/const/tide_area.json";

function tideObsUrl(dateStr, stationCode) {
  return `https://www.jma.go.jp/bosai/tidelevel/data/tide/tide_obs_${dateStr}_${stationCode}.json`;
}

// Dateオブジェクトを、tide_obsのURLで使うYYYYMMDD形式(JST基準)に変換する。
export function toTideDateStr(d) {
  const pad2 = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

export async function fetchTideStations() {
  const res = await fetch(TIDE_AREA_URL);
  if (!res.ok) throw new Error(`潮位観測点一覧の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  const stations = [];
  Object.values(data || {}).forEach(class20 => {
    (class20.class30s || []).forEach(class30 => {
      (class30.stations || []).forEach(st => {
        if (st.lat == null || st.lon == null) return;
        stations.push({
          code: st.code,
          name: st.name,
          typeName: st.typeName,
          addr: st.addr,
          reference: st.reference,
          max: st.max || null,
          level4: class30.standard?.level4 ?? null,
          level5: class30.standard?.level5 ?? null,
          areaName: class20.name,
          class20Code: st.parents?.class20 ?? null,
          class30Code: st.parents?.class30 ?? null,
          lat: st.lat,
          lon: st.lon,
        });
      });
    });
  });
  return stations;
}

// 指定地点・指定日の観測値(15秒間隔のtide/departure配列)を取得する。
// dateStrはYYYYMMDD形式(toTideDateStr参照)。
async function fetchTideObs(dateStr, stationCode) {
  const res = await fetch(tideObsUrl(dateStr, stationCode));
  if (!res.ok) throw new Error(`潮位観測値の取得に失敗(HTTP ${res.status})`);
  return res.json();
}

// startDateの暦日〜endDateの暦日までの日数(両端含む)。月またぎ・時刻差は無視して
// 「YYYYMMDDが何日分あるか」だけを見る(fetchTideObsRangeのdaysにそのまま渡す用)。
export function daysBetweenDates(startDate, endDate) {
  const s = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const e = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}

// 指定地点について、当日を含む直近N日分(デフォルト2日=前日+当日)の観測値を取得し、
// 1本の連続した配列に結合する。日をまたぐ津波でも0時で表示が途切れないようにするため。
// 前日ファイルが欠測/取得失敗の場合は、当日から遡って「連続して取得できた分」だけを
// 採用する(=当日分さえ取れれば、以前と同じ1日分の挙動にフォールバックする)。
export async function fetchTideObsRange(stationCode, days = 2) {
  const today = new Date();
  const dateStrs = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dateStrs.push(toTideDateStr(d));
  }
  const settled = await Promise.allSettled(dateStrs.map(ds => fetchTideObs(ds, stationCode)));

  const ordered = [];
  for (let i = settled.length - 1; i >= 0; i--) {
    if (settled[i].status !== "fulfilled") break; // 途切れた時点で遡るのをやめる(古い日だけ欠測でもOK)
    ordered.unshift(settled[i].value);
  }
  if (ordered.length === 0) throw new Error("潮位観測値の取得に失敗");

  return {
    ...ordered[ordered.length - 1], // interval等のメタ情報は当日分を踏襲
    time: ordered[0].time,          // 一番古い日の開始時刻を全体の起点にする
    tide: ordered.flatMap(d => Array.isArray(d.tide) ? d.tide : []),
    departure: ordered.flatMap(d => Array.isArray(d.departure) ? d.departure : []),
  };
}

// startDate〜endDateの暦日(両端含む)について、1地点分の観測値を1日ずつ取得し、
// 1本の配列に結合する。fetchTideObsRangeは「当日を含む直近N日」専用(常に今日を
// 終端にする)なので、過去の津波情報(履歴)を選んで見る時のために、任意の過去の
// 期間を扱えるこちらを別途用意する。取得できなかった日(欠測・レート制限等)は
// 読み飛ばし、取得できた日だけを時系列順に繋げる(最大波さえ拾えれば十分なため、
// fetchTideObsRangeのように欠測で即座に打ち切ることはしない)。
export async function fetchTideObsForDateRange(stationCode, startDate, endDate) {
  const dateStrs = [];
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const last = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  while (cur.getTime() <= last.getTime()) {
    dateStrs.push(toTideDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  const settled = await Promise.allSettled(dateStrs.map(ds => fetchTideObs(ds, stationCode)));
  const ordered = settled.filter(s => s.status === "fulfilled").map(s => s.value);
  if (ordered.length === 0) throw new Error("潮位観測値の取得に失敗");

  return {
    ...ordered[ordered.length - 1],
    time: ordered[0].time,
    tide: ordered.flatMap(d => Array.isArray(d.tide) ? d.tide : []),
    departure: ordered.flatMap(d => Array.isArray(d.departure) ? d.departure : []),
  };
}

// 観測された津波の高さ(推定)を、潮位観測データから計算する。
// 気象庁の解説(https://www.jma.go.jp/jma/kishou/know/jishin/joho/tsunamiinfo.html)の
// 「津波観測に関する情報」が示す考え方どおり、潮位の実測値から天文潮位(推算潮位)を
// 差し引いた値が津波による海面変動の高さにあたる。この値はtide_obsのdeparture配列に
// そのまま「潮位偏差」として入っている(このアプリのTideStationDetailで表示している
// ものと同じ値)ため、追加の逆算はせずdepartureをそのまま使う。
// startMs以降(=警報等の発表時刻以降)で、潮位偏差が正の値(山=海面上昇側)のうち
// 最大のものを返す。引き波による谷(負の値)は津波の「高さ」としては扱わない。
// データの終端は「取得できている最新時点まで」が自動的に上限になるため、終了時刻を
// 別途指定する必要はない。該当データ(正の値)が無ければnull。
export function computeMaxTsunamiHeightCm(obsData, startMs) {
  if (!obsData || !Array.isArray(obsData.departure) || !obsData.time) return null;
  const dayStartMs = new Date(obsData.time).getTime();
  if (!Number.isFinite(dayStartMs) || !Number.isFinite(startMs)) return null;
  const intervalMs = (obsData.interval || 15) * 1000;
  let max = -Infinity;
  let timeMsAtMax = null;
  obsData.departure.forEach((v, i) => {
    if (v == null || v <= 0) return; // 正の値(山)のみを対象にする
    const t = dayStartMs + i * intervalMs;
    if (t < startMs) return; // 警報発表より前の値は対象外
    if (v > max) { max = v; timeMsAtMax = t; }
  });
  if (timeMsAtMax == null) return null;
  return { cm: max, timeMs: timeMsAtMax }; // cm(常に正の値)・観測時刻(エポックms)。該当データが1件も無ければnull
}
