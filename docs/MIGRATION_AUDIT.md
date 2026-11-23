# Firebase移行 Phase 0 監査（MIGRATION_AUDIT）

監査日: 2026-11-23 ／ 対象: `feature/firebase-foundation-phase1`（PR #16, 23コミット）
Firebase: Finance Base（`finance-base-edcc7`）

## 0. 結論サマリー

| 区分 | 判定 | 要点 |
|---|---|---|
| Hosting allowlistビルド | **再利用** | `scripts/build-firebase.mjs`はtests/docs/functions等を公開しない。妥当 |
| Firestore同期クライアント | **再利用＋補強済** | リビジョン照合トランザクションは正しい。初回移行8手順のうち①自動バックアップ・④差分・⑥サーバー側バックアップ・⑧再読込照合が欠落→本監査で追加 |
| Firestoreルール | **修正済** | どのGoogleアカウントでも自分用ワークスペースを作れた。許可UID（`/allowlist/{uid}`）方式に変更。Emulatorテスト12件 |
| Cloud Functionsアダプター | **再利用＋修正済** | Netlify `handler(event)`を包む方式は動作する。許可UID判定・失効トークン検査・構造化ログが欠落→追加 |
| 移植済みStock Analyzerコード | **差し替え必須** | PR #16の`functions/src/legacy/*`は`Downloads`の**旧版**。Netlify本番の最新版は`Documents\masya_app\`（2026-09-17）。財務計算にも重大な誤りあり（§3） |
| Stock Analyzer画面 | **未移植** | `index.html`(140KB)・`screener.html`・最新`library.html`(84KB)はリポジトリに無い。`research/library.html`は旧53KB版 |
| CI | **補強済** | 単体テスト＋Playwrightに、Firestoreルールのエミュレーターテストを追加。プレビュー／本番デプロイのワークフローは未作成 |

## 1. リポジトリ構成と既存機能

- `portfolio_manager.html`（123KB、インラインscript 1001–2283行）＋`app/*.js`（data/storage/ui/market/rebalance/staged-funding/navigation/research-import）
- 画面（サイドバー）: ダッシュボード／保有資産／リバランス（allocation・rebalance・after）／市場分析／企業評価／投資リサーチ／取引・購入計画／設定・データ管理
- テスト: `tests/*.test.js`（node:test 60件）、`tests/*.spec.js`（Playwright PC・スマホ 38ケース中26実行、12は端末別スキップ）、`tests/emulator/*.test.mjs`（ルール12件）

## 2. Portfolio Manager データ互換性

### 保存スキーマ（`app/data.js`、version 3、localStorage `pm_workspace_v3`）
トップレベル13キー: `version, positions, targets, cashTarget, cash, confirmed, tax, stagedFunding, plans, trades, watchlist, company, preferences`
- `validate()`は全階層を許可リスト方式で`pick()`するため**未知キーを捨てる**（将来キー追加時の旧クライアント上書きリスク）。
- Firestoreルール制約（`version==3`、`keys().size()<=20`、positions≤10000）と互換。
- 目標配分の既定値（data.js:11-14）は指定値と一致: NVDA15/AVGO10/PLTR30/APP20/SOFI5/CRDO3/RKLB4/SPCX3、現金10%。`kind==='stock'`のみ配分対象（NISA投信=fundは除外）。
- 動的ピラミッディング（`app/staged-funding.js`）: 対象NVDA/AVGO/CRDO、累積0.5/0.8/1.0、PLTR下限30%（税引後で二分探索）。固定金額なし。単体テストあり。

### 主ステート外にあるデータ（Firestore同期の対象外）
| キー | 内容 | 影響 |
|---|---|---|
| `pm-staged-funding-stage` | 段階買付の現在の弾（A/B/C） | **別PCで第1弾に戻る危険**→Phase 4で主ステートへ移すか要対応 |
| `pm_api_key`（Finnhub）, `pm_fmp_key`, `pm_jb_key/pm_jb_bin` | APIキー（平文） | 同期しない方が安全。FMPは未使用キー |
| `pm_fg, pm_vix, pm_vxn, pm_spy, pm_qqq, pm_technicals, pm_earnings_v3, pm_spy_return` | 市場キャッシュ | 再取得可能 |
| `pm_sidebar_collapsed_v1` | UI状態 | 影響なし |

### 発見したバグ・リスク
1. **取引記録で`lotId: undefined`**が主ステートに残り、Firestore`set`が失敗する → クライアントでJSON往復して除去（対応済）。
2. ローカル保存が破損していても空データをアップロードできた → `storageError`検査を追加（対応済）。
3. クラウド→PC取込の差分に`stagedFunding`と`confirmed`が出なかった → 差分表示に追加（対応済）。
4. ローカル自動バックアップは1世代のみ → クラウド側に上書き前スナップショット`users/{uid}/backups/*`を追加（対応済、削除不可）。
5. **オリジン変更**: GitHub Pages→Firebase Hostingでは localStorage が引き継がれない。旧サイトでJSON書出し→新サイトで取込が必須（手順は`docs/firebase-migration.md`）。
6. 第三者CORSプロキシ（allorigins/corsproxy.io/codetabs）経由でYahooを取得しており、保有ティッカーが第三者に送られる → Phase 2で自前Functionsへ置換。
7. バージョン表記の不一致（V2.3/V2.6/V2.7）。

## 3. Stock Analyzer 監査

### ソースの所在
| ファイル | 最新（Netlify本番相当） | リポジトリ |
|---|---|---|
| index.html（個別企業分析） | `Documents\masya_app\index.html` 140KB | **無し** |
| screener.html | `Documents\masya_app\screener.html` 28KB | **無し** |
| library.html | `Documents\masya_app\library.html` 84KB | 旧53KB版を`research/`に移植 |
| analyze.js | `masya_app\netlify\functions\analyze.js` 63KB | 旧58KB版を移植 |
| screener.js | 同 14KB | 旧10KB版を移植 |
| chart.js | 同 1.3KB | 移植済（同等） |
| eps-revisions.js | 同 6KB（Finvizスクレイピング） | **無し** |
| sec-8k-guidance.js | 同 8KB | **無し** |
| netlify.toml / package.json | あり | 不要（移行先はfirebase.json） |

ウォッチリストは`localStorage.masyaWatchlist`（文字列配列）。`app/research-import.js`に取込処理あり。

### Netlify固有の依存
- `handler(event)`形式（`httpMethod/queryStringParameters/body`→`{statusCode,headers,body}`）
- `Access-Control-Allow-Origin: *`とOPTIONS応答
- フロントが`/.netlify/functions/{analyze,chart,screener,eps-revisions,sec-8k-guidance}`を直接呼ぶ（index.html計7箇所、library.html 3箇所、screener.html 1箇所）
- SEC User-Agentが`contact@example.com`直書き（SECの適正アクセス方針違反）

### 外部アクセス
- SEC: `www.sec.gov/files/company_tickers.json`、`data.sec.gov/submissions`、`data.sec.gov/api/xbrl/companyfacts`
- Yahoo: v8/chart（日足・週足）、v7/quote、v10/quoteSummary（**v7/v10はcrumb必須で現状は空応答になり得る**）
- PR #16の`sec-gateway.js`はSECに550ms間隔・UA・10分キャッシュを適用。chart.jsはゲートウェイ未経由。リトライ・429/Retry-After処理なし。キャッシュ無制限（companyfactsは数MB〜20MBでOOMリスク）

### 財務ロジックの重大な問題（正式機能として公開不可）
1. **Q4欠落**: 四半期は75〜110日の期間のみ採用し、Q4=年次−9か月累計を合成しない → 配列添字ベースのYoY（`revQD[i+4]`）が約16か月前との比較になり、QoQ・営業レバレッジ・成長加速度・Rule of 40・TTM EPSが連鎖的に誤る。
2. **年次の重複**: 10-Kに含まれる前年比較値を除去しない → 3年CAGRが過小、自社株買い累計が二重計上。
3. 修正提出（10-Q/A, 10-K/A）より初回提出を優先。`frame`未使用。
4. EPSの基本／希薄化後が混在。`epsGrowthYoY`は実際には純利益成長率。
5. **FCF未実装**（営業CF・設備投資を取得していない）。
6. Rule of 40 = 単四半期YoY＋GAAP営業利益率（FCFマージン版ではない、定義を明示すべき）。
7. 株式数は`CommonStockSharesOutstanding`最新値のみ（複数クラス・希薄化未考慮）。
8. 欠損を0扱い（`??0`）する箇所が複数 → 指示書の「欠損をゼロとして扱わない」に違反。
9. 株価推定: 赤字企業にも業種目標利益率を適用、株数増加・割引を考慮しない、予想と実績が同一スコアに混在、`range=5y`では2021年高値を取得できない。
10. **スクリーナーの確定バグ**: `opMargin`がnullの銘柄でTypeError（screener.js:164-165、最新版も同じ）。
11. IFRS/20-F提出企業・USD以外は対象外。

## 4. 機能対応表（移植漏れチェック）

| # | 旧機能 | 旧所在 | 移植先 | 状態 |
|---|---|---|---|---|
| 1 | 保有ロット・現金・税・目標配分 | PM `app/data.js` | Firestore `users/{uid}/workspaces/portfolio` | 同期実装済・実機未検証 |
| 2 | リバランス・トレードチケット | PM `app/rebalance*.js` | 現状維持 | テストで保護 |
| 3 | 動的ピラミッディング | PM `app/staged-funding.js` | 現状維持＋弾の同期 | 弾の同期は未対応 |
| 4 | 取引履歴・購入計画 | PM inline + data.js | 主ステート | 同期対象 |
| 5 | ウォッチリスト（PM） | data.js `watchlist` | 主ステート | 同期対象 |
| 6 | ウォッチリスト（SA） | `masyaWatchlist` | PM watchlistへ統合 | 取込機能あり |
| 7 | 個別企業分析 | SA index.html + analyze.js | 「個別企業分析」画面＋`/api/analyze` | **未着手（画面）・旧版のみ（API）** |
| 8 | 銘柄スクリーナー | SA screener.html + screener.js | 「銘柄スクリーナー」＋`/api/screener` | 同上 |
| 9 | 株価チャート | SA chart.js | 「株価チャート」＋`/api/chart` | API移植済（未デプロイ） |
| 10 | 投資指標ライブラリ | SA library.html | `research/library.html` | 旧版。最新84KB版に差し替え要 |
| 11 | EPSリビジョン | SA eps-revisions.js（Finviz） | 要判断（スクレイピングの利用条件） | 未移植 |
| 12 | 8-Kガイダンス | SA sec-8k-guidance.js | `/api/guidance` | 未移植 |
| 13 | 市場分析（VIX・F&G・SPY） | PM inline（CORSプロキシ） | `/api/market`に置換 | 未着手 |
| 14 | 企業評価・投資仮説 | PM `company` | 主ステート | 同期対象 |
| 15 | 分析結果の6時間キャッシュ | SA `masya_v2_{ticker}` | Functions側キャッシュ＋クライアントキャッシュ | 未着手 |
