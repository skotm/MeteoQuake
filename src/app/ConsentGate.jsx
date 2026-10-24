import { useContext, useState } from "react";
import { ThemeContext } from "./theme";
import { CONSENT_DOCS } from "./consent";
import { PressableButton } from "./glass";
import { MarkdownFileCard } from "./settingsPanels";


/* ─────────────────────────────────────────────────────
   CONSENT GATE
   利用規約・注意事項・プライバシーポリシーへの同意画面。全画面(position:fixed
   + 最前面のzIndex)でアプリ本体の上に覆いかぶさり、同意するまで裏側の操作を
   一切できなくする。表示中はスクロールもこの中に閉じるため、裏の地図等が
   誤って動くこともない。
   - storedConsentがnull(=同意記録が全く無い)の場合は初回起動時の案内文言、
     何らかの同意記録はあるがバージョンが古い場合は「更新されました」の案内
     文言に出し分ける。後者では、どの文書が変わったかをタブに小さい赤丸で示す。
   - 文書の表示自体は設定画面と同じMarkdownFileCardを流用し、見た目・実装を
     二重管理しない。
   ───────────────────────────────────────────────────── */
export function ConsentGate({ storedConsent, onAgree }) {
  const { tokens } = useContext(ThemeContext);
  const [activeDocId, setActiveDocId] = useState(CONSENT_DOCS[0].id);

  const isUpdate = !!storedConsent; // 既に同意記録があるうえでの再同意(=文書更新)かどうか
  const changedDocIds = isUpdate
    ? CONSENT_DOCS.filter(doc => storedConsent[doc.versionKey] !== doc.version).map(doc => doc.id)
    : CONSENT_DOCS.map(doc => doc.id);
  const activeDoc = CONSENT_DOCS.find(doc => doc.id === activeDocId);

  function handleAgree() {
    const nextConsent = { agreedAt: new Date().toISOString() };
    CONSENT_DOCS.forEach(doc => { nextConsent[doc.versionKey] = doc.version; });
    onAgree(nextConsent);
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100000,
      background: tokens.pageBg,
      display: "flex", flexDirection: "column",
      paddingTop: "env(safe-area-inset-top)",
    }}>
      <div style={{ padding: "20px 20px 4px", flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: tokens.text }}>
          {isUpdate ? "利用規約等が更新されました" : "はじめに"}
        </div>
        <div style={{ fontSize: 12.5, color: tokens.textSecondary, marginTop: 6, lineHeight: 1.7 }}>
          {isUpdate
            ? `${CONSENT_DOCS.filter(d => changedDocIds.includes(d.id)).map(d => d.label).join("・")}の内容が更新されました。内容をご確認のうえ、同意して利用を続けてください。`
            : "本アプリのご利用にあたり、以下の内容をご確認のうえ同意してください。"}
        </div>
      </div>

      {/* タブ切り替え。更新時は、変更のあった文書に小さい赤丸を付ける。 */}
      <div style={{ display: "flex", gap: 6, padding: "10px 16px 0", flexShrink: 0 }}>
        {CONSENT_DOCS.map(doc => {
          const active = activeDocId === doc.id;
          const changed = isUpdate && changedDocIds.includes(doc.id);
          return (
            <PressableButton
              key={doc.id}
              type="button"
              onClick={() => setActiveDocId(doc.id)}
              style={{
                flex: 1, padding: "8px 6px", borderRadius: 10, border: "none", cursor: "pointer",
                background: active ? `rgba(${tokens.ink},0.1)` : "transparent",
                fontSize: 12, fontWeight: 700,
                color: active ? tokens.text : tokens.textSecondary,
                position: "relative",
              }}
            >
              {doc.label}
              {changed && (
                <span aria-hidden style={{
                  position: "absolute", top: 4, right: 8,
                  width: 6, height: 6, borderRadius: 999, background: "#FF453A",
                }}/>
              )}
            </PressableButton>
          );
        })}
      </div>

      {/* 本文。設定画面の文書表示と同じMarkdownFileCardを流用する。 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 2px 16px", WebkitOverflowScrolling: "touch" }}>
        <MarkdownFileCard fileName={activeDoc.fileName}/>
      </div>

      {/* 同意ボタン。これを押すまで裏側の機能は一切使えない。 */}
      <div style={{
        flexShrink: 0, padding: "12px 16px calc(14px + env(safe-area-inset-bottom))",
        borderTop: `1px solid ${tokens.divider}`,
      }}>
        <PressableButton
          type="button"
          onClick={handleAgree}
          style={{
            width: "100%", padding: "14px 16px", borderRadius: 14, border: "none", cursor: "pointer",
            background: "#0A84FF", color: "#fff", fontSize: 15, fontWeight: 700,
          }}
        >
          同意して利用を開始する
        </PressableButton>
      </div>
    </div>
  );
}
