import { useSyncExternalStore } from "react";

/* ─────────────────────────────────────────────────────
   表示領域を狭めている間の「見かけ上の画面の大きさ」。
   アプリ全体をCSSのscaleで縮小して表示するため、window.innerWidth/Heightは実際の画面の
   大きさのままで、UIのレイアウト判定(横画面か・画面の高さに対する縮小率など)には
   使えない。それらは、ここで持つlogical(=領域の大きさ ÷ 縮小率)を使う。
   全画面の間(scale=1)は、実際のwindowの大きさと同じになる。
   ───────────────────────────────────────────────────── */
let state = null; // { width, height, scale } | null(null=window基準)
const listeners = new Set();

export function setLogicalViewport(next) {
  const same = state && next && state.width === next.width && state.height === next.height && state.scale === next.scale;
  if (same || (state === null && next === null)) return;
  state = next;
  listeners.forEach(l => l());
}

export function getLogicalViewportSize() {
  if (state) return { width: state.width, height: state.height };
  return { width: window.innerWidth, height: window.innerHeight };
}

export function subscribeLogicalViewport(listener) {
  listeners.add(listener);
  window.addEventListener("resize", listener);
  return () => { listeners.delete(listener); window.removeEventListener("resize", listener); };
}

let cache = null;
function getSnapshot() {
  const { width, height } = getLogicalViewportSize();
  if (!cache || cache.width !== width || cache.height !== height) cache = { width, height };
  return cache;
}

export function useLogicalViewport() {
  return useSyncExternalStore(subscribeLogicalViewport, getSnapshot, getSnapshot);
}
