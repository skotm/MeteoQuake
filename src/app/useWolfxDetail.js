import { useEffect, useState } from "react";
import { parseLongPeriodPayload } from "../longPeriod";
import { wolfxPayloadToQuakeCards } from "../wolfxQuakes";

/* ─────────────────────────────────────────────────────
   Wolfx Open API: jma_earthquake_detail(直近100件の地震の電文を、地震ごとにまとめたもの)
   https://wolfx.jp/apidoc
   1回の取得(約250KB)から、次の2つを同時に作る(別々に取りに行かない)。
     ・longPeriod: 長周期地震動階級(Map<eventId, LongPeriodEvent>)
     ・quakeCards: 地震カードの一覧(地震情報の取得元をWolfxにした時に使う)
   ・起動時にHTTPで1回取得し、以降はWebSocketの通知を受ける。
   ・WebSocketが全件を送ってくる場合はそのまま使う。1件だけ(またはそれ以外)の場合、
     部分的なデータで全体を壊さないよう、少し待ってからHTTPで取り直す。
   ・WebSocketが切れている間だけ、数分おきにHTTPで取り直す(常時ポーリングはしない)。
   ・画面に戻った時にも1回取り直す(長周期の観測情報は地震の約10分後に出るため)。
   needed=falseの間は一切通信しない。
   ───────────────────────────────────────────────────── */
const HTTP_URL = "https://api.wolfx.jp/jma_earthquake_detail.json";
const WS_URL = "wss://ws-api.wolfx.jp/jma_earthquake_detail";
const FALLBACK_POLL_MS = 3 * 60 * 1000;
const RECONNECT_MS = 5000;
const REFETCH_DEBOUNCE_MS = 3000;
const FULL_LIST_MIN = 20; // これ以上の件数が来たら「全件」とみなす

const EMPTY_MAP = new Map();
const EMPTY_LIST = [];

export function useWolfxDetail(needed) {
  const [state, setState] = useState({ longPeriod: EMPTY_MAP, quakeCards: EMPTY_LIST, status: "idle" });

  useEffect(() => {
    if (!needed) return undefined;
    let cancelled = false;
    let ws = null;
    let wsOpen = false;
    let reconnectTimer = null;
    let pollTimer = null;
    let refetchTimer = null;
    setState((s) => (s.status === "ready" ? s : { ...s, status: "loading" }));

    const apply = (data) => {
      if (cancelled) return;
      const longPeriod = new Map(parseLongPeriodPayload(data).map((e) => [e.eventId, e]));
      setState({ longPeriod, quakeCards: wolfxPayloadToQuakeCards(data), status: "ready" });
    };

    const fetchAll = async () => {
      try {
        const res = await fetch(HTTP_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        apply(await res.json());
      } catch (err) {
        console.warn("Wolfxの地震情報(jma_earthquake_detail)の取得に失敗:", err);
        if (!cancelled) setState((s) => (s.status === "ready" ? s : { ...s, status: "error" }));
      }
    };

    const scheduleRefetch = () => {
      if (refetchTimer) return;
      refetchTimer = setTimeout(() => { refetchTimer = null; fetchAll(); }, REFETCH_DEBOUNCE_MS);
    };

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        reconnectTimer = setTimeout(connect, RECONNECT_MS * 6);
        return;
      }
      ws.onopen = () => { wsOpen = true; };
      ws.onmessage = (ev) => {
        let data;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (Array.isArray(data?.events) && data.events.length >= FULL_LIST_MIN) apply(data);
        else if (data && (Array.isArray(data.events) || typeof data.eventId === "string")) scheduleRefetch();
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
      if (refetchTimer) clearTimeout(refetchTimer);
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* 無視 */ } }
    };
  }, [needed]);

  return needed ? state : { longPeriod: EMPTY_MAP, quakeCards: EMPTY_LIST, status: "idle" };
}
