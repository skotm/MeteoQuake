# S-net 画像処理ドキュメント

S-netの画像を取得し、観測点の色を読み取るまでの一連の処理を詳しく説明します。

---

## 📋 目次

1. [全体フロー](#全体フロー)
2. [ステップ1: タイマーによる定期実行](#ステップ1-タイマーによる定期実行)
3. [ステップ2: 時刻計算 & URL生成](#ステップ2-時刻計算--url生成)
4. [ステップ3: HTTP通信で画像を取得](#ステップ3-http通信で画像を取得)
5. [ステップ4: 画像合成](#ステップ4-画像合成)
6. [ステップ5: 色置換処理](#ステップ5-色置換処理)
7. [ステップ6: 観測点座標から色を読み取る](#ステップ6-観測点座標から色を読み取る)
8. [ステップ7: RGB値から震度値に変換](#ステップ7-rgb値から震度値に変換)
9. [ステップ8: 結果をソート](#ステップ8-結果をソート)
10. [ステップ9: 別ウィンドウに結果を表示](#ステップ9-別ウィンドウに結果を表示)
11. [エラーハンドリング](#エラーハンドリング)
12. [処理タイムライン](#処理タイムライン)

---

## 全体フロー

```
[Timer_Tick]
    ↓
[GetImg() 開始] (async/await)
    ↓
[時刻計算 & URL生成]
    ↓
[2つのタイル画像をHTTP取得]
    ↓
[画像合成]
    ↓
[UI表示 & 色置換処理]
    ↓
[観測点座標から色を読み取り]
    ↓
[RGB→震度に変換]
    ↓
[結果を別ウィンドウに表示]
```

---

## ステップ1: タイマーによる定期実行

**コード位置**: Form1.cs, 行27-32

```csharp
private void Timer_Tick(object sender, EventArgs e)
{
    Timer.Interval = 1000 * (60 - DateTime.Now.Second + Settings.Default.GetDelay);
    GetImg();
}
```

| 項目 | 説明 |
|------|------|
| **実行間隔** | 毎分00秒（設定された遅延時間を加味） |
| **GetDelay** | ユーザー設定の遅延秒数（デフォルト約45-60秒） |
| **理由** | データが海しるサーバーに到着するまでの遅延を考慮 |

---

## ステップ2: 時刻計算 & URL生成

**コード位置**: Form1.cs, 行109-121

```csharp
public async void GetImg()
{
    var nowTime = DateTime.Now;
    var nowTimeUniv = nowTime.ToUniversalTime();
    var dataTime = nowTimeUniv - TimeSpan.FromSeconds(nowTimeUniv.Second);
    
    if (nowTime.Second < Settings.Default.GetDelay % 60 - 1)
        dataTime -= TimeSpan.FromMinutes(1);
    
    dataTime -= TimeSpan.FromMinutes(Settings.Default.GetDelay / 60);
    
    var time = dataTime.ToString("yyyyMMddHHmm") + "00";
    var kyoshinURL1 = "https://www.msil.go.jp/data/tiles/smoni/tileimage/" + time + "/" + time + "/5/28/11.png";
    var kyoshinURL2 = "https://www.msil.go.jp/data/tiles/smoni/tileimage/" + time + "/" + time + "/5/28/12.png";
```

### 時刻変換の流れ

| 項目 | 例 |
|------|-----|
| 現地時刻 | 2026-08-10 15:30:45 |
| UTC時刻 | 2026-08-10 06:30:45 |
| 秒削除後 | 2026-08-10 06:30:00 |
| 遅延を引く | 2026-08-10 06:15:00 |
| URL形式 | 202608101500 |

---

## ステップ3: HTTP通信で画像を取得

**コード位置**: Form1.cs, 行123-126

```csharp
var mainImg_normal = new Bitmap(180, 320);
using var g = Graphics.FromImage(mainImg_normal);
using var img1 = new Bitmap(await client.GetStreamAsync(kyoshinURL1));
using var img2 = new Bitmap(await client.GetStreamAsync(kyoshinURL2));
```

**特徴:**
- `using` 文でメモリ効率化
- `async/await` でUI をブロックしない
- PNG から Bitmap へ自動変換

---

## ステップ4: 画像合成

**コード位置**: Form1.cs, 行129-131

```csharp
g.DrawImage(img1, -86, -164, 256, 256);
g.DrawImage(img2, -86, 92, 256, 256);
SnetImg.BackgroundImage = mainImg_normal;
```

### 座標の意味

| 画像 | 座標 | 見える領域 | 地域 |
|------|------|----------|------|
| img1 | (-86, -164) | img1の(86,164)以降 | 日本北東部 |
| img2 | (-86, 92) | img2の(86,92)以降 | 日本南西部 |

---

## ステップ5: 色置換処理

**コード位置**: Form1.cs, 行133-140

```csharp
if (Settings.Default.ReplaceColor)
{
    var changeImg = new Bitmap(mainImg_normal.Width, mainImg_normal.Height);
    using var g_rp = Graphics.FromImage(changeImg);
    g_rp.DrawImage(mainImg_normal, 
        new Rectangle(0, 0, mainImg_normal.Width, mainImg_normal.Height),
        0, 0, mainImg_normal.Width, mainImg_normal.Height,
        GraphicsUnit.Pixel, IA);
    
    changeImg.MakeTransparent(Color.FromArgb(0, 0, 0));
    SnetImgColor.BackgroundImage = changeImg;
}
```

### 色マップの設定（SettingReload内）

```csharp
var colorChange = new List<ColorMap>();
var colorsSt = Settings.Default.ReplaceColors.Split('/');

for (int i = 0; i * 2 < colorsSt.Length; i++)
{
    var colors1 = colorsSt[i * 2].Split(',');
    var colors2 = colorsSt[i * 2 + 1].Split(',');
    
    colorChange.Add(new ColorMap()
    {
        OldColor = Color.FromArgb(int.Parse(colors1[0]), int.Parse(colors1[1]), int.Parse(colors1[2])),
        NewColor = Color.FromArgb(int.Parse(colors2[0]), int.Parse(colors2[1]), int.Parse(colors2[2]))
    });
}
IA.SetRemapTable(colorChange.ToArray());
```

---

## ステップ6: 観測点座標から色を読み取る

**コード位置**: Form1.cs, 行142-155

### Y11タイル（北東部）

```csharp
var dict = new Dictionary<string, double>();

foreach (var obsPt in obsPoints.Tiles.Z5.X28.Y11)
{
    var pointColor = img1.GetPixel(obsPt.X, obsPt.Y);
    if (Converter.RGB2Sindo.TryGetValue([pointColor.R, pointColor.G, pointColor.B], out double sindo))
        dict.Add(obsPt.Name, sindo);
}
```

### Y12タイル（南西部）

```csharp
foreach (var obsPt in obsPoints.Tiles.Z5.X28.Y12)
{
    var pointColor = img2.GetPixel(obsPt.X, obsPt.Y);
    if (Converter.RGB2Sindo.TryGetValue([pointColor.R, pointColor.G, pointColor.B], out double sindo))
        dict.Add(obsPt.Name, sindo);
}
```

---

## ステップ7: RGB値から震度値に変換

**コード位置**: Form1.cs, 行345-455

### RGB2Sindo テーブル

```c#
public static readonly Dictionary<int[], double> RGB2Sindo = new(new ArrayEqualityComparer<int>())
{
    { new int[] {0, 0, 0}, -9.9},           // 黒色 → データなし
    { new int[] {0, 0, 205}, -3.0},         // 濃青色 → 震度-3.0
    { new int[] {63, 250, 54}, 0.0},        // 黄緑色 → 震度0.0
    { new int[] {255, 255, 0}, 2.0},        // 黄色 → 震度2.0
    { new int[] {255, 68, 0}, 5.0},         // オレンジ → 震度5.0
    { new int[] {170, 0, 0}, 7.0}           // 濃い赤 → 震度7.0
};
```

### ArrayEqualityComparer の役割

```csharp
class ArrayEqualityComparer<T> : IEqualityComparer<T[]>
{
    public bool Equals(T[] x, T[] y) => StructuralComparisons.StructuralEqualityComparer.Equals(x, y);
    public int GetHashCode(T[] obj) => StructuralComparisons.StructuralEqualityComparer.GetHashCode(obj);
}
```

**重要:** 配列をDictionary のキーとして使う場合、内容による比較が必要（参照比較ではマッチしない）

---

## ステップ8: 結果をソート

**コード位置**: Form1.cs, 行157

```csharp
dict = dict.OrderByDescending(x => x.Value).ToDictionary();
```

例: `{ "N.S6N05": 5.0, "N.S2N03": 2.0, "N.S1N01": 1.5 }`

---

## ステップ9: 別ウィンドウに結果を表示

**コード位置**: Form1.cs, 行158-161

```csharp
ObsValues.ValueChange(dataTime.ToLocalTime().ToString("yyyy/MM/dd HH:mm"), dict);

if (Settings.Default.ViewTime)
    L_infos.Text = $"{dataTime.ToLocalTime():yyyy/MM/dd HH:mm}\n最大: {dict.First().Value:0.0} ({dict.First().Key})";
```

---

## エラーハンドリング

**コード位置**: Form1.cs, 行162-180

```csharp
catch (WebException ex)
{
    L_infos.Text = ex.Message;
}
catch (System.Net.Sockets.SocketException ex)
{
    L_infos.Text = ex.Message;
}
catch (Exception ex)
{
    L_infos.Text = ex.Message;
    Directory.CreateDirectory($"Log\\ErrorLog\\{DateTime.Now:yyyyMM}");
    File.WriteAllText(
        $"Log\\ErrorLog\\{DateTime.Now:yyyyMM}\\{DateTime.Now:yyyyMMdd}.txt",
        $"{DateTime.Now:HH:mm:ss} {ex}"
    );
}
```

---

## 処理タイムライン

```
時刻: 2026-08-10 15:31:45 JST

1. Timer_Tick() 発火
   ↓
2. 取得対象時刻計算: 2026-08-10 06:15:00 UTC
   ↓
3. URL生成
   ↓
4. HTTP GET (img1, img2 ダウンロード 2-3秒)
   ↓
5. 画像合成
   ↓
6. UI表示
   ↓
7. 観測点色読み取り（150点以上、～100ms）
   ↓
8. RGB→震度変換
   ↓
9. ソート
   ↓
10. Form3 と L_infos に表示完了
```

---

## 重要な定数

| 項目 | 値 | 説明 |
|------|-----|------|
| キャンバス幅 | 180px | 最終出力画像の幅 |
| キャンバス高さ | 320px | 最終出力画像の高さ |
| タイル画像サイズ | 256×256px | 海しるから取得する1タイルのサイズ |
| img1 オフセット | (-86, -164) | 北東部タイルの配置位置 |
| img2 オフセット | (-86, 92) | 南西部タイルの配置位置 |
| ズームレベル | 5 | タイル座標 z=5 |
| X座標 | 28 | タイル座標 x=28 |
| Y座標 | 11, 12 | タイル座標 y=11（北東）, 12（南西） |

---

## 関連ファイル

| ファイル | 用途 |
|---------|------|
| ObsPoints.json | 観測点座標情報 |
| Form1.cs | メイン画面・処理ロジック |
| Form3.cs | 観測値表示ウィンドウ |
| App.config | アプリケーション設定 |

---

## まとめ

このS-netの画像処理システムは以下の特徴を持っています：

- **リアルタイム性**: 毎分自動更新
- **高精度**: 150点以上の観測点からピクセル単位で読み取り
- **信頼性**: エラーハンドリング＆ログ記録
- **柔軟性**: ユーザー設定で色置換・遅延調整可能
- **非同期処理**: async/await で UI をブロックしない
- **メモリ効率**: using文で確実なリソース解放
