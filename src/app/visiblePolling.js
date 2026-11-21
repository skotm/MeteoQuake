// タブが非表示の間は定期取得を止め、表示に戻った時に(前回から間隔以上経っていれば)
// すぐ1回取り直す。戻り値は停止用のクリーンアップ関数。
export function startVisiblePolling(fn, intervalMs) {
  let last = Date.now();
  const run = () => { last = Date.now(); fn(); };
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
  const id = setInterval(() => { if (!hidden()) run(); }, intervalMs);
  const onVis = () => { if (!hidden() && Date.now() - last >= intervalMs) run(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
  return () => {
    clearInterval(id);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
  };
}
