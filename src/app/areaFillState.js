/**
 * areaFillState.js
 * ------------------------------------------------------------
 * 地図の「細分区域」の塗り分け(MapLibreのfeature-state: areasソースのcolor/hasIntensity)を、
 * 複数の所有者(地震情報の震度分布・緊急地震速報の予想震度)が、互いに壊し合わずに使うための調停役。
 *
 * 【背景】2つの塗り分けは、同じ"areas"ソースの、同じ区域のfeature-stateを共有する。以前は、それぞれが
 * 「自分が前回塗った区域を消して、今回塗る」をバラバラに行っていたため、実行順序によっては、片方が消す時に、
 * もう片方が塗った(重なった)区域の色まで消えてしまった。特に、地震情報の側はeffectの中で同期的に、
 * EEWの側はデータ読み込み後に非同期で動くため、「地震を選択した瞬間に、EEW側が自分の区域を消す」順になり、
 * 選んだ地震の塗り分けが、EEWと重なる区域で消えていた。
 *
 * 【方針】所有者ごとの「区域コード→色」を保持し、どちらかが更新されるたびに、2つを合成した結果
 * (重なる区域はEEWが優先。従来の、EEWが後から塗って勝つ挙動と同じ)を、まとめて反映する。
 * 無くなった区域だけを消すので、一方の更新が、もう一方の色を消すことは無い。同じ内容で呼ばれても全区域を
 * 塗り直す(地図のデータが差し替わってfeature-stateが失われた場合も、effectの再実行で自己修復するため)。
 */
export class AreaFillCoordinator {
  /** @param {(code: string, color: string | null) => void} applyColor colorがnullなら、その区域の塗りを消す */
  constructor(applyColor) {
    this.applyColor = applyColor;
    this.quake = new Map();
    this.eew = new Map();
    this.applied = new Map();
  }

  /** 地震情報(震度分布)の塗り分けを設定する。Map<区域コード, 色>。空なら、地震情報の塗りを無くす。 */
  setQuakeFill(codeToColor) {
    this.quake = new Map(codeToColor);
    this.flush();
  }

  /** 緊急地震速報(予想震度)の塗り分けを設定する。Map<区域コード, 色>。空なら、EEWの塗りを無くす。 */
  setEewFill(codeToColor) {
    this.eew = new Map(codeToColor);
    this.flush();
  }

  flush() {
    const next = new Map(this.quake);
    for (const [code, color] of this.eew) next.set(code, color); // 重なる区域はEEWが優先
    for (const code of this.applied.keys()) {
      if (!next.has(code)) this.applyColor(code, null);
    }
    for (const [code, color] of next) this.applyColor(code, color);
    this.applied = next;
  }
}
