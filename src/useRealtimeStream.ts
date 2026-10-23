/**
 * useRealtimeStream.ts
 * ------------------------------------------------------------
 * リアルタイムタブ用のデータ取得フック。
 *  1. マウント時に GET {baseUrl}/v1/bootstrap で観測点メタデータ+初期値を取得
 *  2. WS {baseUrl}/v1/stream に接続し、以降は差分バイナリを受信
 *  3. 受信値は毎回の再レンダーを避けるため ref に蓄積し、一定間隔
 *     (UPDATE_THROTTLE_MS)でまとめてReact stateへ反映する
 *  4. タブが非アクティブ(enabled=false)になっても即座には切断しない。
 *     DISCONNECT_GRACE_MSの猶予期間中にタブへ戻れば、再接続・再bootstrapを
 *     せずそのまま同じ接続を使い続ける(タブの行き来のたびに毎回
 *     bootstrap+WS再接続が走っていた問題への対応)。猶予期間を過ぎても
 *     非アクティブなままなら、そこで初めて実際に切断する。
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { decodeIntensityDelta, type IntensityEntry } from "./realtimeProtocolClient";

export interface RealtimeStation {
  id: number;
  source: "kmoni" | "snet";
  station_code: string;
  name: string;
  lat: number;
  lon: number;
}

export interface RealtimeStreamState {
  status: "idle" | "connecting" | "open" | "closed" | "error" | "unauthorized";
  stations: RealtimeStation[];
  // id -> 計測震度相当値(データが無い/無効化された観測点はキーごと存在しない)
  values: Map<number, number>;
  serverTime: string | null;
  // 直近に受信したWSメッセージが指すデータ時刻(サーバー側の観測時刻)。
  // bootstrap直後・まだ差分を1件も受け取っていない間はnull。
  dataTime: Date | null;
  lastError: string | null;
}

const UPDATE_THROTTLE_MS = 500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
// タブを離れてから実際に切断するまでの猶予。短いタブの行き来なら
// この間に収まり、接続を維持したままにできる。
const DISCONNECT_GRACE_MS = 60_000;

export function useRealtimeStream(baseUrl: string, enabled: boolean, token?: string): RealtimeStreamState {
  const [state, setState] = useState<RealtimeStreamState>({
    status: "idle",
    stations: [],
    values: new Map(),
    serverTime: null,
    dataTime: null,
    lastError: null,
  });

  // 受信値の実体はrefで持ち、setStateは間引いて呼ぶ
  const valuesRef = useRef<Map<number, number>>(new Map());
  const latestDataTimeRef = useRef<Date | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  // true = baseUrl/tokenの変更またはアンマウントによる完全終了。
  // (enabled=falseの一時停止とは区別する)
  const stoppedRef = useRef(false);
  const connectingOrConnectedRef = useRef(false);

  // enabled切り替え用のeffectから呼び出せるよう、接続開始/切断の実体をrefに保持する
  const connectFnRef = useRef<() => void>(() => {});
  const teardownFnRef = useRef<() => void>(() => {});

  const flush = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    // Mapを複製してstateに渡す(参照を変えないとReactが変化を検知できないため)
    setState((prev) => ({
      ...prev,
      values: new Map(valuesRef.current),
      dataTime: latestDataTimeRef.current,
    }));
  }, []);

  const applyEntries = useCallback((entries: IntensityEntry[]) => {
    for (const e of entries) {
      if (e.intensity === null) {
        valuesRef.current.delete(e.id);
      } else {
        valuesRef.current.set(e.id, e.intensity);
      }
    }
    dirtyRef.current = true;
  }, []);

  // 接続の確立・維持ロジック本体。baseUrl/tokenが変わらない限り、
  // enabledのON/OFF(タブの出入り)では再実行されない。
  useEffect(() => {
    stoppedRef.current = false;
    connectingOrConnectedRef.current = false;

    const httpBase = baseUrl.replace(/\/$/, "");
    const wsBase = httpBase.replace(/^http/, "ws");

    function teardownConnection() {
      wsRef.current?.close();
      wsRef.current = null;
      connectingOrConnectedRef.current = false;
    }

    async function bootstrap() {
      if (stoppedRef.current) return;
      connectingOrConnectedRef.current = true;
      setState((prev) => ({ ...prev, status: "connecting", lastError: null }));
      try {
        const res = await fetch(`${httpBase}/v1/bootstrap`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });

        if (res.status === 401) {
          // トークンが間違っている(または未設定)場合は、何度リトライしても
          // 成功しない。無限リトライで無駄な負荷をかけないよう、ここで
          // 打ち切る。ユーザーがトークンを変更すれば(=token依存のeffectが
          // 再実行されるので)自動的に再挑戦される。
          if (!stoppedRef.current) {
            connectingOrConnectedRef.current = false;
            setState((prev) => ({
              ...prev,
              status: "unauthorized",
              lastError: "認証に失敗しました。アクセストークンを確認してください。",
            }));
          }
          return;
        }

        if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
        const data = await res.json();
        if (stoppedRef.current) return;

        valuesRef.current = new Map(
          (data.values as Array<{ id: number; intensity: number }>).map((v) => [v.id, v.intensity])
        );

        setState((prev) => ({
          ...prev,
          stations: data.stations ?? [],
          values: new Map(valuesRef.current),
          serverTime: data.serverTime ?? null,
        }));

        connectWs();
      } catch (err) {
        if (stoppedRef.current) return;
        connectingOrConnectedRef.current = false;
        setState((prev) => ({ ...prev, status: "error", lastError: String(err) }));
        scheduleReconnect();
      }
    }

    function connectWs() {
      if (stoppedRef.current) return;
      const streamUrl = new URL(`${wsBase}/v1/stream`);
      if (token) streamUrl.searchParams.set("token", token);
      const ws = new WebSocket(streamUrl.toString());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        if (!stoppedRef.current) setState((prev) => ({ ...prev, status: "open", lastError: null }));
      };

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        try {
          const msg = decodeIntensityDelta(ev.data);
          applyEntries(msg.entries);
          latestDataTimeRef.current = msg.dataTime;
          dirtyRef.current = true;
        } catch (err) {
          // 1メッセージのデコード失敗で接続全体を落とす必要は無いので、
          // ログだけ残して読み飛ばす
          console.error("[realtime] decode error", err);
        }
      };

      ws.onclose = () => {
        connectingOrConnectedRef.current = false;
        if (stoppedRef.current) return;
        setState((prev) => ({ ...prev, status: "closed" }));
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onerrorの後にoncloseも呼ばれるので、再接続スケジューリングは
        // oncloseに一本化する(ここでは状態更新のみ)
        if (!stoppedRef.current) setState((prev) => ({ ...prev, status: "error" }));
      };
    }

    function scheduleReconnect() {
      if (stoppedRef.current) return;
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      reconnectTimerRef.current = setTimeout(() => {
        // bootstrapからやり直す(長時間切断していた場合、差分だけでは
        // 状態を正しく復元できないため)
        bootstrap();
      }, delay);
    }

    connectFnRef.current = () => {
      if (stoppedRef.current || connectingOrConnectedRef.current) return;
      bootstrap();
    };
    teardownFnRef.current = teardownConnection;

    flushTimerRef.current = setInterval(flush, UPDATE_THROTTLE_MS);

    return () => {
      // baseUrl/tokenが変わった場合、またはアンマウント時のみ実行される
      // (enabledはこのeffectの依存に含めていないため、タブの出入りでは実行されない)
      stoppedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      teardownConnection();
      latestDataTimeRef.current = null;
      setState({ status: "idle", stations: [], values: new Map(), serverTime: null, dataTime: null, lastError: null });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, token, flush, applyEntries]);

  // enabled(タブのアクティブ/非アクティブ)の切り替えに反応する軽量なeffect。
  // ここではWS接続の生成・破棄そのものは行わず、上のeffectが用意した
  // connectFnRef/teardownFnRef経由で「開始する」「猶予期間後に止める」を
  // 指示するだけ。
  useEffect(() => {
    if (enabled) {
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      connectFnRef.current();
    } else {
      disconnectTimerRef.current = setTimeout(() => {
        teardownFnRef.current();
        setState((prev) => (prev.status === "idle" ? prev : { ...prev, status: "idle" }));
      }, DISCONNECT_GRACE_MS);
    }
  }, [enabled]);

  return state;
}
