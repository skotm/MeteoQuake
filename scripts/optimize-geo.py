#!/usr/bin/env python3
"""public/map の地図データを軽量化する(座標の小数桁を丸め、連続する重複点を除く)。

元データは小数14〜15桁(ミリメートル以下)で、画面表示には不要なため、4桁(約11m)に丸める。
隣り合う区域の共有頂点は同じ値に丸まるので、境界のずれ(隙間)は生じない。
再実行しても結果は変わらない(冪等)。元データから作り直す場合は、元ファイルを置き直してから実行する。

使い方: python3 scripts/optimize-geo.py
"""
import json, os, sys

MAP_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "map")
# ファイル名: (小数桁, 削除するproperties)
TARGETS = {
    "細分区域.json": (4, []),
    "warning_areas.json": (4, []),
    "prefectures.json": (4, []),
    "world.json": (4, []),
    "tsunami-areas.json": (4, []),
    "faults.geojson": (4, []),
    "plate-boundaries.json": (4, []),
}

def dedupe(ring, closed):
    out = []
    for p in ring:
        if not out or out[-1] != p:
            out.append(p)
    return out

def process_coords(c, n, depth_kind):
    """depth_kind: 'point' | 'line' | 'ring' の配列を再帰的に処理する"""
    if depth_kind == 0:  # 座標
        return [round(c[0], n), round(c[1], n)] + [round(v, n) for v in c[2:]]
    return [process_coords(x, n, depth_kind - 1) for x in c]

GEOM_DEPTH = {"Point": 0, "MultiPoint": 1, "LineString": 1, "MultiLineString": 2, "Polygon": 2, "MultiPolygon": 3}

def process_geometry(g, n):
    if g is None: return g
    t = g["type"]
    if t == "GeometryCollection":
        g["geometries"] = [process_geometry(x, n) for x in g["geometries"]]
        return g
    d = GEOM_DEPTH[t]
    coords = process_coords(g["coordinates"], n, d)
    # 連続する重複点を除く(丸めた結果、同じ点になったもの)
    if t in ("LineString",):
        coords = dedupe(coords, False)
        if len(coords) < 2: return None
    elif t == "MultiLineString":
        coords = [l for l in (dedupe(l, False) for l in coords) if len(l) >= 2]
        if not coords: return None
    elif t == "Polygon":
        coords = [r for r in (dedupe(r, True) for r in coords) if len(r) >= 4]
        if not coords: return None
    elif t == "MultiPolygon":
        polys = []
        for poly in coords:
            rings = [r for r in (dedupe(r, True) for r in poly) if len(r) >= 4]
            if rings and len(rings[0]) >= 4: polys.append(rings)
        if not polys: return None
        coords = polys
    g["coordinates"] = coords
    return g

def process(d, n, drop):
    t = d.get("type")
    if t == "FeatureCollection":
        feats = []
        for f in d["features"]:
            f["geometry"] = process_geometry(f.get("geometry"), n)
            if f["geometry"] is None: continue
            for k in drop: (f.get("properties") or {}).pop(k, None)
            feats.append(f)
        d["features"] = feats
    elif t == "GeometryCollection" or t in GEOM_DEPTH:
        d = process_geometry(d, n)
    return d

for name, (n, drop) in TARGETS.items():
    path = os.path.join(MAP_DIR, name)
    if not os.path.exists(path): continue
    before = os.path.getsize(path)
    d = json.load(open(path, encoding="utf8"))
    d = process(d, n, drop)
    s = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    open(path, "w", encoding="utf8").write(s)
    print(f"{name}: {before/1e6:.2f}MB -> {len(s.encode())/1e6:.2f}MB")
