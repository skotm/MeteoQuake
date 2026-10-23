# 強震モニタ観測点編集ソフト 要件仕様書
## MeteoQuake-KyoshinViewerを参考にした実装ガイド

---

## 1. プロジェクト概要

**プロジェクト名:** ObservationPointEditorSoftware  
**目的:** 強震モニタ(K-NET, KiK-net, S-net)の観測点データを一元管理・編集・保存するWebアプリケーション  
**技術スタック:** 
- **フロントエンド:** React 19 + TypeScript + Vite
- **バックエンド:** (オプション) Cloudflare Workers / Node.js
- **ビルド・デプロイ:** GitHub Pages (静的ホスティング)
- **対応ブラウザ:** 最新Chrome, Firefox, Safari, Edge

---

## 2. 主要機能

### 2.1 観測点データ管理

#### 2.1.1 CRUD操作

**新規追加**
- ユーザーが手動で観測点を追加
- 自動採番: `NEW001`, `NEW002`, ...
- デフォルト値:
  - 位置: 東京駅付近 (35.0°, 139.0°)
  - 種別: K-NET
  - 名前: "新規観測点"
  - 地域: "未設定"

**削除**
- 選択した観測点を削除
- 選択状態をクリア
- `IsModified` フラグを更新

**更新**
- 観測点のプロパティを編集:
  - コード、名前、地域、サブ地域
  - 緯度経度（地理座標）
  - ピクセル座標（Center + Offset）
  - 運用停止状態
- リアルタイムで DataGrid に反映

**検索・読み込み**
- コード、名前、地域による複合検索
- 大文字小文字を区別しない

#### 2.1.2 フィルタリング

```typescript
interface FilterOptions {
  searchText: string;           // テキスト検索
  showKNet: boolean;           // K-NET の表示
  showKiKNet: boolean;         // KiK-net の表示
  showSNet: boolean;           // S-net の表示
  showSuspended: boolean;      // 運用停止中の観測点を表示
}
```

- 複合フィルタリング（AND条件）
- リアルタイム反映（検索入力時）
- フィルタ後の件数表示

#### 2.1.3 統計情報

- 総観測点数
- フィルタ後の表示件数
- 種別別の統計（K-NET数、KiK-net数、S-net数）

---

### 2.2 地図表示・編集

#### 2.2.1 強震モニタ画像表示

参考実装: `useRealtimeStream.ts` (MeteoQuake)

- **リアルタイム画像**
  - K-NET, KiK-net, S-net の強震モニタ画像を表示
  - 画像種別の選択（震度分布、最大加速度など）
  
- **手動更新**
  - 「画像更新」ボタン で最新画像を取得
  
- **画像キャッシング**
  - ローカルストレージで一定期間キャッシュ

#### 2.2.2 観測点の視覚化

参考実装: `shindoColorScale.ts`, `stationTerritory.ts` (MeteoQuake)

- **カラー表示**
  - 強震モニタ本来のグラデーション色（-3.0〜7.0 の震度相当値）
  
- **種別別マーカー**
  - K-NET: オレンジ
  - KiK-net: 赤
  - S-net: 青
  - 運用停止: 灰色
  
- **ラベル表示**
  - 観測点コード・名前（ズーム時に表示/非表示を切り替え）

#### 2.2.3 マウス操作

**クリック選択**
- クリック範囲内の観測点を検出
- 複数候補時は選択ダイアログ表示
- DataGrid との双方向同期

**ドラッグ移動**
- 観測点をドラッグして位置を変更
- ピクセル座標（Point: Center + Offset）を更新
- Undo/Redo 対応

**ズーム・パン**
- マウスホイール で倍率変更（1.0x～10.0x）
- ドラッグ で パン操作

#### 2.2.4 デバッグ情報表示（オプション）

- マウス位置（地理座標・ピクセル座標）
- 画像サイズ
- 選択中の観測点情報

---

### 2.3 Undo/Redo機能

参考実装: `ObservationPointEditorModel.cs` (KyoshinEewViewerIngen)

```typescript
interface UndoRedoStack {
  undoStack: ObservationPointChange[];
  redoStack: ObservationPointChange[];
  maxStackSize: number = 50;  // メモリ対策
}

interface ObservationPointChange {
  point: CommonObservationPoint;
  oldValue: KyoshinImagePoint | null;
  newValue: KyoshinImagePoint | null;
}
```

- **Undo**: `Ctrl+Z`
- **Redo**: `Ctrl+Y`, `Ctrl+Shift+Z`
- スタック容量制限: 最大50件
- 新しい変更後は Redo スタックをクリア

---

### 2.4 ファイル入出力

#### 2.4.1 JSON形式

**読み込み** (`*.json`)
- CommonObservationPoint[] の逆シリアライズ
- snake_case プロパティ命名規則
- エラーハンドリング（フォーマット不正）

```typescript
interface CommonObservationPoint {
  type: "k_net" | "kik_net" | "s_net";
  code: string;
  name: string;
  region: string;
  sub_region?: string;
  location: {
    latitude: number;
    longitude: number;
  };
  point?: {
    center: { x: number; y: number };
    offset: { x: number; y: number };
  };
  is_suspended: boolean;
}
```

**保存** (`*.json`)
- UTF-8 エンコーディング
- インデント表示（見やすさ）
- タイムスタンプ追加（オプション）

#### 2.4.2 KMOP形式（圧縮バイナリ）

参考実装: `ObservationPointEditorSeries.cs` (KyoshinEewViewerIngen)

**保存** (`*.kmop`)
- MessagePack + LZ4 圧縮
- ヘッダー付き:
  - Version: 0
  - PackedAt: 保存日時
  - Source: "MeteoQuake ObservationPointEditor"
  - DataVersion: ユーザー指定

#### 2.4.3 NIEDデータインポート

**対応ファイル**
- `sitepub_kik_sj.csv` (KiK-net)
- `sitepub_knet_sj.csv` (K-NET)
- `sitepub_snet_sj.csv` (S-net)

**処理内容**
1. CSV解析
2. 重複チェック（既存コードとの比較）
3. 追加/更新の判定
4. インポート結果ダイアログ表示

---

### 2.5 データ品質管理

参考実装: `stationTerritory.ts`, `epicenterEstimation.ts` (MeteoQuake)

#### 2.5.1 重複統合

**検出**: 観測点コードが同じデータを検出

**統合ロジック** (優先度順)
1. 強震モニタ座標（Point）の有無 → ある方を優先
2. 運用中/中止 → 運用中を優先
3. 地理座標（Location）の有無
4. 名前の有無

**結果表示**
- 統合グループ数
- 削除数
- 統合詳細（統合前後の座標比較）

#### 2.5.2 未割当ピクセル検出

**処理**
- 各観測点の3×3ピクセル範囲を記録
- 記録されていないピクセルを検出
- 黒色（RGB=0,0,0）と透過（Alpha=0）を除外

**結果表示**
- 未割当ピクセル数
- 最寄りの観測点を自動選択・表示

#### 2.5.3 透明ピクセル観測点検出

**条件**
- 読み取り位置（Center + Offset）は有効
- かつ3×3範囲内に透明ピクセルを含む

**結果表示**
- 該当観測点数
- 透明ピクセル数のランキング表示（上位15件）

---

## 3. UI構成

### 3.1 全体レイアウト

```
┌──────────────────────────────────────────────────────┐
│ ヘッダー（タイトル・ナビゲーション）                 │
├─────────────────┬──────────────────────────────────┤
│ 左パネル        │ 中央ペイン                        │
│ (380px)         │ (強震モニタ画像 + 観測点)        │
│                 │                                  │
│ ・ファイル操作  │ ┌──────────────────────────┐     │
│ ・編集ボタン    │ │                          │     │
│ ・統計情報      │ │      地図キャンバス       │     │
│                 │ │  (Canvas or SVG Layer)   │     │
│ 左下パネル      │ │                          │     │
│ (検索・フィルタ)│ └──────────────────────────┘     │
│                 │                                  │
├─────────────────┴──────────────────────────────────┤
│ 下部パネル (観測点リスト DataGrid)                 │
└──────────────────────────────────────────────────────┘
```

### 3.2 左パネル (380px)

#### ファイルタブ
```
┌─ ファイル ─────────────────────┐
│                                 │
│ [ファイルを開く...]             │
│ [ファイルに保存...]             │
│ ─────────────────────────      │
│ [NIEDデータをインポート]        │
│ [KMOPファイルに保存する]        │
│                                 │
└─────────────────────────────────┘
```

#### 編集タブ
```
┌─ 編集 ──────────────────────────┐
│                                 │
│ [新規観測点追加]                │
│ [選択項目削除]                  │
│ ─────────────────────────      │
│ [重複観測点を統合]              │
│ [未割当ピクセルの検出]          │
│ [透明ピクセル観測点の検出]      │
│                                 │
│ [元に戻す] [やり直し]           │
│                                 │
│ ╭ 統計情報 ╮                   │
│ │ 総件数: 1000件              │
│ │ 表示中: 950件               │
│ ╰─────────╯                    │
│                                 │
└─────────────────────────────────┘
```

### 3.3 中央ペイン

#### 上部バー
```
┌─────────────────────────────────────────────────────┐
│ [画像更新] [Shindo ▼] ☐強震画像 ☑観測点            │
└─────────────────────────────────────────────────────┘
```

#### 地図描画エリア
- HTML Canvas / SVG で強震モニタ画像を描画
- 観測点を円形マーカーで表示
- マウスイベント対応

#### 下部バー
```
┌─────────────────────────────────────────────────────┐
│ 倍率: [━━━━━━━] x1.5                              │
└─────────────────────────────────────────────────────┘
```

### 3.4 下部パネル（観測点リスト）

#### リストヘッダー
```
┌─────────────────────────────────────────────────────┐
│ 観測点リスト (950件表示中)                          │
│                                                      │
│ 検索: [                    ]                        │
│ ☑K-NET ☑KiK-net ☑S-net ☑運用停止中               │
└─────────────────────────────────────────────────────┘
```

#### DataGrid

| 列 | プロパティ | 幅 | 編集可 |
|---|-----------|-----|-------|
| 種別 | type | 80px | × |
| コード | code | 100px | ○ |
| 名前 | name | 200px | ○ |
| 地域 | region | 150px | ○ |
| 地域2 | sub_region | 150px | ○ |
| 緯度 | location.latitude | 100px | ○ |
| 経度 | location.longitude | 100px | ○ |
| X座標 | point.center.x | 80px | ○ |
| Y座標 | point.center.y | 80px | ○ |
| 運用停止 | is_suspended | 100px | ○ |

---

## 4. データモデル

### 4.1 共通型定義

```typescript
export type ObservationPointType = 'k_net' | 'kik_net' | 's_net';

export interface Location {
  latitude: number;   // 緯度
  longitude: number;  // 経度
}

export interface Point2D {
  x: number;
  y: number;
}

export interface KyoshinImagePoint {
  center: Point2D;    // 中心座標（ピクセル）
  offset: Point2D;    // 読み取りオフセット
}

export interface CommonObservationPoint {
  type: ObservationPointType;
  code: string;
  name: string;
  region: string;
  subRegion?: string;
  location: Location;
  point?: KyoshinImagePoint;
  isSuspended: boolean;
}
```

### 4.2 Undo/Redo

```typescript
export interface ObservationPointChange {
  point: CommonObservationPoint;
  oldPoint: KyoshinImagePoint | null;
  newPoint: KyoshinImagePoint | null;
}

export interface UndoRedoManager {
  undoStack: ObservationPointChange[];
  redoStack: ObservationPointChange[];
  
  recordChange(change: ObservationPointChange): void;
  undo(): boolean;
  redo(): boolean;
  clear(): void;
}
```

### 4.3 フィルター状態

```typescript
export interface FilterState {
  searchText: string;
  showKNet: boolean;
  showKiKNet: boolean;
  showSNet: boolean;
  showSuspended: boolean;
}

export interface FilteredData {
  totalCount: number;
  filteredCount: number;
  points: CommonObservationPoint[];
}
```

---

## 5. 技術スタック・アーキテクチャ

### 5.1 ライブラリ構成

```json
{
  "runtime": "Node.js 24 LTS",
  "frontend": {
    "react": "19.2.7",
    "typescript": "~6.0.2",
    "vite": "8.1.1"
  },
  "optional": {
    "pwa": "vite-plugin-pwa@1.3.0"
  },
  "deployment": {
    "hosting": "GitHub Pages",
    "ci_cd": "GitHub Actions"
  }
}
```

### 5.2 レイヤー構成

```
src/
├── components/                    ← React コンポーネント
│   ├── EditorLayout.tsx          ← メインレイアウト
│   ├── MapCanvas.tsx             ← 地図描画
│   ├── LeftPanel.tsx             ← 左パネル
│   ├── DataGridPanel.tsx         ← リスト表示
│   └── Dialogs/                  ← ダイアログ類
│
├── hooks/                         ← React Custom Hooks
│   ├── useObservationPoints.ts   ← データ管理
│   ├── useUndoRedo.ts            ← Undo/Redo
│   ├── useFileIO.ts              ← ファイル操作
│   └── useFilter.ts              ← フィルター
│
├── services/                      ← ビジネスロジック
│   ├── observationPointService.ts ← CRUD操作
│   ├── filterService.ts           ← フィルタリング
│   ├── importService.ts           ← インポート
│   ├── duplicateConsolidation.ts ← 重複統合
│   └── pixelDetection.ts          ← ピクセル検出
│
├── utils/                         ← ユーティリティ
│   ├── fileFormat.ts              ← JSONパース
│   ├── geometry.ts                ← 座標計算
│   └── formatters.ts              ← データ表示
│
├── types/                         ← TypeScript型定義
│   └── index.ts
│
└── App.tsx                        ← エントリーポイント
```

### 5.3 推奨プロジェクト構造

```
MeteoQuake-ObservationPointEditor/
├── .github/
│   └── workflows/
│       ├── deploy.yml             ← GitHub Pages デプロイ
│       └── lint.yml               ← ESLint 検査
├── src/
├── public/                         ← 静的ファイル
│   ├── terms-of-use.md
│   ├── privacy-policy.md
│   └── notices.md
├── index.html                     ← Vite エントリー
├── vite.config.ts
├── tsconfig.json
├── eslint.config.js
├── package.json
└── README.md
```

---

## 6. イベント・ダイアログ

### 6.1 主要イベント

| イベント | トリガー | 処理 |
|---------|---------|------|
| `ObservationPointSelected` | DataGrid クリック / 地図クリック | 両側を同期選択 |
| `ObservationPointMoved` | ドラッグで観測点移動 | 座標更新 + Undo記録 |
| `FilterChanged` | フィルター変更 | リスト再フィルタリング |
| `SearchTextChanged` | 検索ボックス変更 | リスト再フィルタリング |
| `DataModified` | 任意のCRUD操作 | `IsModified = true` |

### 6.2 ダイアログ

| ダイアログ | トリガー | 内容 |
|-----------|---------|------|
| ファイル選択 | 「ファイルを開く」 | JSON ファイルピッカー |
| ファイル保存 | 「ファイルに保存」 | JSON ファイルセーブ |
| KMOP保存 | 「KMOPファイルに保存」 | セーブ + バージョン入力 |
| NIEDインポート | 「NIEDデータをインポート」 | ディレクトリ選択 + 確認 + 結果表示 |
| 重複統合確認 | 「重複観測点を統合」 | 実行確認 + 結果詳細表示 |
| 未割当ピクセル結果 | 「未割当ピクセルの検出」 | 検出数 + 最寄り観測点 |
| 透明ピクセル結果 | 「透明ピクセル検出」 | 該当観測点数 + ランキング |
| エラー | ファイル操作失敗時 | エラーメッセージ表示 |

---

## 7. キーバインディング

| キー | 機能 | 対応ブラウザ |
|-----|------|-----------|
| `Ctrl+Z` / `Cmd+Z` | Undo | All |
| `Ctrl+Y` / `Cmd+Y` | Redo | All |
| `Ctrl+Shift+Z` / `Cmd+Shift+Z` | Redo | All |
| `Del` / `Backspace` | 選択観測点削除 | All (DataGrid フォーカス時) |
| `Ctrl+S` / `Cmd+S` | ファイル保存 | All (ブラウザのデフォルト抑止) |

---

## 8. エラーハンドリング

### 8.1 ファイル操作

```typescript
enum FileOperationError {
  FileNotFound = 'FILE_NOT_FOUND',
  InvalidFormat = 'INVALID_FORMAT',
  ParseError = 'PARSE_ERROR',
  SaveFailed = 'SAVE_FAILED',
  PermissionDenied = 'PERMISSION_DENIED',
}
```

### 8.2 インポート操作

- CSV フォーマット不正 → スキップ + エラー行番号表示
- ディレクトリ選択キャンセル → 処理中断
- 大量データ (>10,000件) → プログレス表示

### 8.3 地図描画

- 画像ダウンロード失敗 → 通知メッセージ + フォールバック表示
- メモリ不足 → 警告 + Undo履歴縮小

---

## 9. パフォーマンス要件

- **起動時間**: < 3秒
- **ファイル読み込み**: 10,000件を < 3秒で処理
- **検索応答**: リアルタイム（遅延 < 200ms）
- **地図ズーム**: スムーズ（60fps 維持）
- **Undo/Redo**: 即座に反応（< 100ms）
- **DataGrid スクロール**: 1000件以上でも滑らか

---

## 10. テスト方針

### 10.1 ユニットテスト

- `observationPointService` — CRUD, 検索
- `filterService` — フィルタロジック
- `duplicateConsolidation` — 統合アルゴリズム
- `fileFormat` — JSON解析・シリアライズ

### 10.2 統合テスト

- ファイルI/O（読み込み → 編集 → 保存）
- NIEDインポート → 重複統合 → 保存
- Undo/Redo の逐次操作

### 10.3 E2E テスト

- マウス操作（クリック、ドラッグ、ズーム）
- フィルタ検索の動作
- ダイアログの表示・入力

---

## 11. 開発ガイドライン

### 11.1 コーディング規則

- **言語**: TypeScript (strict mode)
- **フォーマッター**: Prettier
- **リンター**: ESLint + typescript-eslint
- **命名規則**:
  - コンポーネント: PascalCase (`EditorLayout.tsx`)
  - Hook: camelCase + use接頭辞 (`useObservationPoints.ts`)
  - 関数: camelCase (`fetchObservationPoints()`)
  - 定数: UPPER_SNAKE_CASE (`MAX_STACK_SIZE`)

### 11.2 React/TypeScript パターン

```typescript
// Hook 例
export function useObservationPoints() {
  const [points, setPoints] = useState<CommonObservationPoint[]>([]);
  const [filtered, setFiltered] = useState<CommonObservationPoint[]>([]);
  const [isModified, setIsModified] = useState(false);

  const addPoint = useCallback((point: CommonObservationPoint) => {
    setPoints(prev => [...prev, point]);
    setIsModified(true);
  }, []);

  return { points, filtered, isModified, addPoint };
}

// コンポーネント 例
export function DataGridPanel({
  points,
  selected,
  onSelectionChange,
}: DataGridPanelProps) {
  return (
    <div className="data-grid">
      {/* DataGrid 実装 */}
    </div>
  );
}
```

### 11.3 CI/CD (GitHub Actions)

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - uses: actions/deploy-pages@v4
```

---

## 12. セキュリティ・プライバシー

### 12.1 利用規約（参考）

MeteoQuake-KyoshinViewerの `terms-of-use.md` を参考に:
- 非公式アプリケーションであることの明記
- 免責事項（情報の正確性について）
- 禁止事項（データ二次利用の制限、不正アクセスの禁止）
- ライセンス（MIT License）

### 12.2 プライバシー

- ローカルストレージのみ使用（クラウド保存なし）
- 個人情報の収集なし
- 分析・トラッキング機能は最小限

---

## 13. ドキュメント・リソース

### 13.1 参考資料

**このプロジェクトが参考にすべきリポジトリ:**
- [KyoshinEewViewerIngen](https://github.com/ingen084/KyoshinEewViewerIngen)
  - Avalonia (C#/.NET) による観測点編集実装
  - Undo/Redo, ファイルI/O, 重複統合ロジック
  
- [MeteoQuake-KyoshinViewer](https://github.com/skotm/MeteoQuake-KyoshinViewer)
  - React + TypeScript による Web UI実装
  - リアルタイムデータ表示、地震検知
  - デプロイメント (GitHub Pages)

### 13.2 公開API

- **K-NET/KiK-net/S-net**: 海しる 強震動情報レイヤー
- **気象庁** 震度データベース: https://www.data.jma.go.jp/svd/eqdb/
- **NIED** 観測点メタデータ: https://www.bosai.go.jp/

---

## 14. 今後の拡張機能

- [ ] リアルタイムデータベース同期 (Firebase / Supabase)
- [ ] コラボレーション編集（複数ユーザー同時編集）
- [ ] バージョン管理（Git統合）
- [ ] 観測点間の距離計算・統計
- [ ] 3D地図ビューア
- [ ] GIS連携（GeoJSON エクスポート）
- [ ] PWA対応（オフライン作業）

---

## 15. デプロイメント・本番化

### 15.1 GitHub Pages デプロイ

```bash
# ビルド
npm run build

# ローカルプレビュー
npm run preview

# GitHub Pages へ自動デプロイ（CI/CD）
# main ブランチへの push で自動実行
```

### 15.2 カスタムドメイン設定

- リポジトリ Settings → Pages
- Custom domain を設定
- DNS CNAME レコード設定

### 15.3 モニタリング

- ビルドエラー検知（GitHub Actions ログ）
- ブラウザコンソールエラー監視（Sentry推奨）
- ページ表示速度監視（Lighthouse CI推奨）
