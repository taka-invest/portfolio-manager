# research-engine（買い場・売り場研究：P0）

`docs/research/IMPLEMENTATION_ROADMAP.md` の P0 を手元のPCで実行する Python スクリプト群。
アプリ本体（Firebase）とは独立しており、本番環境には触れない。

## P0-A：データ取得

```powershell
python research-engine/fetch_fred.py
```

| 系列 | 内容 | 開始日（2026-11-27 確認） |
|---|---|---|
| `VIXCLS` | VIX 終値 | 1990-01-02 |
| `NASDAQ100` | NASDAQ-100 終値 | 1986-01-02 |
| `NASDAQCOM` | NASDAQ総合 終値 | 1971-02-05 |
| `DEXJPUS` | USD/JPY（NY正午レート） | 1971-01-04 |

- 取得元：FRED（Federal Reserve Bank of St. Louis）の CSV ダウンロード（`fredgraph.csv`）。**APIキーは不要**
- 保存先：`data/raw/fred/{ID}.csv` と `{ID}.meta.json`（取得日時・件数・欠損数・開始/終了日・SHA-256）
- 欠損（休場など）は空欄のまま保持し、0 で埋めない。読み込み時（`data.load`）は欠損行を除く
- 毎回の取得で、ヘッダーが要求した系列か、日付が増加しているか、値が正の数かを検査する。異常があればその系列は保存しない

## 利用条件（重要）

- **個人・非商用の研究に限る**。NASDAQ系の系列は FRED で「Pre-Approval Required」。個人の非商用利用は可、それ以外は権利者の許可が必要
- **`data/` は `.gitignore` 済みで、公開リポジトリには入れない**（再配布にあたるため）。`tests/research-engine.test.js` が、追跡されていないことを毎回確認する
- アプリに渡すのは、集計した結果（分布の要約・件数）だけ（P0-B 以降）

## テスト

```powershell
python -m unittest discover -s research-engine/tests
```

ネットワークを使わずに、解析・欠損の扱い・誤った系列の拒否・保存内容を確認する。`npm test` からも（Python と pandas がある環境では）実行される。

必要なもの：Python 3.11 以上、pandas（`data.py` のみ。取得スクリプトは標準ライブラリだけで動く）

## P0-B：VIX≥30 イベント研究

```powershell
python research-engine/vix_event_study.py
```

- 仕様：`docs/research/MARKET_TIMING_MODEL_DESIGN.md` §2。パラメーターは `PARAMS`（版 `p0b-1`）で**結果を見る前に固定**。変える場合は版を上げて別の結果として保存する
- 比べる買い方：S1 翌日に全額／S2 50/30/20（翌日・+11日・+21日）／S3 VIX<20に戻った翌日（最長120営業日）／S4 安値から+5%反発かつVIXが局面最高値の75%以下になった翌日（最長120営業日）
- 約定はシグナル翌営業日の終値。買付手数料0.495%を控除。待機中の現金は0%。円建ては取得日と評価日のUSD/JPYで換算
- 出力：`data/results/vix_event_study_p0b-1.json`（**手元のみ・gitignore**）。戦略別・期間別（60/120/250営業日）の中央値・下位5%・最小・プラスの件数・最大逆行幅、S1との差（ブートストラップ95%信頼区間）、イベントごとの結果
- 注意：独立イベントは約30回、比較は 3戦略×3期間×2通貨 の18通り。個々の信頼区間は多重比較を補正していない。NASDAQ-100は配当を含まない価格指数
