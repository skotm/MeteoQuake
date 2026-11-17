import { useSyncExternalStore } from "react";

/* ─────────────────────────────────────────────────────
   表示領域を狭めている間の「画面の大きさ」。アプリはこの領域を画面として扱うため、
   window.innerWidth/Heightのままでは、画面サイズに応じた配置計算(横画面レイアウトか・
   画面の高さに応じた縮小・全画面スナップの高さ)が領域の大きさと合わなくなる。
   それらは、ここで持つ領域の大きさを使う。全画面の間(null)は、実際のwindowの大きさ。
   ───────────────────────────────────────────────────── */
let state = null; // { width, height } | null(null=window基準)
const listeners = new Set();

export function setLogicalViewport(next) {
  const same = state && next && state.width === next.width && state.height === next.height;
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
