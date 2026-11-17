import { useEffect, useMemo, useRef, useState } from "react";
import { fetchRecentQuakes } from "./quakeCards";
import { buildEqdbQuakeCard, eqdbListItemToPreview, fetchEqdbEventCached, fetchEqdbSearch } from "./eqdb";
import { parseQuakeTimeMs, replayQuakeFetchRange, toJstDateAndTime } from "../replayQuakes";

/* ─────────────────────────────────────────────────────
   リプレイ時刻の地震一覧の元データ(最終形の地震カード)を取得するフック。
   取得期間: リプレイ開始の7日前 〜 リプレイ終了。
   取得先: まずP2P地震情報(API)。その期間の情報が無い(リプレイが1週間以上前など)
   場合は気象庁 震度データベース(eqdb)。どちらも失敗/0件なら空のまま(リプレイは続行)。
   段階表示(震度速報→震源情報→詳細)への加工は replayQuakes.ts の replayQuakesAt が行う。
   ───────────────────────────────────────────────────── */
const P2P_FETCH_LIMIT = 1000;
const EQDB_DETAIL_CONCURRENCY = 3;
const EQDB_MAX_ITEMS = 300;

export function useReplayQuakes({ enabled, startMs, endMs, stations, areasGeoJSON }) {
  const [source, setSource] = useState(null); // "p2p" | "eqdb" | null
  const [p2pCards, setP2pCards] = useState([]);
  const [eqdbList, setEqdbList] = useState([]);
  const [details, setDetails] = useState(() => new Map()); // eqdb id -> detail
  const [status, setStatus] = useState("idle"); // idle | loading | ready | empty
  const rangeKey = enabled && startMs != null && endMs != null ? `${startMs}-${endMs}` : null;

  useEffect(() => {
    setSource(null); setP2pCards([]); setEqdbList([]); setDetails(new Map());
    if (!rangeKey) { setStatus("idle"); return; }
    let cancelled = false;
    setStatus("loading");
    const { startMs: fromMs, endMs: toMs } = replayQuakeFetchRange({ startMs, endMs });

    (async () => {
      // 1) P2P地震情報。取得できた最も古い地震が、リプレイ開始より前なら期間を覆えているとみなす。
      try {
        const list = await fetchRecentQuakes(P2P_FETCH_LIMIT);
        const times = list.map(q => parseQuakeTimeMs(q.time)).filter(t => t != null);
        const oldest = times.length ? Math.min(...times) : null;
        if (oldest != null && oldest <= startMs) {
          const inRange = list.filter(q => {
            const t = parseQuakeTimeMs(q.time);
            return t != null && t >= fromMs && t <= toMs;
          });
          if (!cancelled) { setP2pCards(inRange); setSource("p2p"); setStatus(inRange.length ? "ready" : "empty"); }
          return;
        }
      } catch (err) {
        console.warn("[replay-quakes] P2P地震情報の取得に失敗。eqdbにフォールバックします:", err);
      }
      if (cancelled) return;

      // 2) 気象庁 震度データベース(eqdb)。
      try {
        const a = toJstDateAndTime(fromMs), b = toJstDateAndTime(toMs);
        const { list, errMsg } = await fetchEqdbSearch({
          startDate: a.date, startTime: a.time, endDate: b.date, endTime: b.time,
          minMag: 0, maxInt: "1", sort: "S0", epi: "99",
        });
        if (cancelled) return;
        const items = errMsg || !Array.isArray(list) ? [] : list.slice(0, EQDB_MAX_ITEMS);
        setEqdbList(items); setSource("eqdb"); setStatus(items.length ? "ready" : "empty");
        // 観測点別の詳細(震源座標・震度分布)は、少しずつバックグラウンドで取得する。
        let next = 0;
        const worker = async () => {
          while (!cancelled && next < items.length) {
            const item = items[next++];
            try {
              const detail = await fetchEqdbEventCached(item.id);
              if (detail && !cancelled) setDetails(prev => new Map(prev).set(item.id, detail));
            } catch { /* 1件の失敗は無視(一覧のプレビューのまま) */ }
          }
        };
        await Promise.all(Array.from({ length: EQDB_DETAIL_CONCURRENCY }, worker));
      } catch (err) {
        console.warn("[replay-quakes] eqdbの取得に失敗。地震一覧は空のままリプレイします:", err);
        if (!cancelled) setStatus("empty");
      }
    })();
    return () => { cancelled = true; };
  }, [rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const eqdbCards = useMemo(() => eqdbList.map(item => {
    const detail = details.get(item.id);
    if (detail && stations && areasGeoJSON) return buildEqdbQuakeCard(detail, item, stations, areasGeoJSON);
    // 詳細が届くまでは、一覧の情報だけのプレビュー。idは詳細カードと揃えて、選択が外れないようにする。
    return { ...eqdbListItemToPreview(item), id: `eqdb_${item.id}`, points: [], domesticTsunami: "None" };
  }), [eqdbList, details, stations, areasGeoJSON]);

  const cards = source === "p2p" ? p2pCards : source === "eqdb" ? eqdbCards : EMPTY;
  return { cards, source, status };
}
const EMPTY = [];
