import { useEffect, useState } from "react";
import { parseWolfxTsunami } from "../wolfxTsunami";

/* ─────────────────────────────────────────────────────
   Wolfx Open API: jma_tsunami(津波警報・予報の現在の状態)
   ・起動時にHTTPで1回取得し、以降はWebSocketで更新を受ける。
   ・再接続したときは、差分ではなく必ずHTTPで全体を取り直す(公式の推奨)。
   ・validUntil(信頼期限)は、サーバー側の更新が止まっても切れるよう、
     クライアントでも1分ごとに再判定する(生のJSONを保持して再解析する)。
   ・WebSocketが切れている間だけ、数分おきにHTTPで取り直す。
   needed=falseの間は一切通信しない。
   ───────────────────────────────────────────────────── */
const HTTP_URL = "https://api.wolfx.jp/jma_tsunami.json";
const WS_URL = "wss://ws-api.wolfx.jp/jma_tsunami";
const FALLBACK_POLL_MS = 2 * 60 * 1000;
const RECHECK_MS = 60 * 1000;
const RECONNECT_MS = 5000;

const IDLE = { status: "idle", result: null };

export function useWolfxTsunami(needed) {
  const [raw, setRaw] = useState(null); // 最後に受け取った生のJSON
  const [loadState, setLoadState] = useState("idle"); // idle | loading | ready | error
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!needed) return undefined;
    let cancelled = false;
    let ws = null;
    let wsOpen = false;
    let reconnectTimer = null;
    let pollTimer = null;
    setLoadState((s) => (s === "ready" ? s : "loading"));

    const apply = (data) => {
      if (cancelled || !data || typeof data !== "object") return;
      setRaw(data);
      setNowMs(Date.now());
      setLoadState("ready");
    };
    const fetchAll = async () => {
      try {
        const res = await fetch(HTTP_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        apply(await res.json());
      } catch (err) {
        console.warn("Wolfxの津波情報(jma_tsunami)の取得に失敗:", err);
        if (!cancelled) setLoadState((s) => (s === "ready" ? s : "error"));
      }
    };
    const connect = () => {
      if (cancelled) return;
      try { ws = new WebSocket(WS_URL); } catch { reconnectTimer = setTimeout(connect, RECONNECT_MS * 6); return; }
      ws.onopen = () => { wsOpen = true; fetchAll(); }; // 再接続時は全体を取り直す
      ws.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (data && typeof data.status === "string") apply(data);
      };
      ws.onerror = () => {};
      ws.onclose = () => { wsOpen = false; if (!cancelled) reconnectTimer = setTimeout(connect, RECONNECT_MS); };
    };
    const onVisible = () => { if (document.visibilityState === "visible") fetchAll(); };

    fetchAll();
    connect();
    pollTimer = setInterval(() => { if (!wsOpen) fetchAll(); }, FALLBACK_POLL_MS);
    const recheckTimer = setInterval(() => setNowMs(Date.now()), RECHECK_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollTimer) clearInterval(pollTimer);
      clearInterval(recheckTimer);
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* 無視 */ } }
    };
  }, [needed]);

  if (!needed) return IDLE;
  if (raw == null) return { status: loadState, result: null };
  return { status: loadState, result: parseWolfxTsunami(raw, nowMs) };
}
