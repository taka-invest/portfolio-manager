# Firebase移行 進捗記録（MIGRATION_PROGRESS）

次のセッションはまずこのファイルと`docs/MIGRATION_AUDIT.md`を読むこと。

- Firebaseプロジェクト: Finance Base `finance-base-edcc7`（Sparkプラン、2026-11-23時点）
- 作業ブランチ: 新しい作業ごとに`main`から作成。PR #16（基盤）・PR #18（Phase 2-3）はmainへsquashマージ済み
- 旧サイト（移行完了まで維持）: GitHub Pages `portfolio_manager.html`／Netlify `masya-stock-analyzer`
- Stock Analyzer最新ソース: `C:\Users\defaultuser0\Documents\masya_app\`（git管理外。読み取り専用で参照）

## フェーズ状況

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 監査 | ✅ 完了（2026-11-23）`docs/MIGRATION_AUDIT.md` |
| 1 | Firebase初期構築・認証・Firestore・同期 | 🟢 保存・別ブラウザー復元を実機確認。Hostingプレビュー未実施 |
| 2 | Functions移行（analyze/screener/chart） | 🟢 修正版の財務計算・スコア・株価推定。Functions 5本を東京に本番デプロイ済（2026-11-24） |
| 3 | 画面統合 | 🟢 10項目ナビ・個別企業分析・スクリーナー・チャート・市場データ自前API・最新ライブラリ（本番公開済） |
| 4 | 既存機能保護（リバランス・ピラミッディング） | 🟡 既存テストで保護中。弾(A/B/C)の同期が未対応 |
| 5 | セキュリティ・費用 | 🟡 Blaze化済（2026-11-24 オーナー操作）。予算アラートの設定確認待ち |
| 6 | CI/CD | 🟡 プレビュー/本番ワークフローと承認ゲート作成済。デプロイ用SA（本人操作）待ち |
| 7 | 総合検証 | 🟡 自動検証は完了（`docs/VERIFICATION_PHASE7.md`）。オーナーの実機確認4項目が残り |
| 8 | 本番切替 | 🟡 統合版を本番公開（2026-11-24、PER/PSR追加版も反映済）。旧サイトは維持。停止は最終工程で要承認 |

## 2026-11-23 セッション1 の実施内容

1. リポジトリをクローンし、PR #16を監査（`docs/MIGRATION_AUDIT.md`）。
2. **Firestoreルールを許可UID方式に変更**: `/allowlist/{uid}`（`enabled: true`）に登録されたGoogleアカウントだけが、自分の`users/{uid}/...`を読み書きできる。allowlist自体はクライアントから書込・一覧不可。
3. 上書き前のクラウド側バックアップ`users/{uid}/backups/{id}`（追記専用・削除不可）を追加。
4. **ルールのEmulatorテスト12件**（`tests/emulator/firestore-rules.test.mjs`、`npm run test:rules`）。demo-プロジェクトなので実Firebaseに触れない。
5. 同期クライアント（`app/firebase-cloud.mjs`）を8手順に補強: 自動JSONバックアップ、保存状態の検査、サーバー再読込、差分表示、明示的な採用選択、サーバー側バックアップ、リビジョン照合トランザクション、保存後の一致照合。ログイン時にUIDと許可状態を表示。
6. Functions: 許可UID判定（Firestore allowlist、60秒キャッシュ）、`verifyIdToken(…, checkRevoked=true)`、個人データを含まない構造化ログ（API名・ステータス・処理時間・エラー分類）を追加（`functions/src/auth.js`）。chartはSEC連絡先未設定でも停止しないよう分離。
7. CIにJava 21＋Firestoreルールテストを追加。

## テスト結果（2026-11-23、ローカル Windows）

| テスト | 結果 |
|---|---|
| `npm test`（node:test） | 60/60 成功 |
| `npm run test:rules`（Firestore Emulator） | 12/12 成功 |
| `npx playwright test --workers=1` | 26成功・12スキップ（端末別）・0失敗 |

注: Windowsローカルでは並列実行時に`python3 -m http.server`が接続拒否を起こすことがある（CI=Linuxでは発生しない）。EmulatorはWindowsで`JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/Users/<user>/.uds`が必要な場合がある。

## Firebase実環境の状態（2026-11-23 確認、CLIはFinance Baseのオーナーである本人の個人Googleアカウント）

- Firebase CLI: このディレクトリは`firebase login:use <個人アカウント>`で本人の個人アカウントに固定（会社アカウントは別プロジェクト用）
- Webアプリ: 「Finance Base Web」`1:472264087274:web:af5ac46e3e19c34f466993` 登録済み → `app/firebase-config.js`に実値を反映
- Hosting: サイト`finance-base-edcc7`（https://finance-base-edcc7.web.app）存在。未デプロイ
- Firestore: ✅ 2026-11-23 ユーザー承認のうえ作成。`(default)`／Native／Standard／**asia-northeast1**。`firestore.rules`をデプロイ済み
  - 実機確認: 未認証の読み取り（users/allowlist/任意パス）と未認証のallowlist書き込みはすべてHTTP 403
  - 削除保護: ✅ 有効（2026-11-23 ユーザー承認）
- Authentication: ✅ Googleプロバイダー有効（ユーザーがConsoleで設定）
- 許可UID: ✅ 本人（Googleログイン、2026-11-23）を`allowlist`に登録。登録・無効化は`node scripts/allowlist-uid.mjs <uid> [--disable]`（CLIログイン必須、Auth上のGoogleユーザーであることを検証してから書込）
- gcloud: 個人アカウント未ログイン（予算アラート設定時に必要）
- ローカル確認: SDKが実プロジェクトに接続し「未ログイン」表示、コンソールエラーなし

## 実機検証（本番Firestore、localhost:4173、2026-11-23）

| 項目 | 結果 |
|---|---|
| 許可UID前のログイン | 「まだ許可されていません」と表示、保存ボタン無効 ✅ |
| 未認証REST（読取・allowlist書込） | すべて403 ✅ |
| 初回保存（Chrome通常、22ロット） | 自動JSONバックアップ→保存→再読込照合一致、リビジョン1（11:27:01 JST） ✅ サーバー側でも確認 |
| 別ブラウザー復元（Chromeシークレット＝別PC相当、0件から） | 差分「保有ロット 0 → 22 件」表示→承認で22件復元 ✅ |
| 同時更新の競合検知 | Emulatorテストで検証済。本番では余計なリビジョンを作らないため未実施 |

気付いた点:
- 取込後も同期欄の表示が「差分確認ダイアログを開きました」のまま（承認後の文言更新が必要）
- 自動バックアップのファイル名が旧名`portfolio-manager-v2.3.json`（日付入りに変更予定）
- 取込データは参考データのため全22ロットが「口座未確認」、現金0。`MOD`は原価¥0（要確認）

## CI/CD（2026-11-23 セッション1後半）

- プレビューチャネル`preview`へCLIから手動デプロイ: https://finance-base-edcc7--preview-es1ecisz.web.app （30日失効）。ソース類（rules/package.json）は404、本番URLは未公開(404)のまま。チャネルドメインはAuthの承認済みドメインに自動登録されていた（`scripts/auth-domains.mjs`で確認）
- `verify.yml`に`preview`ジョブ（テスト成功後・同一リポジトリのみ・固定チャネル）
- `firebase-production.yml`: 手動実行＋`DEPLOY`入力＋`main`限定＋GitHub環境`production`（必須レビュアー taka-invest、`main`ブランチのみ）
- 手順・ロールバック: `docs/DEPLOYMENT.md`
- デプロイ用サービスアカウント作成はClaude Codeの安全設定でブロック → 本人が`firebase init hosting:github`で作成する
- 同期UX修正: クラウド取込承認後の表示、バックアップファイル名を`portfolio-manager-backup-YYYYMMDDHHmm.json`に

## 本番公開（Portfolio Managerのみ）2026-11-23 12:00頃 JST

- ユーザーの明示的承認（「本番公開してよい」）を受けてCLIから`firebase deploy --only hosting`
- デプロイ元: `feature/firebase-foundation-phase1` @ `9cb5954`（PR #16は未マージ。マージ後は本番ワークフロー経由に移行）
- 事前テスト: 単体62／ルール12／Playwright 26成功・12スキップ
- 本番 https://finance-base-edcc7.web.app : アプリ・app/*・research/library.html は200、firestore.rules / firebase.json / package.json / functions / tests / .github / docs / .firebaserc は404。X-Frame-Options DENY・nosniff・HTMLはno-store
- 画面: SDKが接続し「未ログイン」表示。コンソールエラーは既存の第三者CORSプロキシ（allorigins等、Fear&Greed取得）由来のみ → Phase 2で自前Functionsに置換
- **本番実機確認（ユーザー、11:53 JST）**: 本番URLでGoogleログイン→許可UIDでFirestore読込→差分「0 → 22件」→承認→保有資産に22件表示 ✅
- ロールバック: Console → Hosting → リリース履歴、または`docs/DEPLOYMENT.md`
- GitHub Pages / Netlify は維持（停止は最終工程で別途承認）

## Phase 2 進捗（2026-11-24 セッション2）

- 引継ぎ先は変更なし（オーナー判断で引き続きClaudeが担当）。リモートの`bed63ce`（USD/JPY手入力フォールバック、オーナーpush）を取込。段階買付のA/B/C・PLTR30%ロジックは不変であることを確認
- **最新版Stock Analyzerを移植**（`Documents\masya_app
etlifyunctions` 2026-09-17版）→ `functions/src/legacy/`: analyze / screener / chart / sec-8k-guidance。全上流通信を`sec-gateway.js`経由に置換（`contact@example.com`直書きを除去）。`eps-revisions.js`（Finvizスクレイピング）は参照用に保存し**非公開**
- スクリーナーのnullクラッシュ（opMargin等の`toFixed`）を`Number.isFinite`判定で修正
- `sec-gateway.js`強化: 429/502/503でRetry-After尊重＋指数バックオフ（最大2回）、LRU上限40件、`getText`（SEC HTML）、Yahooは旧版同等のブラウザUA（旧アプリとの数値比較用。代替データ源の検討は継続）
- **修正版財務層** `functions/src/sec/financials.js`: 期間単位の重複除去（最新提出優先＝修正報告・後年比較表示を反映）、YTD差分による四半期導出（Q4＝通期−9M、CF四半期）、9M欠損時はQ4＝FY−(Q1+Q2+Q3)、期末日一致のYoY/TTM、FCF＝営業CF−設備投資、希薄化後EPS（差分導出しない）、Rule of 40（TTM成長＋TTM FCFマージン）と旧定義の併記、営業レバレッジ（TTM）、成長加速度。欠損はnull
- `functions/src/sec/company.js` ＋ `financialsApi`（認証ゲート経由）。応答に出典URL・取得時刻・通貨・`status: verification-pending`
- テスト: 単体74件成功（合成companyfactsで手計算値と照合、旧エンジンの位置ずれ欠陥の再現、ゲートウェイのリトライ/UA/LRU、移植コードの直接通信禁止）

### SEC実データ検証（2026-11-24）
- SEC連絡先はオーナー承認のもと個人メールを使用。`functions/.env`（gitignore）にのみ保存し、リポジトリには書かない
- `scripts/fetch-sec-fixtures.mjs`でPLTR/APP/NVDAのcompanyfactsを取得し、使用タグだけに絞った版を`tests/fixtures/sec/`に保存（SECの公開データ）
- 結果は`docs/FINANCIAL_VERIFICATION.md`。元データ（四半期の売上・営業利益率）は旧版と全件一致。差異は旧版の欠陥のみ（前年比の比較相手が15か月前にずれる：PLTR 130.5%→95.9%、NVDA 118.4%→105.9%。通期の重複：APPの前年比16.4%→70.0%）
- 実データで見つかった問題を修正：TTMのEPSが常に欠損になる（会計年度末は通期EPS、Q4は近似値として算出）、NVDA 2010年の期末日1日違いの重複
- APPは2025年以降、設備投資をXBRLで開示していない → FCFは欠損のまま（0にしない）
- テスト：単体80件成功（実データのフィクスチャテスト6件を含む）

### スコア・株価推定の載せ替えと結合テスト（2026-11-24）
- `functions/src/sec/scoring.js`：マシャ式（原価率5段階・総合スコア・投資判断・撤退シグナル・10年後3価格）を修正版のデータに載せ替え。配点・閾値は不変。欠損は0扱いせず`missing`に列挙。赤字企業には目標利益率を当てはめない。希薄化版の株価を併記。修正再表示がある企業は同じ基準の期間でCAGRを計算。前提と警告を出力
- `financials.js`：原価率（四半期・TTM）、四半期の営業レバレッジ、TTM営業利益率、自己資本・現金・長期債務（直近の値）、表紙の発行済株式数、希薄化後株数の推移、修正再表示の検出
- `company.js`：`financialsApi`の応答に`evaluation`と`quote`（Yahoo v8、出典・時刻付き。取れなければnull）を追加
- ゲートウェイ：一時的なネットワーク障害（DNS EAI_AGAIN等）も再試行するよう修正（実通信で発生したため）
- 認証ゲート：署名なしトークンはFunctions Emulator内でだけ受け付ける（本番は署名必須のまま。テスト済み）
- **Emulator結合テスト**（`npm run test:api`、auth+firestore+functions）：トークンなし・不正→401、許可リスト外のGoogleユーザー→3つのAPIすべてで403、Google以外のログイン→403、許可ユーザー→不正入力400・PLTRは200（SECの実データ・出典付き）。CIでは連絡先がないため503になるのを正しい動作として検証。構造化ログにUID・保有情報が出ないことも確認
- `functions/package-lock.json`を追加。CI（verify・production）に`test:api`を追加
- テスト：単体88件・ルール12件・API結合4件すべて成功

### 次（Phase 2残り）
1. ~~SEC実データ照合~~ ✅ ／ ~~旧版との差分表~~ ✅（`docs/FINANCIAL_VERIFICATION.md`）
3. ~~Emulator結合テスト~~ ✅ ／ ~~スコア・株価推定の載せ替え~~ ✅
4. Cloud Functionsの本番デプロイ（**Blazeプランへの変更と予算アラートの承認が必要**）
5. Phase 3：画面統合（個別企業分析・スクリーナー・チャート画面をPortfolio Managerに組み込む）

## Phase 3 着手（2026-11-24）：個別企業分析画面
- サイドバーに「個別企業分析」（`#analysis`）を追加。`app/analysis.js`は読み取り専用で、保有株数・現金・計画・取引は変更しない
- 銘柄の候補は、保有・目標配分・ウォッチリスト・企業評価の銘柄を一元化して表示（画面ごとに別管理しない）
- `/api/financials`をIDトークン付きで呼ぶ。状態を区別して表示：未ログイン／許可なし(403)／API未公開（Hostingの404ページ＝Functions未デプロイ）／SEC連絡先未設定(503)／上流の失敗(5xx)／通信エラー
- 表示：検証中バナー（売買判断に使わない旨）、スコア・判定・撤退シグナル、TTM指標、四半期8期（算出したQ4に「※算出」）、10年後モデル（前提は日本語ラベル・警告付き）、判定の内訳、指標の定義、出典（SECのURL・取得時刻・株価の取得元）。外部の文字列はすべてエスケープ
- **本番の`firebase.json`には`/api`の転送を入れない**（Functions未デプロイのままHostingを更新しても壊れないように）。Emulator専用の`firebase.emulator.json`に`/api/*`の転送を記載。`npm run dev:emulators`でHosting:5000＋Auth＋Firestore＋Functions（demoプロジェクト）が起動し、クライアントは:5000のときだけEmulatorに接続
- Functions：上流の失敗をエラー種別・コード・上流ステータスだけでログ出力（URL・UID・保有は出さない）
- テスト：Playwright（PC・スマホ）に5ケース（候補の一元化、未ログイン、API未公開、403/503、PLTRの実データ表示・XSSエスケープ・ポートフォリオ不変・横スクロールなし）。単体89件・ブラウザー36件成功
- CI修正：SEC連絡先がないCI環境で、不正な入力にも503を返していた → 入力の検証を連絡先チェックより先に実行（連絡先あり・なしの両方でAPI結合テスト4件成功、PR #18のCI成功）
- **Emulatorでの通し確認**：Hosting `/api/financials` → Functions（認証・許可UID）→ SEC実データ → 画面に表示（NVDA：スコア75・強い買い・継続保有、四半期8期、出典表示）。ブラウザーペインではGoogleログインのポップアップが開かないため、Emulatorで発行したGoogleユーザーのIDトークンで代替した（本番のポップアップログインは確認済み）

## Phase 3：銘柄スクリーナー・株価チャート（2026-11-24）
- `functions/src/sec/screen.js`：旧スクリーナーの参入シグナル（赤字→黒字+40、RoF40 40/60/80突破+30/+25/+30、営業利益率+5pt以上+20、成長加速+10pt以上+15、新高値×1.5、連続×0.25）とフェーズ判定（phase1/2/3/金融）を**そのまま**修正版データに適用。旧版は前四半期が欠損でも「転換」シグナルを出していた → 欠損時は出さない。行ごとにマシャ点・撤退シグナル・株価を付与。銘柄ごとの失敗は他銘柄に波及しない
- `functions/src/sec/chart.js`：Yahoo chart（非公式）の終値を正規化（調整後終値を優先、欠損点は除外、期間1y/5y/10yのみ許可）。出典・取得時刻・調整有無を返す
- `screenerApi`（POST、10銘柄まで、`{mode:'getpool'}`で旧候補プール）・`chartApi`（GET ticker・range）を修正版に切替（旧`legacy/screener.js`・`chart.js`のハンドラーは使わない）
- 画面：`#screener`（入力検証・保有/目標/ウォッチリストから自動入力・列ソート・行クリックで個別企業分析へ・CSV）、`#chart`（アクセシブルなインラインSVG。表示幅で描画しスマホでも文字が読める）。共通のAPI呼び出し・エラー分類・銘柄の一元化を`app/api.js`に集約
- テスト：単体95件、ブラウザー42件成功・12件スキップ（PC・スマホ）、API結合5件（スクリーナー・チャートの入力制限を追加）
- **Emulatorでの通し確認（実データ）**：スクリーナー PLTR/NVDA/APP/AVGO/CRDO → 全行表示（例：PLTR 前年比95.9%・フェーズ3・85点）。チャート NVDA 5年週足262点。CRDOは撤退ルールにより「撤退検討」（前年比4期連続減速 273%→115%、営業利益率 36.8%→25.2%、RoF40 238→140）。高成長からの減速でも発火する旧ルールどおりの結果

## Phase 3 仕上げ（2026-11-24）
- **サイドバーを10項目構成に**：PORTFOLIO（ダッシュボード／ポートフォリオ／売買・リバランス）・RESEARCH（個別企業分析／投資仮説・企業評価／銘柄スクリーナー／市場分析／株価チャート／投資指標ライブラリ）・RECORDS（取引履歴・投資ジャーナル）＋設定・データ管理。既存の「企業評価」（投資仮説・シナリオ）は削除せず「投資仮説・企業評価」として残した。投資リサーチ画面の古い注意書き（分析画面は公開しない）を新画面へのリンクに更新
- **市場データの自前API化**：`/api/market`（`functions/src/sec/market.js`）でVIX・VXN・^GSPC・テクニカル用の株価・CNN Fear & Greedをサーバー側で取得（記号・期間の許可リスト、Yahoo互換の最小形に整形、出典付き）。画面は`app/market-data.js`経由で**自前API優先**。Functions未公開の間だけ旧中継（allorigins/corsproxy/codetabs）にフォールバックし、画面に「第三者の中継サービス経由」と表示。**保有銘柄のテクニカル取得は未ログイン時に中継へ送らない**。なお`fetchAllTechnicals`はどこからも呼ばれていない（既存の未使用コード）
- ログイン状態の復元待ち：`PMCloud.idToken`は`auth.authStateReady()`後にトークンを返し、`PMCloudReady`でページ読込直後のAPI呼び出しも待つ（以前は読込直後に「未ログイン」と判定されていた）。`firebase-cloud.mjs`は同期パネルのないページ（ライブラリ）でも`PMCloud`を提供
- **投資指標ライブラリを最新版（84KB）に差し替え**：殿堂入りシグナル検証とT1レーダーの旧Netlify呼び出しを、`/api/financials`（修正版四半期→旧項目名に変換）と`/api/market`（月次10年）に置換。Functionsの同時実行数1に合わせて順番に呼ぶ。戻るリンクをPortfolio Managerへ
- テスト：単体97件、ブラウザー50件成功・12件スキップ（市場データ3件・ライブラリ1件を追加）、API結合5件
- **Emulatorで実データ確認**：市場分析 VIX 26.6／VXN 36.3／Fear & Greed 17（Extreme Fear）を自前API経由で表示、ライブラリの殿堂入り検証 NVDA・PLTR（T1/T3シグナルとその後リターン）。途中でローカルDNSの一時障害（EAI_AGAIN）が出たが、分類ログで原因を特定でき、再実行で成功

## Cloud Functions 本番デプロイ（2026-11-24、オーナー承認済）
- オーナーがBlazeプランに変更。課金有効を確認（予算アラートはAPIで読めず、画面での確認待ち）
- `firebase deploy --only functions`（ブランチ`feature/phase2-stock-analyzer`の`ecd05aa`）：analyzeApi / financialsApi / screenerApi / chartApi / marketApi を **asia-northeast1** に作成。Node.js 22、第2世代
- 本番の設定を読み取りで確認：全関数 最大インスタンス1・同時実行1・512MiB・1vCPU・タイムアウト180秒・最小インスタンス0。環境変数`SEC_USER_AGENT`は設定済み（値はリポジトリに含めない）
- コンテナイメージの自動削除ポリシー：3日（Artifact Registry `gcf-artifacts`、asia-northeast1）
- 本番での拒否確認：トークンなし・不正トークン・署名なし（Emulator形式）トークンはすべて401。CORSヘッダーなし、`Cache-Control: private, no-store`。Cloud Loggingには`api/status/durationMs/errorClass`のみ記録（UID・トークン・保有なし）
- 本番の`firebase.json`に`/api/*`→各関数（東京）の転送を追加（**Hostingへの反映は未実施**。PR #18のマージと本番公開の承認後）

## 本番公開 Phase 2-3（2026-11-24、オーナー承認「公開してよい」）
- PR #18をmainへsquashマージ（`410012d`）。mainの内容は検証済みブランチ`1172d5b`と同一
- mainで全テスト：単体97／ルール12／API結合5／ブラウザー50成功・12スキップ
- `firebase deploy --only hosting`（main `410012d`）
- 本番確認：app/*・research/library.html は200、firebase.json・firestore.rules・functions・tests・docs・`functions/.env`は404。`/api/financials|chart|market|analyze|screener`は同一オリジンの転送でFunctionsに届き、未ログインは401。画面：サイドバー10項目・新画面のモジュール読込・Firebase接続OK、コンソールエラー0件
- **オーナーの本番実機確認（2026-11-24）**：本番URLでGoogleログイン→個別企業分析（NVDA）が表示されることを確認 ✅
- 残り：予算アラートの設定確認、Phase 7 総合検証、Phase 8 旧サイト停止（要承認）
- ロールバック：Console → Hosting → リリース履歴（直前版は`9cb5954`相当のPortfolio Managerのみの版）

## 本番反映 Phase 7（2026-11-24、オーナー承認「反映してよい」）
- PR #20をmainへsquashマージ（`0531f60`）。mainで単体98／ルール12／API結合5／ブラウザー54成功・12スキップ
- Functions 5本を再デプロイ（`--force`、上限設定は不変を確認：最大1・同時1・512MiB・180秒）→ Hosting公開
- 本番スモーク 42/42 合格。本番の`app/analysis.js`にPER/PSR表示を確認
- **オーナーの本番実機確認**：個別企業分析にPER（TTM）・PSR（TTM）が表示されることを確認 ✅

## Phase 8 着手と画面の見直し（2026-11-24）
- オーナー確認：本番でログアウトできた ✅
- 依存調査：公開ファイル・Functionsに`netlify`/`github.io`への参照なし。GitHub Pagesはmainのルートを公開（mainにマージすると旧URLも更新される）。Netlifyは`Documents\masya_app`の`deploy.bat`でデプロイ、CLIログイン済み
- **旧URL（taka-invest.github.io）での移行案内**：`app/legacy-notice.js`。自動転送はしない（旧URLのブラウザー保存データをJSONで書き出す必要があるため）。テスト（Playwrightで旧ホストを再現）あり
- **Netlify用の移行案内**：`Documents\masya_app_cutover`（`masya_app`のコピー、元フォルダーは不変）に案内バーと「ウォッチリストをコピー」ボタンを追加。**デプロイは保留**（新画面にオーナーが納得してから）
- **オーナーの要望により画面を見直し**：旧Stock Analyzerの紺のダークテーマと、チャートタブの見やすさを再現
  - ダークテーマを紺系（#1a1a2e → #16213e → #0f3460 のグラデーション、アクセント #6366f1）に変更
  - 個別企業分析を「ヘッダーカード（銘柄・最新10-Q・Phase・株価・時価総額・判定）＋ サマリー／チャート／投資判断／財務諸表」の4タブに
  - チャートタブ：TradingView Lightweight Charts 4.2.0（必要時にunpkgから読込、読めなければ簡易SVG）で週足ローソク足・出来高・MA9週・SECシグナルのマーカー ＋ 12四半期トレンド表（YoY加速↑↓・QoQ・原価率・OpM(ΔQoQ)・YoY変化・OpLev・RoF40旧定義・R40 TTM・営業利益・EPS(Δ)・Score）とスパークライン
  - API追加：四半期の提出日・様式、四半期ごとのシグナル点、フェーズ、株価のOHLC・出来高、通期の自社株買い・株式発行
  - CSSとmjsにも`Cache-Control: no-cache`（古いCSSが残って画面が崩れる問題をEmulatorで発見）。本番スモークに検査を追加
- テスト：単体100件、API結合5件、ブラウザー60件成功・12スキップ。Emulatorで実データ（NVDA週足262本）を表示確認

## 本番反映 画面の見直し（2026-11-24、オーナー承認「反映してよい」）
- PR #21をmainへsquashマージ（`a3907b7`）。mainで単体100／ルール12／API結合5／ブラウザー60成功・12スキップ（API結合で1回、実SEC通信のケースがローカルDNS障害で失敗→再実行で成功。テストに1回再試行を追加）
- Functions 5本再デプロイ（上限設定は不変を確認）→ Hosting公開
- 本番スモーク 45/45（CSS/JS/MJSのキャッシュ制御を含む）。本番に紺テーマと新しい分析画面が配信されていることを確認
- GitHub Pagesもmain `a3907b7`で再構築され、旧URLに移行案内（新URLへのリンク）が表示されることを確認
- Netlifyの移行案内（`Documents\masya_app_cutover`）は未デプロイ。オーナーが新画面に納得した後に、Phase 8の最終工程として承認を得て実施

## 旧Stock Analyzer画面の無改変移植（2026-11-24、オーナー要望）
- オーナー判断：「画面は旧版、数値は修正版」。Phase 3で作り直した分析・スクリーナー画面（`app/analysis.js`・`app/screener.js`）は廃止
- `research/index.html`・`research/screener.html`：`Documents\masya_app`の旧ページを**そのまま**移植。差分は、先頭に3行の読込（firebase-config・legacy-shim・firebase-cloud）と、Netlify前提のルートリンク4か所の相対化のみ（diffで10行）
- `app/legacy-shim.js`：旧ページの`/.netlify/functions/*`呼び出しを、ログイン付きの自前APIへ振り替え（analyze→/api/analyze、chart→/api/market 週足5年OHLCV、screener→/api/screener を旧項目名に変換、eps-revisions・8-Kは「データなし」）。未ログイン時はバナー表示
- **旧エンジン（`functions/src/legacy/analyze.js`）は出力の形をそのまま**、データ抽出部分だけを`functions/src/sec/legacy-adapter.js`（修正版：第4四半期補完・最新提出優先・期末日照合のYoY/QoQ・通期の重複除去）に置換。シグナル・スコア・評価の旧ロジックは不変。明示的な修正は2点（成長率欠損を0%扱いしない、2021年高値のため株価履歴を10年に）
- 実データ比較（旧Netlify→移植版）：前年比 PLTR 130.5→95.9%、NVDA 118.4→105.9%、APP 73.6→55.5%、APP通期成長率 16.4→70.0%、PLTRの2021年高値 21.4→45ドル
- Portfolio Managerの「個別企業分析」「銘柄スクリーナー」は、移植した旧ページを埋め込み（ルートを開いたときに読込、新しいタブでも開ける）
- Emulatorのポートを TripCraft と重ならない番号に変更（hosting 5100 / functions 5101 / firestore 8180・ws 9250 / auth 9199 / hub 4410 / logging 4510）。**この作業中、ポートが重なっていたためTripCraftのEmulatorにテスト用ユーザー1件と許可リスト1件を誤って書き込んだ**（メモリー上のみ・その後Emulatorは停止済みで残存なし）
- テスト：単体102・ルール12・API結合5・ブラウザー54成功（旧画面の振り替え・ログイン要求・埋め込みを追加）。Emulator実データでNVDAの旧画面（チャートタブ）を確認

## 本番反映 旧画面の移植（2026-11-24、オーナー承認「反映してよい」）
- PR #23をmainへマージ（`0d74171`）。mainで単体102／ルール12／API結合5／ブラウザー54成功・12スキップ
- Functions 5本再デプロイ（`--force`、上限設定は不変を確認：最大1・同時1・512MiB・180秒）→ Hosting公開
- 本番スモーク 46/46 合格。本番の`research/index.html`に`legacy-shim.js`、`portfolio_manager.html`に`pm-legacy-frame`が配信されていることを確認
- **オーナーの本番実機確認**：未（個別企業分析・銘柄スクリーナーが旧Netlify画面と同じ見た目か）

## ユーザー対応待ち（ブロッカー）

1. ~~CLI再認証~~ ✅ ／ ~~Webアプリ構成値~~ ✅
2. ~~Firestore作成~~ ✅ ／ ~~Google認証~~ ✅
2b. `firebase init hosting:github`（デプロイ用SA＋GitHub Secret）は**保留**。GitHub認可で会社用アカウントが選ばれやすいため、承認URLは最初からtaka-investでログインしたシークレットウィンドウで開くこと。1回目は反映遅れで失敗し、未使用SA `github-action-1261182527@` が残存（鍵なし、後で削除）
3. ~~本人UIDの登録~~ ✅（画面表示のUIDは l/I の判別が難しいため、`firebase auth:export`で正確な値を確認してから登録した）
4. **SEC_USER_AGENT**: 実際の運用連絡先（例:「FinanceBase 氏名 連絡先メール」）の指定。
5. ~~Blazeプランへの変更~~ ✅ ／ **予算アラート（推奨 月1,000円・50/90/100%通知）の設定確認**

## 未解決事項

- 段階買付の現在の弾（`pm-staged-funding-stage`）が主ステート外 → 別PCで不一致になる。
- `validate()`が未知キーを捨てる → スキーマ拡張時にバージョンを上げる運用が必要。
- CRDOは通常リバランスでは`wait=true`だが段階買付では購入対象（仕様どおりか要確認）。
- Yahoo v7/v10はcrumb必須。代替データ源の比較が必要（Phase 2）。
- `eps-revisions.js`（Finvizスクレイピング）の移植可否（利用条件）。

## 次の作業

0. （本人）本番URLで証券口座と照合しロット・現金・MOD原価を修正 →「実保有・現金を確認」→ クラウド保存（リビジョン2、リビジョン1は自動でクラウドバックアップ）

1. （再認証後）Firebase側の現状確認 → Webアプリ構成値の反映 → `.firebaserc`。
2. Hostingプレビューチャネル用のGitHub Actions（PR時、手動承認なしで本番に出ない構成）。
3. Phase 2: `masya_app`最新版の`analyze.js`/`screener.js`/`eps-revisions.js`/`sec-8k-guidance.js`を取込 → Q4合成・年次重複除去・FCF・欠損の扱いを修正し、SEC公式値のフィクスチャテストを作成。
