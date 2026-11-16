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
import {
  buildEewOnlyFramesFor, eewListRange, eewRangeNote, extendFramesForEews, MAX_EEW_ONLY_SPAN_MS,
  parseReplayEewJson, replayStartForList, type ReplayEewData,
} from "./replayEew";

export interface ReplayEewEntry {
  /** 地震の識別子(eventId)。 */
  id: string;
  fileName: string;
  data: ReplayEewData;
  /** このEEWの時刻が震度ファイルの範囲と合わない時の注意文。 */
  note: string | null;
}

export interface ReplayState {
  /** 震度ファイル(.bin)かEEWファイル(.eew.json)の、どちらかでも読み込まれていればtrue。 */
  loaded: boolean;
  /** 震度ファイル(.bin)の名前。EEWだけの時はnull。 */
  fileName: string | null;
  /** 震度ファイル(.bin)を読み込んでいるか。falseでloadedがtrueならEEWだけの再生(値が空のフレーム)。 */
  hasBin: boolean;
  /** 読み込んだEEW(.eew.json)。複数読み込める。同じ地震(eventId)は後から読んだ方に置き換わる。発生時刻順。 */
  eews: ReplayEewEntry[];
  frames: IntensityDeltaMessage[];
  currentIndex: number; // 0 = ベースラインフレームのみ適用した状態
  /**
   * 再生時刻(UTCミリ秒)。フレームの時刻に丸めない連続した時計で、再生中は実時間×速度で進む。
   * EEWの表示・P波S波の円は、すべてこの時計で決める(震度のフレームとEEWを同じ時計で動かすため)。
   */
  clockMs: number | null;
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
// EEWを読み込んでいる間、再生時計(clockMs)を更新する最長の間隔(実時間ms)。
// フレームの間隔が長くても、EEWの報がこの粒度で切り替わるようにする(報が飛ばないようにするため)。
const EEW_TICK_MS = 100;

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
  /** EEWファイル(.eew.json)を読み込む。複数のファイルをまとめて渡せる。 */
  loadEewFiles: (files: File[]) => Promise<void>;
  /** 指定した地震(id)のEEWだけを外す。 */
  removeEew: (id: string) => void;
  /** EEWをすべて外す。 */
  clearEew: () => void;
  closeBin: () => void;
  play: () => void;
  pause: () => void;
  seek: (index: number) => void;
  setSpeed: (speed: number) => void;
  close: () => void;
}

/** dataTimeが ms 以下の最後のフレームの番号(binary search)。ms がベースラインより前なら0。 */
function frameIndexAtOrBefore(frames: IntensityDeltaMessage[], ms: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].dataTime.getTime() <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 読み込み直後の再生位置(UTCミリ秒)。EEWがあり、その地震の発生時刻がフレームの範囲内なら、
 * そこから始める(複数あれば、最も早い地震から)。無ければ先頭から。
 */
function initialClockMs(frames: IntensityDeltaMessage[], eews: ReplayEewData[]): number {
  const first = frames[0].dataTime.getTime();
  const last = frames[frames.length - 1].dataTime.getTime();
  return replayStartForList(eews, first, last) ?? first;
}

/** 震度ファイルとEEWから、再生に使うフレームを作る。震度ファイルがあればそれ(EEWの範囲まで延ばす)、無ければEEWの範囲の空のフレーム。 */
function composeFrames(bin: IntensityDeltaMessage[] | null, eews: ReplayEewData[]): IntensityDeltaMessage[] {
  if (bin) return eews.length > 0 ? extendFramesForEews(bin, eews) : bin;
  return buildEewOnlyFramesFor(eews);
}

function emptyState(): ReplayState {
  return {
    loaded: false,
    fileName: null,
    hasBin: false,
    eews: [],
    frames: [],
    currentIndex: 0,
    clockMs: null,
    isPlaying: false,
    speed: DEFAULT_SPEED,
    values: new Map(),
    error: null,
  };
}

export function useReplayPlayer(): ReplayPlayer {
  const [state, setState] = useState<ReplayState>(emptyState);
  // 再生中にスライダーで位置を移した時に、再生タイマーを基準から作り直させるための信号。
  const [seekEpoch, setSeekEpoch] = useState(0);

  // 直前に適用した値(累積結果)をrefでも保持し、1コマ進める時に
  // 全フレーム再計算せず直前の状態から差分だけ足せるようにする。
  const valuesRef = useRef<Map<number, number>>(new Map());
  const framesRef = useRef<IntensityDeltaMessage[]>([]);
  // 適用済みの最後のフレーム番号と、再生時計(clockMs)の現在値。再生タイマーが
  // stateの更新を待たずに続きから計算できるようにrefでも持つ。
  const indexRef = useRef(0);
  const clockMsRef = useRef(0);
  // 震度ファイル(.bin)のフレームとEEWを別々に持つ。再生に使うフレームは、
  // 震度ファイルがあればそれ、無ければEEWの時間範囲から作った空のフレーム。
  const binFramesRef = useRef<IntensityDeltaMessage[] | null>(null);
  const eewsRef = useRef<ReplayEewEntry[]>([]);

  /** 再生位置を ms(UTCミリ秒)に移し、その時点の値を作り直す。 */
  const jumpTo = useCallback((frames: IntensityDeltaMessage[], ms: number) => {
    const index = frameIndexAtOrBefore(frames, ms);
    valuesRef.current = computeValuesAt(frames, index);
    indexRef.current = index;
    clockMsRef.current = ms;
    return index;
  }, []);

  const loadFile = useCallback(async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const frames = parseReplayBuffer(buf);
      binFramesRef.current = frames;
      // EEWも読み込み済みなら、震度ファイルの範囲外まで空のフレームで延ばし、
      // 最も早い地震の発生時刻から始める。
      const eews = eewsRef.current.map((e) => e.data);
      const playFrames = composeFrames(frames, eews);
      framesRef.current = playFrames;
      eewsRef.current = eewsRef.current.map((e) => ({ ...e, note: eewRangeNote(frames, e.data) }));
      const startMs = initialClockMs(playFrames, eews);
      const index = jumpTo(playFrames, startMs);
      setState((prev) => ({
        ...prev,
        loaded: true,
        fileName: file.name,
        hasBin: true,
        eews: eewsRef.current,
        frames: playFrames,
        currentIndex: index,
        clockMs: startMs,
        isPlaying: false,
        speed: DEFAULT_SPEED,
        values: new Map(valuesRef.current),
        error: null,
      }));
    } catch (e) {
      setState((prev) => ({ ...prev, error: String(e) }));
    }
  }, [jumpTo]);

  // EEWファイル(.eew.json)の読み込み(複数可)。震度ファイルが無ければ、EEWの時間範囲から
  // 値が空のフレームを作って、EEWだけで再生できるようにする。
  // 読み込むと、最も早い地震の発生時刻に再生位置を移す。
  // 同じ地震(eventId)のファイルは置き換える。震度ファイルが無い時は、全ファイルを合わせた
  // 時間範囲が上限(MAX_EEW_ONLY_SPAN_MS)以内に収まるものだけ読み込む。
  const applyEews = useCallback((entries: ReplayEewEntry[], error: string | null, keepPosition = false) => {
    const sorted = [...entries].sort((a, b) => a.data.originTimeMs - b.data.originTimeMs);
    const bin = binFramesRef.current;
    const datas = sorted.map((e) => e.data);
    const withNotes = sorted.map((e) => ({ ...e, note: bin ? eewRangeNote(bin, e.data) : null }));
    eewsRef.current = withNotes;
    if (withNotes.length === 0 && !bin) {
      framesRef.current = [];
      valuesRef.current = new Map();
      indexRef.current = 0;
      clockMsRef.current = 0;
      setState((prev) => ({ ...emptyState(), error: error ?? prev.error }));
      return;
    }
    const frames = composeFrames(bin, datas);
    framesRef.current = frames;
    // 読み込んだ時は最も早い地震の発生時刻へ。外した時は、今の位置を(新しい範囲に収めて)保つ。
    const startMs = keepPosition
      ? Math.min(Math.max(clockMsRef.current, frames[0].dataTime.getTime()), frames[frames.length - 1].dataTime.getTime())
      : initialClockMs(frames, datas);
    const index = jumpTo(frames, startMs);
    setState((prev) => ({
      ...prev,
      loaded: true,
      eews: withNotes,
      frames,
      currentIndex: index,
      clockMs: startMs,
      isPlaying: false,
      values: new Map(valuesRef.current),
      error,
    }));
  }, [jumpTo]);

  const loadEewFiles = useCallback(async (files: File[]) => {
    const errors: string[] = [];
    let entries = [...eewsRef.current];
    const bin = binFramesRef.current;
    for (const file of files) {
      try {
        const data = parseReplayEewJson(await file.text());
        const next = [...entries.filter((e) => e.id !== data.eventId), { id: data.eventId, fileName: file.name, data, note: null }];
        if (!bin) {
          const { startMs, endMs } = eewListRange(next.map((e) => e.data));
          if (endMs - startMs > MAX_EEW_ONLY_SPAN_MS) {
            errors.push(`${file.name}: 他のEEWと時間が離れすぎています(震度ファイルが無い時は、全体で${MAX_EEW_ONLY_SPAN_MS / 3600000}時間以内)`);
            continue;
          }
        }
        entries = next;
      } catch (e) {
        errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (entries.length === eewsRef.current.length && entries.every((e, i) => e === eewsRef.current[i])) {
      if (errors.length > 0) setState((prev) => ({ ...prev, error: errors.join("\n") }));
      return;
    }
    applyEews(entries, errors.length > 0 ? errors.join("\n") : null);
  }, [applyEews]);

  // EEWを外す。震度ファイルが無く、EEWが無くなれば、リプレイ自体を閉じる。
  const removeEew = useCallback((id: string) => {
    applyEews(eewsRef.current.filter((e) => e.id !== id), null, true);
  }, [applyEews]);

  const clearEew = useCallback(() => {
    applyEews([], null, true);
  }, [applyEews]);

  const seek = useCallback((index: number) => {
    const frames = framesRef.current;
    if (frames.length === 0) return;
    const clamped = Math.min(Math.max(index, 0), frames.length - 1);
    const ms = frames[clamped].dataTime.getTime();
    jumpTo(frames, ms);
    // 同じ時刻のフレームが続く場合でも、指定された番号の位置にする。
    indexRef.current = clamped;
    valuesRef.current = computeValuesAt(frames, clamped);
    setState((prev) => ({ ...prev, currentIndex: clamped, clockMs: ms, values: new Map(valuesRef.current) }));
    setSeekEpoch((n) => n + 1);
  }, [jumpTo]);

  const play = useCallback(() => setState((prev) => ({ ...prev, isPlaying: true })), []);
  const pause = useCallback(() => setState((prev) => ({ ...prev, isPlaying: false })), []);
  const setSpeed = useCallback((speed: number) => setState((prev) => ({
    ...prev,
    speed: ALLOWED_SPEEDS.includes(speed) ? speed : DEFAULT_SPEED,
  })), []);

  const close = useCallback(() => {
    framesRef.current = [];
    binFramesRef.current = null;
    eewsRef.current = [];
    valuesRef.current = new Map();
    indexRef.current = 0;
    clockMsRef.current = 0;
    setState(emptyState());
  }, []);

  // 震度ファイル(.bin)だけを閉じる。EEWが読み込まれていれば、EEWだけの再生に戻す。
  const closeBin = useCallback(() => {
    const eews = eewsRef.current.map((e) => e.data);
    if (eews.length === 0) { close(); return; }
    binFramesRef.current = null;
    eewsRef.current = eewsRef.current.map((e) => ({ ...e, note: null }));
    const frames = composeFrames(null, eews);
    framesRef.current = frames;
    const startMs = initialClockMs(frames, eews);
    const index = jumpTo(frames, startMs);
    setState((prev) => ({
      ...prev, fileName: null, hasBin: false, eews: eewsRef.current, frames,
      currentIndex: index, clockMs: startMs, isPlaying: false, values: new Map(valuesRef.current),
    }));
  }, [close, jumpTo]);

  // 再生タイマー。
  // 【時計は1つ】再生中の「今の再生時刻」は、再生を始めた(または速度を変えた)時点の
  // 再生時刻と実時間の経過×速度だけから決める(clockMs)。フレームの番号や各tickの
  // 遅れには依存しないので、tickが遅れてもズレが積み重ならない。震度の値(フレーム)も
  // EEWの表示・P波S波の円も、この同じ時計から決める。
  // 【フレームは飛ばさない】時計に届いたフレームの差分は、間引かず順に全て適用する
  // (差分は累積するため、飛ばすと値が壊れる)。
  // 【EEWの報が飛ばないように】EEWを読み込んでいる間は、フレームの間隔が長くても
  // EEW_TICK_MSごとに時計を更新する。
  useEffect(() => {
    if (!state.isPlaying) return;
    const frames = framesRef.current;
    if (frames.length === 0) {
      setState((prev) => ({ ...prev, isPlaying: false }));
      return;
    }
    const lastMs = frames[frames.length - 1].dataTime.getTime();
    const speed = state.speed;
    const baseDataMs = Math.max(clockMsRef.current, frames[0].dataTime.getTime());
    const baseWallMs = Date.now();
    if (baseDataMs >= lastMs) {
      setState((prev) => ({ ...prev, isPlaying: false }));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const nowMs = Math.min(lastMs, baseDataMs + (Date.now() - baseWallMs) * speed);
      let index = indexRef.current;
      const before = index;
      while (index < frames.length - 1 && frames[index + 1].dataTime.getTime() <= nowMs) {
        index++;
        for (const entry of frames[index].entries) {
          if (entry.intensity === null) valuesRef.current.delete(entry.id);
          else valuesRef.current.set(entry.id, entry.intensity);
        }
      }
      indexRef.current = index;
      clockMsRef.current = nowMs;
      const finished = nowMs >= lastMs;
      setState((prev) => ({
        ...prev,
        currentIndex: index,
        clockMs: nowMs,
        values: index !== before ? new Map(valuesRef.current) : prev.values,
        isPlaying: finished ? false : prev.isPlaying,
      }));
      if (finished) return;

      // 次に起きる時刻: 次のフレームに届く時刻まで(EEWがある間は最長EEW_TICK_MS)。
      const untilFrameMs = Math.min(
        Math.max(0, frames[index + 1].dataTime.getTime() - nowMs) / speed,
        MAX_REAL_INTERVAL_MS,
      );
      const waitMs = eewsRef.current.length > 0 ? Math.min(untilFrameMs, EEW_TICK_MS) : untilFrameMs;
      timer = setTimeout(tick, Math.max(MIN_TICK_WAIT_MS, waitMs));
    };
    timer = setTimeout(tick, MIN_TICK_WAIT_MS);

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [state.isPlaying, state.speed, state.frames, seekEpoch]);

  return { ...state, loadFile, loadEewFiles, removeEew, clearEew, closeBin, play, pause, seek, setSpeed, close };
}
