# Stock Analyzer → Portfolio Manager 統合実装・監査（11ファイル受領）

更新日: 2026-11-23
移行元: https://masya-stock-analyzer.netlify.app/
移行先: https://taka-invest.github.io/portfolio-manager/portfolio_manager.html
対象ブランチ: docs/stock-analyzer-integration-audit
**Netlifyはまだ削除・停止しない。新バックエンドが実機で稼働してから切替える。**

## 進捗

| フェーズ | 状態 |
|---|---|
| 1: ファイル・技術依存の調査 | **完了（受領11ファイルの静的監査）** |
| 2: 重複／独自機能の判定 | **完了（初期マトリクス）** |
| 3a: バックエンド非依存の投資指標ライブラリ | **コード移植済／PR検証中** |
| 3b: SEC財務データ分析・バッチスクリーナー・チャート | **Netlify関数の移行先未確定／未移植** |
| 3c: 保有銘柄・ウォッチリスト・財務結果の共通管理 | 設計中 |
| 4: 旧新並行・財務数値・PCスマホ・保存復元の検証 | ライブラリの基本導線はブラウザーテストを追加 |
| 5: Netlify停止・削除 | **未実施** |

## 受領した実ファイル

| ファイル | 実態 | 役割と検証上の注意 |
|---|---|---|
| \`index (1).html\`（121280 byte） | メインHTML+inline JS | 個別銘柄の財務分析表示、複数タブ、チャート、簡易セクタースクリーナー、watchlist |
| \`screener.html\`（27669 byte） | スクリーナーHTML | NASDAQ100、S&P500グロース、Russell2000精選などをクライアントで銘柄群に分割しPOST |
| \`library.html\`（53638 byte） | 静的ライブラリ | 株価インパクト5段階、Rule of 40、営業レバレッジ、参入シグナル、EPS/PER価格モデル |
| \`analyze.js\`（57892 byte） | **Netlify Function** | SEC company_tickers、companyfacts、10-Q/10-K提出情報、Yahoo株価／アナリスト等を取得、最高16四半期と企業評価を算出 |
| \`screener.js\`（10523 byte） | **Netlify Function** | SEC XBRLからシグナルスコア／Phase分類／ROF40を計算、Yahoo株価を統合 |
| \`chart.js\`（1326 byte） | **Netlify Function** | Yahoo Financeの週足・5年チャート情報をプロキシ |
| \`netlify.toml\`（699 byte） | Netlify設定 | 絶対Windowsパスを記述しており他ホストへそのまま移植不可 |
| \`package.json\`（188 byte） | Node ESM指定 | \`type: module\`、Node>=18。Portfolio ManagerのテストはCommonJSなので同居時のモジュール境界に注意 |
| \`deploy.bat\` | 旧デプロイスクリプト | 移行後不要。旧設定は削除実施まで保存する |
| \`_batch_analyze.ps1\` | ローカル分析補助 | 約50銘柄の旧サイトAPI一括照会。統合アプリの公開機能とは分離 |
| \`_batch_results.csv\` | 旧分析結果のスナップショット | 作成日時・元データと同期する保証がない。売買判断用の最新データとして利用しない |

注：これらはユーザー提供の配信物・スクリプトの監査結果であり、Netlifyコンソールの非公開設定・環境変数・使用課金プランまでは検証していない。

## 機能比較

| 機能 | Portfolio Manager V2.7 | Stock Analyzer | 統合時の方針 |
|---|---|---|---|
| 保有ロット・円ドル現金・特定口座 | あり | 保有ロットなし | Portfolio Managerを正本に固定 |
| 目標配分・税引後売買・PLTR 30%下限 | あり | なし | 既存計算エンジンは変更しない |
| 動的50/80/100%ピラミッディング | あり | なし | 回帰テストを維持 |
| 企業評価／投資仮説／手入力の業績指標 | あり | SECから多数の指標を自動分析 | 既存の投資仮説を保持して自動指標を追加 |
| 市場データ | Finnhub株価、USDJPY | Yahoo Finance株価・アナリスト・チャート | 出所・最終更新日時・用途を統一。勝手に置き換えない |
| Rule of 40、営業レバレッジ、原価率、10年後EPS×PER | 専用自動分析は未実装 | あり | 計算式の検証を前提に移植 |
| 銘柄スクリーニング | ウォッチリストと市場監視が中心 | 一括スキャン、シグナルランキング・フェーズ判定 | SECバッチバックエンド移転後に移植 |
| ウォッチリスト | \`state.watchlist\` | \`localStorage.masyaWatchlist\` | 重複排除付きインポート＋差分承認。初期値は自動上書きしない |
| 投資指標ライブラリ | なし | 独立した静的ページ | **\`research/library.html\` に完全移植** |
| ブラウザー保存・バックアップ | \`pm_workspace_v3\`、JSON | \`masya_v2_{ticker}\`、\`masyaWatchlist\`、6時間キャッシュ | 別オリジンのためユーザーによるエクスポート／インポートが必要 |

## 非互換事項・データ品質上の留意点

1. **Netlify FunctionsはGitHub Pagesで実行できない。** メインHTMLが叩く \`/.netlify/functions/analyze\`／\`screener\`／\`chart\` は新ホストに存在しない。これを絶対URLで旧Netlifyへ向けて回避しても、Netlifyの削除目的を達成しない。
2. SEC EDGARの \`data.sec.gov\`、Yahoo Financeの非公開／未保証のAPIはアクセス制限、CORS、レート制限、仕様変更などでブラウザーから直接安定利用できる保証がない。**Proxy／サーバー側取得とキャッシュが必要**。
3. \`analyze.js\` と \`screener.js\` の \`User-Agent\` は \`contact@example.com\` というプレースホルダー。SECのアクセス方針に合わせた実運用連絡先、リクエスト制限、バックオフをサーバー側で設定すべき。公開ページに連絡先やAPIシークレットを不用意に直書きしない。
4. 財務計算ロジックのレビューが必要：XBRLの重複期間、修正提出書類、企業固有のタグ、FYとQの混合、YoY比較、単位の整合、金融業と一般事業会社の非比較性、希薄化・発行済株式数の時点差、PER仮定の感応度。
5. \`index (1).html\` の企業分析キャッシュは最大6時間。旧 \`masya_v2_{ticker}\` には取得時点の市場価格や分析結果が混在するので、旧キャッシュを最新株価と誤認しない。
6. \`netlify.toml\` は個別のWindows絶対パスを含む。Linux・GitHub Actionsへの移行時に再利用しない。
7. 現状のYahoo株価とFinnhub株価が一致しなくても、自動売買に用いる価格の正本はPortfolio Managerの既存時価取得・鮮度判定ロジックを優先する。

## 数値監査で発見した既存Stock Analyzerの要修正事項

次の3点は移植時に**そのまま再利用しない**。旧アプリの分析数値に一定の影響があるため、財務結果の実数値検収を実施する。

1. `analyze.js` の `perCalc = mktcap / opNow` は時価総額÷営業利益であり、画面コメントの **PER（時価総額÷純利益／株価÷EPS）とは一致しない**。原式を残すなら「時価総額／営業利益倍率」等として明記し、正式PERは純利益・EPSから別計算する。
2. 同ファイルの `getMarketData()` はYahooの日足 `range=5y` から `2021年` の高値を抽出する。2026年11月時点の過去5年間では2021年の初期・中盤が欠ける可能性があるため、**2021年高値の全期間を網羅した値ではない**。取得範囲と欠損を確認し、無ければ欠損表示する。
3. `screener.js` の `signalScore` は各条件へ+40/+30/+25などの点数を足し、倍率調整して100点で上限を付けた**ルールベースのスコア**。画面の「シグナル確度」「高確度」「75%」は、的中確率75%を意味しない。検証データで確率校正するまで「スコア／100点」と表示する。

これらの既存実装の修正は、Portofolio Managerの売買ロジックと分離し、元データによる一致検証と定義修正を分けて実施する。

## 移行先アーキテクチャ案

- **UI**: GitHub Pages \`portfolio_manager.html\` を母体とし、同一オリジンにリサーチ機能を配置。まず \`#research\` → \`research/library.html\` を有効化。
- **ポートフォリオ正本**: \`app/data.js\`・\`app/storage.js\`。取引・実保有・原価を勝手に分析アプリで上書きしない。
- **財務取得バックエンド**: Netlify Functionsの移転先を別途用意。候補は Cloudflare Workers／Google Cloud Run・Functions など。ただし利用可否・デプロイ権限・課金枠は未確認。GitHub Actionsで時点指定した事前計算JSONを作る構成も候補だが、任意銘柄オンデマンド分析の機能差が生じる。
- **アダプタ**: \`GET /analyze?ticker=...\`、\`POST /screener\`、\`GET /chart?ticker=...\` の契約と出力JSONを先に固定する。UIを切り替えても数値の定義を変更しない。
- **キャッシュ**: 金融情報に \`source\`、\`asOf\`、\`period\`、\`unit\`、\`cacheAge\` を付けて透明化。SEC XBRLと最新株価の時点を区別する。
- **保存移行**: 旧アプリのwatchlistはブラウザーエクスポートで取得し、Portofolio Manager側で差分プレビュー／個別承認する。

## Phase 1 実装（本PR）

- \`research/library.html\`：提供された \`library.html\` の全内容を実移植。旧ドメインのトップへの帰還リンクのみ \`../portfolio_manager.html#companies\` に変更。
- \`portfolio_manager.html\`：サイドバーに投資リサーチ項目、\`#research\` ワークスペース追加。
- \`app/navigation.js\`：\`research\` のhashルーティング追加。従来hashは変更しない。
- \`tests/research-integration.spec.js\`：ライブラリ導線、ページ移動、既存ブラウザー保存データ非破壊、PC/スマホ画面の最低限のテストを追加。
- **この段階では旧NetlifyのAPI URLを移行先に埋め込まない。** 旧サイトを停止すると動かなくなるものを新しく増やさない。

## 次のPRの移植順序

1. API契約・財務XBRL計算のテスト固定（実SECデータに依存しないフィクスチャ）。
2. Netlify Functionsの非Netlify実行アダプタ、キャッシュ・制限・エラーハンドリングの設計と実装。
3. 一銘柄のSEC分析画面を移植。既存保有銘柄から選択、比較、出所表示、失敗時の保護。
4. 週足チャート、セクタースクリーナー、独立バッチスクリーナーを移植。
5. 旧watchlistのエクスポート・差分インポート（異なるブラウザー・オリジン）。
6. 数値・保存・PCスマホの全機能回帰検収。

## 旧新並行検収のゲート

- [ ] 元画面と同じ個別銘柄PLTR/APP/NVDAの結果をテスト日付つきで比較
- [ ] SEC XBRLの売上、営業利益、EPS、Rule of 40、増減率を公式10-Q/10-Kで照合
- [ ] バッチ10銘柄・API失敗・429/タイムアウト・欠損値の試験
- [ ] 週足5年チャート・出来高・調整後終値・日付の整合
- [ ] APIキー・ポリシー・キャッシュ・費用・レート制限確認
- [ ] Portfolio Managerの保有・税引後売買・動的50/80/100%買付・PLTR30%下限の回帰テスト
- [ ] 別PC/ブラウザーで旧ローカルデータをエクスポート・差分復元
- [ ] 旧Netlifyに依存するリクエストがすべてゼロ
- [ ] バックアップから元ソース・個人データを復元できる

## Netlify停止・削除（未実施）

上記ゲートを満たした後に、旧サイトの新規デプロイ停止→旧URLの案内→機能検収→最終承認後の削除を行う。データ・利用状況・シークレット・独自ドメイン・課金の確認前に削除しない。
