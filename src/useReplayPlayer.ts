/**
 * useReplayPlayer.ts
 * ------------------------------------------------------------
 * バックフィルサーバーで生成したリプレイファイル(protocol.tsと同じ
 * バイナリ形式: ベースラインフレーム1個+差分フレームの連結)を読み込み、
 * 再生する。
 *
 * ファイル形式はリアルタイム配信(/v1/stream)のフレームをそのまま
 * 連結したものなので、デコード自体は realtimeProtocolClient.ts の
 * decodeIntensityDelta をそのまま使い回せる。
 *
 * 再生の考え方:
 *  - 1フレーム目(ベースライン)は全観測点の値を含む
 *  - 2フレーム目以降は「直前との差分」なので、ある時点の値を知るには
 *    先頭から currentIndex 番目までの差分を順に適用(累積)する必要がある
 *  - フレーム数が多い(数千)ケースを想定し、毎回先頭から再生し直すのは
 *    非効率なので、直前のindexからの差分だけを適用する(前進再生時)。
 *    巻き戻し(scrubで過去に戻る)の場合のみ、ベースラインから再計算する。
 *
 * 【フレーム間隔について】
 * リプレイファイルはリアルタイム配信をそのまま録画したものなので、
 * フレーム間隔(dataTimeの差)は必ずしも1秒刻みとは限らない(バックフィル
 * サーバーの録画設定により0.1秒刻みだったり、間引かれて2秒刻みだったり
 * する)。そのため、以下は「1フレーム=1秒」のような固定間隔を前提とせず、
 * 常に実際のdataTimeの差から再生タイミングを計算する。
 *
 * 【再生ロジック(1tick=1フレームではない)】
 * 以前は「waitMsだけ待ってから1フレームだけ進める」という単純な実装だった
 * ため、待ち時間に最低16ms程度の下限を設けていた。これだと、0.1秒刻みの
 * ファイルを高倍速(例: 16倍速)で再生しようとしても、本来必要な待ち時間
 * (100ms/16 ≈ 6.25ms)より下限の方が大きくなってしまい、実際の再生速度が
 * 頭打ちになってしまう問題があった。
 * これに対処するため、tickごとに「経過した実時間 × 速度」から算出した
 * 目標データ時刻(targetDataTimeMs)まで、必要なフレームをまとめて(複数
 * フレーム分でも)一度に適用する方式にした。待ち時間の下限は、タイマーの
 * 発火間隔が短すぎて無駄なCPU消費にならない程度の小さな値(4ms)にとどめて
 * ある。差分フレームはスキップせず全て順に適用する(累積結果に反映する
 * 必要があるため、間引いて適用すると値が壊れる)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { decodeIntensityDelta, type IntensityDeltaMessage } from "./realtimeProtocolClient";

export interface ReplayState {
  loaded: boolean;
  fileName: string | null;
  frames: IntensityDeltaMessage[];
  currentIndex: number; // 0 = ベースラインフレームのみ適用した状態
  isPlaying: boolean;
  speed: number; // 再生速度倍率(1 = 等倍)
  values: Map<number, number>; // currentIndex時点での全観測点の値
  error: string | null;
}

const DEFAULT_SPEED = 4; // リプレイは早送りで見たいことが多いため、デフォルトを等倍より速くしておく
// 再生速度として選べるのは1倍・2倍・4倍のみ(それ以外の値は既定の速度に丸める)。
const ALLOWED_SPEEDS = [1, 2, 4];
// tickの最短待ち時間(ms)。0にすると無駄にCPUを消費するタイマーの連発に
// なるため、ごく小さい値にとどめる(以前は16msだったが、これが0.1秒刻み
// ファイルの高倍速再生を頭打ちにしていたため4msに緩めた)。
const MIN_TICK_WAIT_MS = 4;
// 1フレーム分の実時間換算の待ち時間がこれを超える場合は、この値でクランプ
// する(録画の谷間などで極端に間隔が空いている場合に、いつまでも次の
// tickが来ないのを防ぐ)。
const MAX_REAL_INTERVAL_MS = 5000;

function parseReplayBuffer(buf: ArrayBuffer): IntensityDeltaMessage[] {
  const frames: IntensityDeltaMessage[] = [];
  let offset = 0;
  const view = new DataView(buf);

  while (offset < buf.byteLength) {
    if (buf.byteLength - offset < 7) {
      throw new Error(`フレームヘッダが不完全です(残り${buf.byteLength - offset}byte)`);
    }
    const entryCount = view.getUint16(offset + 5, true);
    const frameSize = 7 + entryCount * 4;
    if (offset + frameSize > buf.byteLength) {
      throw new Error(`フレーム長が不正です(offset=${offset}, frameSize=${frameSize}, total=${buf.byteLength})`);
    }
    const frameBuf = buf.slice(offset, offset + frameSize);
    frames.push(decodeIntensityDelta(frameBuf));
    offset += frameSize;
  }

  if (frames.length === 0) {
    throw new Error("フレームが1件もありません(空のファイル)");
  }

  return frames;
}

/** frames[0](ベースライン)からindex番目までの差分を適用した値を計算する */
function computeValuesAt(frames: IntensityDeltaMessage[], index: number): Map<number, number> {
  const values = new Map<number, number>();
  for (let i = 0; i <= index && i < frames.length; i++) {
    for (const entry of frames[i].entries) {
      if (entry.intensity === null) values.delete(entry.id);
      else values.set(entry.id, entry.intensity);
    }
  }
  return values;
}

export interface ReplayPlayer extends ReplayState {
  loadFile: (file: File) => Promise<void>;
  play: () => void;
  pause: () => void;
  seek: (index: number) => void;
  setSpeed: (speed: number) => void;
  close: () => void;
}

export function useReplayPlayer(): ReplayPlayer {
  const [state, setState] = useState<ReplayState>({
    loaded: false,
    fileName: null,
    frames: [],
    currentIndex: 0,
    isPlaying: false,
    speed: DEFAULT_SPEED,
    values: new Map(),
    error: null,
  });

  // 直前に適用した値(累積結果)をrefでも保持し、1コマ進める時に
  // 全フレーム再計算せず直前の状態から差分だけ足せるようにする。
  const valuesRef = useRef<Map<number, number>>(new Map());
  const framesRef = useRef<IntensityDeltaMessage[]>([]);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFile = useCallback(async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const frames = parseReplayBuffer(buf);
      framesRef.current = frames;
      valuesRef.current = computeValuesAt(frames, 0);
      setState({
        loaded: true,
        fileName: file.name,
        frames,
        currentIndex: 0,
        isPlaying: false,
        speed: DEFAULT_SPEED,
        values: new Map(valuesRef.current),
        error: null,
      });
    } catch (e) {
      setState((prev) => ({ ...prev, loaded: false, error: String(e) }));
    }
  }, []);

  const seek = useCallback((index: number) => {
    const frames = framesRef.current;
    if (frames.length === 0) return;
    const clamped = Math.min(Math.max(index, 0), frames.length - 1);
    valuesRef.current = computeValuesAt(frames, clamped);
    setState((prev) => ({ ...prev, currentIndex: clamped, values: new Map(valuesRef.current) }));
  }, []);

  const play = useCallback(() => setState((prev) => ({ ...prev, isPlaying: true })), []);
  const pause = useCallback(() => setState((prev) => ({ ...prev, isPlaying: false })), []);
  const setSpeed = useCallback((speed: number) => setState((prev) => ({
    ...prev,
    speed: ALLOWED_SPEEDS.includes(speed) ? speed : DEFAULT_SPEED,
  })), []);

  const close = useCallback(() => {
    framesRef.current = [];
    valuesRef.current = new Map();
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    setState({
      loaded: false,
      fileName: null,
      frames: [],
      currentIndex: 0,
      isPlaying: false,
      speed: DEFAULT_SPEED,
      values: new Map(),
      error: null,
    });
  }, []);

  // 再生タイマー: 「経過した実時間 × 速度」から今どこまで進んでいるべきか
  // (targetDataTimeMs)を求め、そこに届くまでのフレームをまとめて適用する。
  // 1フレーム=1tickという前提を置かないため、0.1秒刻み・2秒刻みなど
  // フレーム間隔がどのような値でも同じロジックで正しく扱える。
  useEffect(() => {
    if (!state.isPlaying) return;
    const frames = framesRef.current;
    if (frames.length === 0 || state.currentIndex >= frames.length - 1) {
      setState((prev) => ({ ...prev, isPlaying: false }));
      return;
    }

    const tickStartRealMs = Date.now();
    const startDataTimeMs = frames[state.currentIndex].dataTime.getTime();

    // 次のtickまでの待ち時間の目安(次の1フレーム分の実時間換算)。あくまで
    // 「だいたいこのくらいで次を見に行く」ためのものであり、実際にどこまで
    // 進めるかはtick発火時に改めてtargetDataTimeMsから計算し直す。
    const next = frames[state.currentIndex + 1];
    const realIntervalMs = Math.max(0, next.dataTime.getTime() - startDataTimeMs);
    const cappedIntervalMs = Math.min(realIntervalMs, MAX_REAL_INTERVAL_MS);
    const waitMs = Math.max(MIN_TICK_WAIT_MS, cappedIntervalMs / state.speed);

    playTimerRef.current = setTimeout(() => {
      const elapsedRealMs = Date.now() - tickStartRealMs;
      const targetDataTimeMs = startDataTimeMs + elapsedRealMs * state.speed;

      // startからtargetDataTimeMsに届くところまで、差分を1件ずつ順に適用
      // しながら進める(スキップした場合、途中のフレームの差分が累積結果に
      // 反映されず値が壊れるため、間引かずに全て適用する)。
      let nextIndex = state.currentIndex;
      while (
        nextIndex < frames.length - 1 &&
        frames[nextIndex + 1].dataTime.getTime() <= targetDataTimeMs
      ) {
        nextIndex++;
        for (const entry of frames[nextIndex].entries) {
          if (entry.intensity === null) valuesRef.current.delete(entry.id);
          else valuesRef.current.set(entry.id, entry.intensity);
        }
      }
      // タイマーの発火がわずかに早く、まだ次のフレームに届いていなかった
      // 場合でも、最低1コマは進めて再生が完全に止まって見えないようにする。
      if (nextIndex === state.currentIndex && nextIndex < frames.length - 1) {
        nextIndex++;
        for (const entry of frames[nextIndex].entries) {
          if (entry.intensity === null) valuesRef.current.delete(entry.id);
          else valuesRef.current.set(entry.id, entry.intensity);
        }
      }

      setState((prev) => ({ ...prev, currentIndex: nextIndex, values: new Map(valuesRef.current) }));
    }, waitMs);

    return () => {
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
    };
  }, [state.isPlaying, state.currentIndex, state.speed]);

  return { ...state, loadFile, play, pause, seek, setSpeed, close };
}
