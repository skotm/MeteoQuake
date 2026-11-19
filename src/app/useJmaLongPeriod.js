import { useEffect, useRef, useState } from "react";
import { cardMinuteKey, eventIdMinuteKey } from "../longPeriod";
import { JMA_LP_PAST_LIST_URL, decodeCsvBytes, jmaLpLevelCsvUrl, parseJmaLevelCsv, parseJmaPastList } from "../jmaLongPeriod";

/* ─────────────────────────────────────────────────────
   気象庁の「長周期地震動に関する観測情報(過去の地震)」から、Wolfxに無い過去の地震の階級を補う。
   ・一覧(past_list.html)を1回だけ取得し、表示中の地震と発生時刻(分)が合うeventだけ level.csv を取りに行く。
   ・取得結果は(失敗も)モジュール内に覚え、同じeventは二度取らない。同時取得は少数に絞る。
   ・enabled=false、または対象の地震が無い間は通信しない。
   ───────────────────────────────────────────────────── */
const EMPTY = new Map();
const MAX_PARALLEL = 3;
let listPromise = null;
const eventCache = new Map(); // eventId -> LongPeriodEvent | null(取得済みで階級なし/失敗)
const inflight = new Set();

function loadList() {
  if (!listPromise) {
    listPromise = fetch(JMA_LP_PAST_LIST_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(parseJmaPastList)
      .catch((err) => { console.warn("気象庁の長周期地震動の一覧の取得に失敗:", err); listPromise = null; return []; });
  }
  return listPromise;
}

async function loadEvent(eventId) {
  try {
    const res = await fetch(jmaLpLevelCsvUrl(eventId));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    eventCache.set(eventId, parseJmaLevelCsv(decodeCsvBytes(await res.arrayBuffer()), eventId));
  } catch (err) {
    console.warn("気象庁の長周期地震動階級(level.csv)の取得に失敗:", eventId, err);
    eventCache.set(eventId, null);
  }
}

export function useJmaLongPeriod(cards, enabled, skipMinuteKeys) {
  const [events, setEvents] = useState(EMPTY);
  const versionRef = useRef(0);

  useEffect(() => {
    if (!enabled || !Array.isArray(cards) || cards.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      const ids = await loadList();
      if (cancelled || ids.length === 0) return;
      const byMinute = new Map();
      for (const id of ids) {
        const k = eventIdMinuteKey(id);
        if (k) { if (!byMinute.has(k)) byMinute.set(k, []); byMinute.get(k).push(id); }
      }
      const want = new Set();
      for (const c of cards) {
        const k = cardMinuteKey(c.time);
        if (!k || skipMinuteKeys?.has(k)) continue;
        for (const id of byMinute.get(k) ?? []) if (!eventCache.has(id) && !inflight.has(id)) want.add(id);
      }
      const queue = [...want];
      const worker = async () => {
        while (queue.length > 0 && !cancelled) {
          const id = queue.shift();
          inflight.add(id);
          await loadEvent(id);
          inflight.delete(id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, worker));
      if (cancelled) return;
      const m = new Map();
      for (const [id, e] of eventCache) if (e) m.set(id, e);
      versionRef.current += 1;
      setEvents((prev) => (prev.size === m.size && [...m.keys()].every((k) => prev.has(k)) ? prev : m));
    })();
    return () => { cancelled = true; };
  }, [cards, enabled, skipMinuteKeys]);

  return enabled ? events : EMPTY;
}
