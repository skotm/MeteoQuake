/* ─────────────────────────────────────────────────────
   震度バッジ用「数字 + 弱/強」ラベル(地震詳細カード・緊急地震速報カード共通)

   以前は弱/強を alignSelf:"flex-end" と固定のmarginBottomで押し上げていたため、
   文字の「箱の底」しか揃わず、数字の下端(ベースライン)とずれていた。
   ここでは次の2段で、弱/強の文字の下端を数字の下端に合わせる。
     1. align-items: baseline … 数字と弱/強のベースラインを揃える(フォントサイズが違っても揃う)。
     2. 漢字は字面が欧文のベースラインより少し下にはみ出す(おおむね字の高さの9%前後)ため、
        その分だけ弱/強を上へ持ち上げる(INTENSITY_SUFFIX_NUDGE_EM)。
        使うフォントによって見え方が変わるので、実機で下端がずれて見えたらこの値で微調整する
        (負の値ほど上へ動く)。
   ───────────────────────────────────────────────────── */
export const INTENSITY_SUFFIX_NUDGE_EM = -0.09;

export function IntensityNumWithSuffix({ num, suffix, numSize, suffixSize }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", lineHeight: 1 }}>
      <span className="mono" style={{ fontSize: numSize, fontWeight: 800, lineHeight: 1 }}>{num}</span>
      <span style={{
        fontSize: suffixSize, fontWeight: 700, lineHeight: 1,
        marginLeft: 2,
        position: "relative", top: `${INTENSITY_SUFFIX_NUDGE_EM}em`,
      }}>{suffix}</span>
    </span>
  );
}
