


/* ─────────────────────────────────────────────────────
   APP VERSION
   バージョン表記のルール(vMAJOR.MINOR.PATCH):
   - PATCH(3つ目の数字)を更新のたびに1ずつ増やす
   - PATCHが10になったらMINOR(2つ目)を1増やし、PATCHは0に戻す
   - MINORが10になったらMAJOR(1つ目)を1増やし、MINORは0に戻す
   - MAJORには繰り上げ先が無いので、10になってもそのまま11、12…と増え続ける
   (要するに10進の桁上がりと同じルールで、MAJORだけ上限が無い)
   ───────────────────────────────────────────────────── */
export const APP_VERSION = "2.3.0";

/* ─────────────────────────────────────────────────────
   TERMS / PRIVACY / NOTICES CONSENT
   利用規約・注意事項・プライバシーポリシーへの同意管理。
   - 初回起動時、および3文書のいずれかのバージョンが同意時点と異なる場合に、
     ConsentGateで全画面ブロックし、同意するまで他の機能を使えないようにする。
   - バージョンは文書内容のハッシュ等ではなく、ここに置く日付文字列で管理する
     (このアプリはビルド時処理を持たない静的サイトのため)。誤字修正など
     実質的な内容変更を伴わない更新では、ここの値は上げない運用を想定している。
   - 文書側(terms-of-use.md等)の「最終更新日」表記とも値を合わせておくこと。
   ───────────────────────────────────────────────────── */
const TERMS_VERSION = "2026-08-30";
const NOTICES_VERSION = "2026-08-30";
const PRIVACY_VERSION = "2026-08-30";

const CONSENT_STORAGE_KEY = "termsConsent";

// 同意対象の3文書。ConsentGateのタブ順・設定画面の一覧順と揃えている。
export const CONSENT_DOCS = [
  { id: "tou",     label: "利用規約",           fileName: "terms-of-use.md",   version: TERMS_VERSION,   versionKey: "termsVersion" },
  { id: "notices", label: "注意事項",           fileName: "notices.md",        version: NOTICES_VERSION, versionKey: "noticesVersion" },
  { id: "privacy", label: "プライバシーポリシー", fileName: "privacy-policy.md", version: PRIVACY_VERSION, versionKey: "privacyVersion" },
];

export function loadStoredConsent() {
  try {
    const saved = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (err) {
    console.warn("同意状態を読み込めませんでした:", err);
  }
  return null;
}

export function saveConsent(consent) {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent));
  } catch (err) {
    console.warn("同意状態を保存できませんでした:", err);
  }
}

// 保存済みの同意が、現行バージョンの3文書すべてに対して有効かどうか。
// 1つでもバージョンが食い違う(未同意・文書更新のいずれか)場合はfalseになり、
// ConsentGateが表示される。
export function isConsentUpToDate(consent) {
  return !!consent && CONSENT_DOCS.every(doc => consent[doc.versionKey] === doc.version);
}
