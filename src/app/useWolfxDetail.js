import { useEffect, useState } from "react";
import { parseLongPeriodPayload } from "../longPeriod";
import { wolfxPayloadToQuakeCards } from "../wolfxQuakes";

/* ─────────────────────────────────────────────────────
   Wolfx Open API: jma_earthquake_detail(直近100件の地震の電文を、地震ごとにまとめたもの)
   https://wolfx.jp/docs/open-api
   1回の取得(約250KB)から、次の2つを同時に作る(別々に取りに行かない)。
     ・longPeriod: 長周期地震動階級(Map<eventId, LongPeriodEvent>)
     ・quakeCards: 地震カードの一覧(地震情報の取得元をWolfxにした時に使う)

   更新の検知: jma_eqlist(気象庁 地震情報、最新50件)のWebSocketを購読する。
   ・地震詳細(jma_earthquake_detail)には、WebSocket配信が無い(仕様書で「HTTPのみ」)。
     そのため、WebSocketで届くjma_eqlistの更新(md5の変化)を「詳細を取り直す合図」にして、
     本体はHTTPで取る。
   ・jma_eqlistは、新しい地震や、震源・震度・「info」の補完・訂正があると更新される。詳細側の報の反映が
     少し遅れることがあるため、合図の後に、数秒後と少し後の2回取り直す(md5が同じなら反映しない)。
   ・WebSocketが切れている間だけ、数分おきにHTTPで取り直す(常時ポーリングはしない)。
   ・画面に戻った時にも1回取り直す(長周期の観測情報は地震の約10分後に出るため)。
   needed=falseの間は一切通信しない。
   ───────────────────────────────────────────────────── */
const HTTP_URL = "https://api.wolfx.jp/jma_earthquake_detail.json";
const WS_URL = "wss://ws-api.wolfx.jp/jma_eqlist";
const FALLBACK_POLL_MS = 3 * 60 * 1000;
const RECONNECT_MS = 5000;
const REFETCH_DELAYS_MS = [2000, 20000]; // 合図の何ms後に詳細を取り直すか

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
    let refetchTimers = [];
    let lastDetailMd5 = null; // 詳細の内容が変わっていなければ、再計算・再描画をしない
    let lastEqlistMd5 = null; // jma_eqlistの更新識別子(これが変わったら詳細を取り直す)
    setState((s) => (s.status === "ready" ? s : { ...s, status: "loading" }));

    const apply = (data) => {
      if (cancelled) return;
      const md5 = typeof data?.md5 === "string" ? data.md5 : null;
      if (md5 && md5 === lastDetailMd5) return;
      lastDetailMd5 = md5;
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

    // jma_eqlistの更新を受けた時: 前回の予約を捨てて、詳細を取り直す予約をし直す。
    const scheduleRefetch = () => {
      refetchTimers.forEach(clearTimeout);
      refetchTimers = REFETCH_DELAYS_MS.map((ms) => setTimeout(fetchAll, ms));
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
        if (data?.type === "heartbeat") {
          // 仕様書の推奨: ハートビートにpingを返す。
          try { ws.send("ping"); } catch { /* 無視 */ }
          return;
        }
        if (data?.type !== "jma_eqlist") return; // pongなどは無視する
        const md5 = typeof data.md5 === "string" ? data.md5 : null;
        // 接続直後に届く最初の1通は、すでに取得済みの内容かもしれないので、変化があった時だけ取り直す。
        const changed = lastEqlistMd5 !== null && md5 !== lastEqlistMd5;
        lastEqlistMd5 = md5;
        if (changed) scheduleRefetch();
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
      refetchTimers.forEach(clearTimeout);
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* 無視 */ } }
    };
  }, [needed]);

  return needed ? state : { longPeriod: EMPTY_MAP, quakeCards: EMPTY_LIST, status: "idle" };
}
