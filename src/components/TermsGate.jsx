import { useContext, useEffect, useState } from "react";
import { PressableButton } from "../ui/glass.jsx";
import { ThemeContext, loadStoredTermsAgreement, saveStoredTermsAgreement, simpleHash } from "../settings/prefs.js";
import { renderMarkdownLite } from "./Settings.jsx";

/* ─────────────────────────────────────────────────────
   TERMS CONSENT GATE
   利用規約・プライバシーポリシー・注意事項への同意を、既存のフローティングUI
   (BottomDock等)とは別の全画面オーバーレイで確認する。未同意の間はこれが
   画面全体を覆い、他の操作を一切受け付けない。

   「同意済みか」はTERMS_AGREEMENT_STORAGE_KEY(localStorage)に保存した
   各文書のハッシュで判定するため、開発者はMarkdownファイルの中身を
   書き換えるだけでよく、バージョン番号の手動管理は不要。

   フェイルオープンの方針: 本アプリは災害時にも使われることを想定しているため、
   「過去に同意した記録があるユーザー」を単なる通信不調で締め出すことは避ける。
   文書の取得に失敗した場合:
     - 過去に同意した記録がある → ブロックせずそのまま利用させる
     - 一度も同意したことがない(真の初回) → 同意対象を表示できないため、
       再読み込みを促す画面のみ出す(この場合だけブロックが続く)

   ファイル名は意図的に日本語ではなくASCIIにしている。日本語ファイル名
   (特に濁点・半濁点付きのカタカナ)はmacOS等でNFD(濁点が分解された形)で
   保存されることがあり、ブラウザが要求するNFC表記のURLとバイト単位で
   一致せず404になることがあるため。
   ───────────────────────────────────────────────────── */
const TERMS_GATE_FILES = {
  tou: "terms-of-use.md",
  privacy: "privacy-policy.md",
  notices: "notices.md",
};

const TERMS_GATE_TABS = [
  { id: "tou",     label: "利用規約" },
  { id: "privacy", label: "プライバシーポリシー" },
  { id: "notices", label: "注意事項" },
];


export function TermsConsentGate() {
  const { tokens } = useContext(ThemeContext);
  const [status, setStatus] = useState("checking"); // checking | ok | needsConsent | unavailable
  const [docs, setDocs] = useState(null); // { tou, privacy, notices }
  const [pendingHashes, setPendingHashes] = useState(null);
  const [activeTab, setActiveTab] = useState("tou");
  const [agreeChecked, setAgreeChecked] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("checking");

    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
      ]);
    }

    const stored = loadStoredTermsAgreement();

    Promise.allSettled(
      Object.entries(TERMS_GATE_FILES).map(([key, fileName]) =>
        withTimeout(
          fetch(`${import.meta.env.BASE_URL}${fileName}`).then(res => {
            if (!res.ok) throw new Error(`status ${res.status}`);
            return res.text();
          }),
          8000
        ).then(text => ({ key, text }))
      )
    ).then(results => {
      if (cancelled) return;

      const texts = {};
      let allOk = true;
      results.forEach(r => {
        if (r.status === "fulfilled") texts[r.value.key] = r.value.text;
        else allOk = false;
      });

      if (!allOk) {
        setStatus(stored ? "ok" : "unavailable");
        return;
      }

      const hashes = {
        tou: simpleHash(texts.tou),
        privacy: simpleHash(texts.privacy),
        notices: simpleHash(texts.notices),
      };
      const upToDate = !!stored
        && stored.tou === hashes.tou
        && stored.privacy === hashes.privacy
        && stored.notices === hashes.notices;

      if (upToDate) {
        setStatus("ok");
      } else {
        setDocs(texts);
        setPendingHashes(hashes);
        setAgreeChecked(false);
        setActiveTab("tou");
        setStatus("needsConsent");
      }
    });

    return () => { cancelled = true; };
  }, [retryToken]);

  if (status === "ok") return null;

  // 「取得中」は通常一瞬で終わるが、その間に下のUIが一瞬でも見えてしまうのを
  // 避けるため、判定が終わるまでは最小限の全画面プレースホルダーだけを出す。
  if (status === "checking") {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: tokens.pageBg,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%",
          border: `2.5px solid rgba(${tokens.ink},0.2)`,
          borderTopColor: `rgba(${tokens.ink},0.7)`,
          animation: "spin 0.8s linear infinite",
        }}/>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: tokens.pageBg,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}>
        <div style={{ maxWidth: 360, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: tokens.text, marginBottom: 10 }}>
            利用規約等を読み込めませんでした
          </div>
          <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1.8, marginBottom: 20 }}>
            ご利用の開始には、利用規約・プライバシーポリシー・注意事項への同意が必要です。通信環境をご確認のうえ、もう一度お試しください。
          </div>
          <PressableButton
            onClick={() => setRetryToken(n => n + 1)}
            style={{
              padding: "10px 24px", borderRadius: 999,
              border: "1px solid rgba(10,132,255,0.9)",
              background: "#0A84FF", color: "#ffffff",
              fontSize: 14, fontWeight: 700,
            }}
          >
            再読み込み
          </PressableButton>
        </div>
      </div>
    );
  }

  // status === "needsConsent"
  const activeText = docs?.[activeTab] || "";
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: tokens.pageBg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ padding: "calc(20px + env(safe-area-inset-top, 0px)) 20px 12px", textAlign: "center", flexShrink: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: tokens.text, marginBottom: 4 }}>
          利用規約等のご確認
        </div>
        <div style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.7 }}>
          ご利用の前に、以下の内容をご確認のうえ同意してください。
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "0 16px 10px", justifyContent: "center", flexShrink: 0 }}>
        {TERMS_GATE_TABS.map(tab => (
          <PressableButton
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "7px 12px", borderRadius: 999,
              background: activeTab === tab.id ? "#0A84FF" : `rgba(${tokens.ink},0.06)`,
              color: activeTab === tab.id ? "#ffffff" : tokens.text,
              fontSize: 12.5, fontWeight: 700,
            }}
          >
            {tab.label}
          </PressableButton>
        ))}
      </div>

      <div key={activeTab} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 16px 16px" }}>
        <div style={{
          borderRadius: 16,
          background: `rgba(${tokens.ink},0.04)`,
          padding: "16px 16px",
        }}>
          {renderMarkdownLite(activeText, tokens)}
        </div>
      </div>

      <div style={{
        padding: "12px 16px calc(16px + env(safe-area-inset-bottom, 0px))",
        borderTop: `1px solid rgba(${tokens.ink},0.08)`,
        flexShrink: 0,
      }}>
        <PressableButton
          onClick={() => setAgreeChecked(v => !v)}
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 10,
            padding: "10px 4px", background: "transparent", textAlign: "left",
          }}
        >
          <span style={{
            flexShrink: 0, width: 20, height: 20, borderRadius: 6,
            border: `1.5px solid rgba(${tokens.ink},${agreeChecked ? 0 : 0.3})`,
            background: agreeChecked ? "#0A84FF" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {agreeChecked && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M4 12.5L9.5 18L20 6" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </span>
          <span style={{ fontSize: 13, color: tokens.text }}>
            利用規約・プライバシーポリシー・注意事項の内容を確認し、同意します
          </span>
        </PressableButton>

        <PressableButton
          disabled={!agreeChecked}
          onClick={() => {
            if (!pendingHashes) return;
            saveStoredTermsAgreement({ ...pendingHashes, agreedAt: new Date().toISOString() });
            setStatus("ok");
          }}
          style={{
            width: "100%", marginTop: 10, padding: "13px 0", borderRadius: 999,
            background: agreeChecked ? "#0A84FF" : `rgba(${tokens.ink},0.12)`,
            color: agreeChecked ? "#ffffff" : `rgba(${tokens.ink},0.4)`,
            fontSize: 15, fontWeight: 800, textAlign: "center",
          }}
        >
          同意して利用を開始する
        </PressableButton>
      </div>
    </div>
  );
}
