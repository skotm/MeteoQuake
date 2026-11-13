import { scaleKeyLabel } from "./simEewRules";

/* ─────────────────────────────────────────────────────
   連動シミュレーションのログ(セッション中のみ保持。アプリの履歴・通知・保存には流さない)。
   更新の理由や、更新前後の値は、EEWカード(フローティング)には出さず、ここにまとめる。
   ───────────────────────────────────────────────────── */
export const SIM_LOG_MAX = 500;

// kind: "開始" | "発表" | "更新" | "最終報" | "取消" | "中止" | "停止" | "終了"
// method: "通常"(震源とMによる報) | "レベル法" | ""(報ではないログ)
export function makeSimLogEntry({ at, kind, method = "", serial = null, state = null, reasons = [], changes = [], note = "", warn = null }) {
  return {
    at, kind, method, serial,
    pub: state ? { ...state.pub } : null,
    raw: state ? { ...state.raw } : null,
    maxKey: state ? state.maxKey : null,
    warn: warn ?? (state ? state.warn === true : null),
    reasons: [...reasons],
    changes: [...changes],
    note,
  };
}

function pad2(n) { return String(n).padStart(2, "0"); }
function clock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 1件のログを、読みやすい複数行の文にする。
export function formatSimLogEntry(e) {
  const head = [`[${clock(e.at)}]`];
  if (e.serial != null) head.push(`#${e.serial}`);
  head.push(e.method ? `${e.kind}(${e.method})` : e.kind);
  if (e.pub) head.push(`M${e.pub.magnitude.toFixed(1)} 深さ${e.pub.depthKm}km`);
  if (e.maxKey && e.maxKey !== "?") head.push(`最大予測震度${scaleKeyLabel(e.maxKey)}`);
  if (e.warn === true) head.push("警報");
  const lines = [head.join(" ")];
  if (e.reasons.length) lines.push(`    理由: ${e.reasons.join("・")}`);
  for (const c of e.changes) lines.push(`    ${c}`);
  if (e.note) lines.push(`    ${e.note}`);
  return lines.join("\n");
}

export function formatSimLog(entries) {
  return (entries || []).map(formatSimLogEntry).join("\n");
}
