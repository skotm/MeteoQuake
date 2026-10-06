import { useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────
   APP VERSION
   バージョン表記のルール(vMAJOR.MINOR.PATCH):
   - PATCH(3つ目の数字)を更新のたびに1ずつ増やす
   - PATCHが10になったらMINOR(2つ目)を1増やし、PATCHは0に戻す
   - MINORが10になったらMAJOR(1つ目)を1増やし、MINORは0に戻す
   - MAJORには繰り上げ先が無いので、10になってもそのまま11、12…と増え続ける
   (要するに10進の桁上がりと同じルールで、MAJORだけ上限が無い)
   ───────────────────────────────────────────────────── */
export const APP_VERSION = "2.3.0";


/* ─────────────────────────────────────────────────────
   IN-APP DEBUG LOG
   実機のPWAではPCの開発者ツールに繋がずconsoleログを見る手段が無いため、
   console.log/info/warn/errorを横取りして直近分をメモリ上のリングバッファに
   保持し、設定タブ「詳細設定」→「ログ」から一覧表示・コピーできるようにする。
   - バッファ自体はReact stateではなくモジュールスコープの配列で持つ
     (発生頻度が高いログでrender/commitを都度挟むと重くなるため)。
   - 表示側は購読(subscribe)コールバックのSetを介して更新を検知する、
     ミニ版useSyncExternalStoreのような仕組み。
   - console.*の差し替えはモジュール読み込み時に1度だけ行う。元の関数呼び出し
     (PCでdevtoolsを開いている場合はそちらにも従来通り出る)は維持したまま、
     バッファへの追記を追加するだけ。
   ───────────────────────────────────────────────────── */
export const DEBUG_LOG_MAX = 500;
 // 古いものから捨てる上限件数(メモリ節約のため)

let debugLogBuffer = [];

let debugLogSeq = 0;

const debugLogSubscribers = new Set();


function notifyDebugLogSubscribers() {
  for (const cb of debugLogSubscribers) cb();
}


// console.logなどに渡された1個の引数を、表示用の1行の文字列に変換する。
// 文字列はそのまま、Errorはname+message、それ以外(オブジェクト・配列等)は
// JSON化を試み、失敗すれば(循環参照など)String()にフォールバックする。
function formatDebugLogArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg, (key, value) => (typeof value === "bigint" ? value.toString() : value));
  } catch {
    return String(arg);
  }
}


function pushDebugLog(level, args) {
  debugLogSeq += 1;
  const entry = {
    id: debugLogSeq,
    level, // "log" | "info" | "warn" | "error"
    time: new Date(),
    text: args.map(formatDebugLogArg).join(" "),
  };
  debugLogBuffer.push(entry);
  if (debugLogBuffer.length > DEBUG_LOG_MAX) {
    debugLogBuffer.splice(0, debugLogBuffer.length - DEBUG_LOG_MAX);
  }
  notifyDebugLogSubscribers();
}


export function clearDebugLog() {
  debugLogBuffer = [];
  notifyDebugLogSubscribers();
}


// console.log/info/warn/errorを横取りする。多重パッチ防止のためwindowにフラグを立てる
// (開発時のホットリロード等で複数回このモジュールが評価されても1回だけ差し替える)。
(function patchConsoleForDebugLog() {
  if (typeof window === "undefined" || window.__debugLogPatched) return;
  window.__debugLogPatched = true;
  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method] ? console[method].bind(console) : () => {};
    console[method] = (...args) => {
      original(...args);
      try { pushDebugLog(method, args); } catch { /* ログ機構自体の失敗は握りつぶす */ }
    };
  }
  // 通常のtry/catchを素通りしてしまうエラー(非同期処理内の未捕捉例外など)も
  // 追っておくと、実機での不具合調査に役立つ。
  window.addEventListener("error", (e) => {
    try { pushDebugLog("error", [`window.onerror: ${e.message}`, `${e.filename}:${e.lineno}`]); } catch {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    try { pushDebugLog("error", ["unhandledrejection:", e.reason]); } catch {}
  });
})();


// バッファの現在の中身をコンポーネントから購読するためのフック。
// バッファ自体は毎回同じ配列参照を返す(pushDebugLog側でmutateしている)ため、
// 呼び出し側では返り値をそのまま使わず、参照だけをトリガーにして再描画のたびに
// 最新のdebugLogBufferを読みに行く形にしている。
export function useDebugLog() {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const cb = () => forceUpdate(n => n + 1);
    debugLogSubscribers.add(cb);
    return () => { debugLogSubscribers.delete(cb); };
  }, []);
  return debugLogBuffer;
}
