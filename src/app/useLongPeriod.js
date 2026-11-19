import { useEffect, useRef, useState } from "react";
import { parseLongPeriodPayload } from "../longPeriod";

/* ─────────────────────────────────────────────────────
   長周期地震動階級(Wolfx Open API: jma_earthquake_detail)
   https://wolfx.jp/apidoc
   ・起動時にHTTPで1回(直近100件・約250KB)取得し、以降はWebSocketで届く更新を受ける。
   ・WebSocketが切れている間だけ、数分おきにHTTPで取り直す(通信量を抑えるため、常時のポーリングはしない)。
   ・長周期の観測情報は地震の約10分後に出るので、画面に戻った時にも1回取り直す。
   戻り値: Map<eventId, LongPeriodEvent>(長周期の観測情報があるeventだけ)
   ───────────────────────────────────────────────────── */
const HTTP_URL = "https://api.wolfx.jp/jma_earthquake_detail.json";
const WS_URL = "wss://ws-api.wolfx.jp/jma_earthquake_detail";
const FALLBACK_POLL_MS = 3 * 60 * 1000;
const RECONNECT_MS = 5000;
const MAX_KEEP = 200;

const EMPTY = new Map();

export function useLongPeriod(enabled) {
  const [events, setEvents] = useState(EMPTY);
  const mapRef = useRef(new Map());

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let ws = null;
    let wsOpen = false;
    let reconnectTimer = null;
    let pollTimer = null;

    const merge = (list, replaceAll) => {
      if (cancelled) return;
      const m = replaceAll ? new Map() : new Map(mapRef.current);
      for (const e of list) m.set(e.eventId, e);
      // 古いものから捨てる(eventIdは発生時刻なので、文字列の降順で新しいものを残す)
      if (m.size > MAX_KEEP) {
        const keep = [...m.keys()].sort().slice(-MAX_KEEP);
        for (const k of [...m.keys()]) if (!keep.includes(k)) m.delete(k);
      }
      mapRef.current = m;
      setEvents(m);
    };

    const fetchAll = async () => {
      try {
        const res = await fetch(HTTP_URL);
        if (!res.ok) return;
        merge(parseLongPeriodPayload(await res.json()), true);
      } catch (err) {
        console.warn("長周期地震動階級の取得に失敗:", err);
      }
    };

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        reconnectTimer = setTimeout(connect, RECONNECT_MS * 6);
        return;
      }
      ws.onopen = () => { wsOpen = true; };
      ws.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        // 全件({events:[...]})でも、1件でも受け取れるようにしておく。
        const list = parseLongPeriodPayload(data);
        if (list.length > 0) merge(list, false);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        wsOpen = false;
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, RECONNECT_MS);
      };
    };

    const onVisible = () => { if (document.visibilityState === "visible") fetchAll(); };

    fetchAll();
    connect();
    pollTimer = setInterval(() => { if (!wsOpen) fetchAll(); }, FALLBACK_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* 無視 */ } }
    };
  }, [enabled]);

  return enabled ? events : EMPTY;
}
