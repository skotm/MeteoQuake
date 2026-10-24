# src/app/ のモジュール構成

巨大だった `src/App.jsx`(約18,500行)を、トップレベルの宣言単位で `src/app/` 以下に分割した。
コードは元のまま移しており、変更点は「他のモジュールから使う宣言に `export` を付けた」
「必要な `import` を各ファイル先頭に付けた」だけ(循環依存なし)。

依存は下の層から上の層への一方向:

| 層 | モジュール | 内容 |
|---|---|---|
| 基盤 | `consent` `debugLog` `layoutHooks` `navigation` `theme` `glass` `globalStyles` | 同意管理、デバッグログ、画面幅フック、ナビ定義、テーマ、Glass UI、グローバルCSS |
| 地図 | `mapDataLoaders` `mapIcons` `geo` `mapFocus` `shakeCameraFollow` `shakeMapLayers` `stationIcons` | MapLibre/地図データの読み込み、アイコン、地理計算、視点移動(EEW・揺れ検知の追従)、揺れ検知レイヤ |
| データ | `quakeCards` `tsunamiData` `estIntensity` `liveFeeds` `stations` `eqdb` `tideData` `cmt` `testSimulation` `settingsStorage` `colorSchemes` | 地震・津波・EEWのAPI/WebSocket、観測点、EQDB、潮位、CMT、テスト配信用計算、設定の保存、震度配色 |
| UI部品 | `eewUi` `quakeDetailUi` `navUi` `mapOverlayUi` `tsunamiTideUi` `quakeSearchUi` `settingsPrimitives` `settingsPanels` `testPanels` | EEWカード、地震詳細、ナビ、地図上の表示、津波・潮位、検索、設定部品、テスト配信パネル |
| 大型コンポーネント | `MapCanvas` `BottomDock` `SettingsBody` `ConsentGate` | 地図、ボトムシート、設定画面本体、同意画面 |
| 本体 | `App.jsx` | `App`コンポーネント(状態管理と全体の組み立て) |

行数が多いまま残っているのは `App`(約2,700行)、`MapCanvas`(約2,400行)、`BottomDock`(約1,900行)。
これらは1つのコンポーネントの中身なので、さらに分けるには hook やサブコンポーネントへの手作業の切り出しが必要。
