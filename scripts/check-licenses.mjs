/* ─────────────────────────────────────────────────────
   ライセンス表示のチェック(ビルド前に自動実行 / `npm run licenses` で手動実行)

   設定画面のライセンス全文(public/licenses/)が、依存ライブラリの更新で古くならないよう、
   次の2つを確認して、問題があれば警告する(既定ではビルドは止めない。--strict で失敗にする)。
     1. package.json の dependencies のすべてが、ライセンス表示の対象として登録されているか
        (新しい依存を足したのに、ライセンスの表示を足し忘れる、を防ぐ)。
     2. npm のパッケージについて、node_modules の LICENSE の本文が、public/licenses/ のファイルに
        含まれているか(バージョンを上げて上流のライセンスが変わっていないか)。
   CDNから読み込むライブラリ(MapLibre GL JS・Turf.js)は node_modules に無いため対象外。
   バージョンを上げる時は、mapDataLoaders.js のバージョンと public/licenses/ の全文を手で更新する。
   ───────────────────────────────────────────────────── */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv.find(a => a.startsWith("--root="))?.slice(7) || process.cwd();
const strict = process.argv.includes("--strict");

// dependencies のパッケージ名 → { file: 全文ファイル, upstream: 照合するnode_modules内のパッケージ(無ければnull) }
const REGISTERED = {
  "react": { file: "MIT-React.txt", upstream: "react" },
  "react-dom": { file: "MIT-React.txt", upstream: "react-dom" },
  // Fontsourceのフォントパッケージは、フォント自体のライセンス(OFL 1.1)で配布されている。
  "@fontsource-variable/inter": { file: "OFL-Inter.txt", upstream: "@fontsource-variable/inter" },
  "@fontsource-variable/noto-sans-jp": { file: "OFL-NotoSansJP.txt", upstream: "@fontsource-variable/noto-sans-jp" },
};

const normalize = s => s.replace(/\s+/g, " ").trim();
const problems = [];
const notes = [];

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
for (const name of Object.keys(pkg.dependencies || {})) {
  const reg = REGISTERED[name];
  if (!reg) {
    problems.push(`依存「${name}」は、ライセンス表示の対象として登録されていません(scripts/check-licenses.mjs と、設定画面のライセンス一覧を更新してください)。`);
    continue;
  }
  const licenseFile = join(root, "public", "licenses", reg.file);
  if (!existsSync(licenseFile)) {
    problems.push(`「${name}」のライセンス全文 public/licenses/${reg.file} がありません。`);
    continue;
  }
  const upstreamDir = join(root, "node_modules", reg.upstream);
  const upstreamFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"].map(f => join(upstreamDir, f)).find(existsSync);
  if (!upstreamFile) {
    notes.push(`「${name}」: node_modules にLICENSEが見つからないため、全文の照合は行いませんでした(未インストール、または同梱されていません)。`);
    continue;
  }
  const upstream = normalize(readFileSync(upstreamFile, "utf-8"));
  const committed = normalize(readFileSync(licenseFile, "utf-8"));
  if (upstream && !committed.includes(upstream)) {
    problems.push(`「${name}」の node_modules のLICENSEが、public/licenses/${reg.file} の全文と一致しません。上流のライセンスが更新された可能性があります。内容を確認して、全文を更新してください。`);
  }
}

for (const n of notes) console.log(`[licenses] 注意: ${n}`);
if (problems.length === 0) {
  console.log("[licenses] ライセンス表示のチェック: 問題ありません。");
} else {
  for (const p of problems) console.warn(`[licenses] 警告: ${p}`);
  if (strict) process.exit(1);
}
