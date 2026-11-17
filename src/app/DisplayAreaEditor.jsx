import { useEffect, useRef, useState } from "react";
import { clampRect, insetsToRect, pinchRect, pinchSample, rectToInsets, ZERO_INSETS } from "../displayArea";

/* ─────────────────────────────────────────────────────
   表示領域の調整画面。画面全体に重ねて、枠(=アプリを表示する領域)を操作する。
   ・2本指のピンチ: 横の指の間隔で幅、縦の指の間隔で高さが変わり、2本の指の中心の移動で位置が動く。
   ・枠の辺をドラッグ: その辺だけを動かす(1本指でも調整できる)。
   ・「全画面に戻す」で余白0(初期設定)に戻す。「完了」で反映する。
   ───────────────────────────────────────────────────── */
const EDGES = ["top", "right", "bottom", "left"];
const HANDLE = 28; // 辺をつかむ領域の太さ(px)

export default function DisplayAreaEditor({ insets, onDone, onCancel }) {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [rect, setRect] = useState(() => clampRect(insetsToRect(insets, window.innerWidth, window.innerHeight), window.innerWidth, window.innerHeight));
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const pointers = useRef(new Map()); // pointerId -> {x,y}
  const gesture = useRef(null); // { kind:"pinch", rect0, p0 } | { kind:"edge", edge, rect0, x0, y0 }

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startPinchIfTwo = () => {
    if (pointers.current.size !== 2) return false;
    const [a, b] = [...pointers.current.values()];
    gesture.current = { kind: "pinch", rect0: rectRef.current, p0: pinchSample(a.x, a.y, b.x, b.y) };
    return true;
  };

  const onPointerDown = (e, edge) => {
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* 合成イベント等では取得できない場合がある */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (startPinchIfTwo()) return;
    if (edge) gesture.current = { kind: "edge", edge, rect0: rectRef.current, x0: e.clientX, y0: e.clientY };
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      setRect(pinchRect(g.rect0, g.p0, pinchSample(a.x, a.y, b.x, b.y), vp.w, vp.h));
    } else if (g.kind === "edge" && pointers.current.size === 1) {
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      const r = { ...g.rect0 };
      if (g.edge === "top") r.t += dy;
      if (g.edge === "bottom") r.b += dy;
      if (g.edge === "left") r.l += dx;
      if (g.edge === "right") r.r += dx;
      setRect(clampEdge(r, g.edge, vp.w, vp.h));
    }
  };

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
    // 指が1本残った場合は、その指でのピンチ/辺ドラッグは続けず、いったん確定する。
  };

  const insetsNow = rectToInsets(rect, vp.w, vp.h);
  const edgeStyle = {
    top: { left: 0, right: 0, top: -HANDLE / 2, height: HANDLE, cursor: "ns-resize" },
    bottom: { left: 0, right: 0, bottom: -HANDLE / 2, height: HANDLE, cursor: "ns-resize" },
    left: { top: 0, bottom: 0, left: -HANDLE / 2, width: HANDLE, cursor: "ew-resize" },
    right: { top: 0, bottom: 0, right: -HANDLE / 2, width: HANDLE, cursor: "ew-resize" },
  };
  const btn = { font: "inherit", fontSize: 15, fontWeight: 600, padding: "10px 18px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.35)", background: "rgba(255,255,255,0.14)", color: "#fff", cursor: "pointer" };

  return (
    <div
      onPointerDown={(e) => onPointerDown(e, null)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ position: "fixed", inset: 0, zIndex: 100000, touchAction: "none", userSelect: "none", WebkitUserSelect: "none", background: "transparent" }}
    >
      {/* 枠の外側を暗くする */}
      <div style={{ position: "absolute", left: rect.l, top: rect.t, width: rect.r - rect.l, height: rect.b - rect.t, boxShadow: "0 0 0 100vmax rgba(0,0,0,0.6)", border: "2px dashed rgba(255,255,255,0.9)", borderRadius: 6, boxSizing: "border-box", pointerEvents: "none" }}/>
      {EDGES.map(edge => (
        <div
          key={edge}
          onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, edge); }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ position: "absolute", left: rect.l, top: rect.t, width: rect.r - rect.l, height: rect.b - rect.t, pointerEvents: "none" }}
        >
          <div style={{ position: "absolute", pointerEvents: "auto", touchAction: "none", display: "flex", alignItems: "center", justifyContent: "center", ...edgeStyle[edge] }}>
            <div style={{ background: "rgba(255,255,255,0.95)", borderRadius: 3, ...(edge === "top" || edge === "bottom" ? { width: 44, height: 5 } : { width: 5, height: 44 }) }}/>
          </div>
        </div>
      ))}
      {/* 説明とボタン。枠の大きさに関係なく、画面の下に固定して出す。 */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={{ position: "absolute", left: 12, right: 12, bottom: "calc(12px + env(safe-area-inset-bottom, 0px))", margin: "0 auto", maxWidth: 420, padding: "14px 16px", borderRadius: 18, background: "rgba(20,22,28,0.92)", color: "#fff", textAlign: "center", display: "flex", flexDirection: "column", gap: 10, boxSizing: "border-box" }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.5 }}>2本指でピンチして、表示する領域の大きさと位置を調整します</div>
        <div style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.8 }}>縦に広げると高さ、横に広げると幅が変わります。枠の辺をドラッグしても調整できます。</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>余白 上{insetsNow.top} 下{insetsNow.bottom} 左{insetsNow.left} 右{insetsNow.right}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          <button style={btn} onClick={() => setRect(insetsToRect(ZERO_INSETS, vp.w, vp.h))}>全画面に戻す</button>
          <button style={btn} onClick={onCancel}>キャンセル</button>
          <button style={{ ...btn, background: "#0A84FF", borderColor: "#0A84FF" }} onClick={() => onDone(rectToInsets(rect, vp.w, vp.h))}>完了</button>
        </div>
      </div>
    </div>
  );
}

// 辺のドラッグ: 動かしている辺が反対側の辺に近づきすぎないようにする(最小サイズ160px)。
function clampEdge(r, edge, vw, vh) {
  const MIN = Math.min(160, vw, vh);
  const out = { ...r };
  if (edge === "top") out.t = Math.min(Math.max(r.t, 0), r.b - MIN);
  if (edge === "bottom") out.b = Math.max(Math.min(r.b, vh), r.t + MIN);
  if (edge === "left") out.l = Math.min(Math.max(r.l, 0), r.r - MIN);
  if (edge === "right") out.r = Math.max(Math.min(r.r, vw), r.l + MIN);
  return out;
}
