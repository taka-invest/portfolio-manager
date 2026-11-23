# 引き継ぎ報告書：Portfolio Manager × Stock Analyzer Firebase統合

作成: 2026-11-23（Claude Code → 後任AIエージェント）
対象ブランチ: `feature/firebase-foundation-phase1`（PR #16、未マージ） 最新コミットは `git log -1` で確認

> 後任の方へ：作業を始める前に、本書 → `docs/MIGRATION_PROGRESS.md`（詳細ログ）→ `docs/MIGRATION_AUDIT.md`（監査結果）→ `docs/DEPLOYMENT.md`（デプロイ手順）の順に読んでください。

---

## 1. プロジェクトの目的とルール

既存の **Portfolio Manager**（GitHub Pages、静的HTML＋localStorage）と **Stock Analyzer**（Netlify＋Netlify Functions）を統合し、**Firebaseを唯一の本番基盤**にする。GitHubはソース・PR・自動テスト・デプロイ管理に使う。

### 必ず守ること（オーナーの指示）
- 作業用ブランチで開発し、機能単位で変更・テスト・コミットする。
- **オーナーの明示的承認が必要な操作**：本番公開、Blazeプランへの変更・課金の発生、Firebaseプロジェクトの設定変更、データを破壊する可能性のある操作、旧サービス（Netlify / GitHub Pages）の停止・削除。承認は1回ごと（前回の承認を流用しない）。
- 既存の金融資産データを自動削除・自動初期化しない。
- APIキー・秘密鍵をコミットしない。**個人情報（メールアドレス等）を公開リポジトリに書かない**（このリポジトリはPUBLIC）。
- 個人の金融データをログに出さない。
- 欠損データをゼロとして扱わない。財務計算の精度が検証できるまで、売買判断用の正式機能として公開しない。
- リバランス仕様（§6）と動的ピラミッディング仕様は変更禁止。変更が必要なら、根拠と変更前後の計算結果を示して承認を得る。
- 完了していない項目を完了と報告しない。
- 各フェーズは「調査 → 実装 → 自動テスト → 修正 → 再テスト → コミット → 簡潔な報告」の順。進捗は`docs/MIGRATION_PROGRESS.md`に追記する。

---

## 2. 環境

| 項目 | 値 |
|---|---|
| Firebaseプロジェクト | Finance Base / `finance-base-edcc7`（**Sparkプラン**） |
| Webアプリ | 「Finance Base Web」 appId `1:472264087274:web:af5ac46e3e19c34f466993`（構成値は`app/firebase-config.js`。公開前提の識別子で秘密ではない） |
| Hosting 本番 | https://finance-base-edcc7.web.app |
| Hosting プレビュー | https://finance-base-edcc7--preview-es1ecisz.web.app （チャネル`preview`、2026-12-23失効） |
| Firestore | `(default)`、Native、Standard、**asia-northeast1**、削除保護 **有効** |
| Authentication | Googleプロバイダー有効。承認済みドメイン：localhost / firebaseapp.com / web.app / previewチャネル |
| GitHub | https://github.com/taka-invest/portfolio-manager （PUBLIC）。リポジトリ所有者アカウントは `taka-invest` |
| 旧Portfolio Manager | https://taka-invest.github.io/portfolio-manager/portfolio_manager.html （**稼働中・維持**） |
| 旧Stock Analyzer | https://masya-stock-analyzer.netlify.app/ （**稼働中・維持**） |
| Stock Analyzer最新ソース | オーナーPCの `C:\Users\defaultuser0\Documents\masya_app\`（git管理外。**PR #16の移植コードは旧版**） |
| ローカル作業コピー | `C:\Users\defaultuser0\Documents\Claude\portfolio-manager` |
| ツール | Node 24 / npm 11 / firebase-tools 15.x（devDependencyで15.37.0）/ Java 21（Emulator用）/ gh CLI |

### アカウントの注意
- オーナーは**会社用**と**個人用**のGoogleアカウント、**会社用**と**個人用**（taka-invest）のGitHubアカウントを持っている。
- **Finance Baseは個人Googleアカウントのプロジェクト。** ローカルの作業フォルダーでは`firebase login:use`で個人アカウントに固定済み。会社アカウントで操作すると権限エラーになる。
- **GitHubの書き込みはtaka-investで行う。** gh CLIの既定アクティブアカウントは会社用（このリポジトリにはREADのみ）。`GH_TOKEN=$(gh auth token --user taka-invest) gh ...` のようにコマンド単位で指定し、グローバルの切り替えはしない。
- GitHubのOAuth承認画面は、ブラウザーが会社アカウントを選びやすい。taka-investでログインしたシークレットウィンドウで承認URLを開くこと。

---

## 3. フェーズ別の状況（2026-11-23時点）

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 既存コード・環境の監査 | ✅ 完了（`docs/MIGRATION_AUDIT.md`） |
| 1 | Firebase初期構築・認証・Firestore・データ同期 | ✅ 本番で保存・復元を確認済み |
| 2 | Stock AnalyzerのCloud Functions移行 | ⬜ **未着手（次の主作業）** |
| 3 | 画面統合（ナビゲーション10項目） | ⬜ |
| 4 | 既存機能の保護 | 🟡 既存テストで保護中。段階買付の「現在の弾」の同期が未対応 |
| 5 | セキュリティ・運用費用 | 🟡 Functionsに`maxInstances:1`等を設定済み。Blaze・予算アラートは未実施（要承認） |
| 6 | GitHub Actions・デプロイ | 🟡 ワークフローと承認ゲートは作成済み。デプロイ用サービスアカウント（GitHub Secret）が**未設定** |
| 7 | 総合検証 | ⬜ |
| 8 | 本番切替 | 🟡 **Portfolio Managerのみ本番公開済み**。Stock Analyzer未移行、旧サイト維持 |

---

## 4. 実施済みの作業

### 4.1 Firebase実環境（すべてオーナー承認済み）
1. Webアプリの構成値を取得し、`app/firebase-config.js`に反映（既存アプリを使用、新規作成なし）。
2. Firestoreを東京リージョンで作成し、`firestore.rules`をデプロイ。
3. Firestoreの削除保護を有効化。
4. Googleプロバイダーを有効化（オーナーがConsoleで実施）。
5. オーナーのUIDを`/allowlist/{uid}`に登録（`scripts/allowlist-uid.mjs`）。
6. Hostingのプレビューチャネル`preview`へデプロイ。
7. **Hosting本番へデプロイ**（`firebase deploy --only hosting`、コミット9cb5954の内容）。オーナーが本番URLでログインし、クラウドから22ロットの復元を確認済み。
8. GitHubに`production`環境を作成（必須レビュアー：taka-invest、デプロイ可能ブランチ：`main`のみ）。

### 4.2 コード（PR #16に追加したもの）
| ファイル | 内容 |
|---|---|
| `firestore.rules` | 既定で全拒否。Googleログイン かつ `/allowlist/{uid}.enabled == true` かつ 本人のUIDの場合のみ、`users/{uid}/workspaces/portfolio`を読み書きできる。書き込みはリビジョンを+1すること、サーバー時刻であることを必須にしている。`users/{uid}/backups/*`は追記のみ。削除は全面禁止。allowlistはクライアントから書き込み・一覧取得ともに不可 |
| `tests/emulator/firestore-rules.test.mjs` | Emulator上のルールテスト12件（未認証・未許可UID・無効化UID・Google以外のログイン・他人のUID・allowlistの改ざん・リビジョン競合・スキーマ・削除・トランザクション） |
| `app/firebase-cloud.mjs` | クラウド保存を8手順で実行：①JSONの自動バックアップ ②ローカル保存の破損チェックとスキーマ検証 ③サーバーから最新を再取得 ④差分を表示 ⑤本人が明示的に承認 ⑥上書き前のクラウド側バックアップ ⑦リビジョンを照合するトランザクション ⑧保存後に読み直して一致を確認。`undefined`はJSON往復で除去。ログイン時にUIDと許可状態を表示。比較はキー順に依存しない方式 |
| `app/ui.js` | 差分表示に`stagedFunding`と`confirmed`を追加。`backupJson`・`storageError`・`diffText`を公開。取り込み承認時に`pm:import-accepted`イベントを発行。バックアップのファイル名を`portfolio-manager-backup-YYYYMMDDHHmm.json`（JST）に変更 |
| `portfolio_manager.html` / `app/styles.css` | クラウド保存の差分表示欄を追加 |
| `functions/src/auth.js` | APIの入口で、IDトークンの検証（失効チェックあり）＋Googleログインであること＋allowlistへの登録（60秒キャッシュ）を確認 |
| `functions/src/index.js` | 上記の認証ゲートを全APIに適用。構造化ログ（API名・ステータス・処理時間・エラー分類のみ。UID・保有・金額は出さない）。chartはSEC連絡先が未設定でも停止しない |
| `scripts/allowlist-uid.mjs` | UIDの登録・無効化。そのUIDがAuth上のGoogleユーザーであることを確認してから書き込む |
| `scripts/auth-domains.mjs` | Authの承認済みドメインを一覧表示。このプロジェクトのweb.appドメインに限り追加できる |
| `.github/workflows/verify.yml` | 単体テスト → Firestoreルール（Java 21）→ Playwright。成功後、同じリポジトリのPRに限り`preview`チャネルへデプロイ（Secretが未設定ならスキップ） |
| `.github/workflows/firebase-production.yml` | 手動実行のみ（`main`で`DEPLOY`と入力）→ 全テスト → `production`環境での承認 → liveへデプロイ |
| `firebase.json` | Firestoreの`location: asia-northeast1`を明記 |
| `.firebaserc` | `finance-base-edcc7`（コミット済み。`.firebaserc.example`は削除） |
| docs | `MIGRATION_AUDIT.md` / `MIGRATION_PROGRESS.md` / `DEPLOYMENT.md` / 本書。`firebase-migration.md`を更新 |

### 4.3 テスト結果（最終実行時）
- `npm test`（node:test）：**62/62 成功**
- `npm run test:rules`（Firestore Emulator）：**12/12 成功**
- `npx playwright test --workers=1`：**26件成功・12件スキップ（端末別の意図的なスキップ）・0件失敗**
- GitHub Actions `verify`：直近の確認時点で成功

---

## 5. テストの実行方法と注意点

```powershell
npm ci
npm test
npm run test:rules        # Firestore Emulator（Java 21が必要）
npx playwright test --workers=1
npm run build:firebase    # dist/firebase に公開用ファイルのみを集める
```

- **Windowsの注意**：Firestore EmulatorがUnixドメインソケットの作成に失敗する場合は、`JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:/Users/<user>/.uds`（短いパスのディレクトリ）を指定する。Claude Codeのサンドボックス内では起動できなかったため、サンドボックス外で実行した。
- **Windowsの注意**：Playwrightを並列実行すると`python3 -m http.server`が接続を拒否することがある。`--workers=1`で実行する（CIのLinuxでは問題なし）。ポート4173を他のサーバーが使っていると失敗する。
- firebase-toolsの内部API（`lib/auth.js`の`selectAccount`）にプロジェクトのパスを渡すときは、**Windowsのネイティブパス（バックスラッシュ）**にすること。`C:/...`形式だとフォルダー固定のアカウントが見つからず、会社アカウントで実行されて403になる。

---

## 6. 変更禁止の業務仕様（Portfolio Manager）

- **目標配分**：NVDA 15%、AVGO 10%、PLTR 30%、APP 20%、SOFI 5%、CRDO 3%、RKLB 4%、SPCX 3%。長期の現金目標は10%。積立NISAの投資信託（`kind: fund`）は個別株の配分計算から除外する（`app/data.js:11-14`、`app/rebalance.js`）。
- **動的ピラミッディング**（`app/staged-funding.js`）：対象はNVDA・AVGO・CRDO。A日に累積50%、B日に累積80%、C日に累積100%。固定の円金額は使わない。各段階で保有・株価・USD/JPY・現金・目標配分・購入済み数量・税金・手数料を再計算する。購入資金はPLTRの売却で調達するが、**売却後のPLTRが30%を下回る案は禁止**。資金が足りない場合は不足額を表示する。
- これらはテスト（`tests/staged-funding.test.js`ほか）で守られている。**テストの期待値を書き換えて通すことは禁止。**

---

## 7. 未解決事項・既知の問題（優先度順）

### 高
1. **Stock Analyzerの移植元が旧版**：PR #16の`functions/src/legacy/{analyze,screener,chart}.js`は`Downloads`にあった旧コピー。最新版は`Documents\masya_app\netlify\functions\`にあり、`eps-revisions.js`（Finvizのスクレイピング）と`sec-8k-guidance.js`が加わっている。画面ファイル（`index.html` 140KB、`screener.html`、`library.html` 84KB）はリポジトリに入っていない。
2. **財務計算の重大な誤り**（`docs/MIGRATION_AUDIT.md` §3）
   - 四半期データに第4四半期がない（年次 − 9か月累計で作っていない）。そのため、配列の位置で計算している前年同期比・TTM・Rule of 40・営業レバレッジ・成長加速度が狂う。
   - 10-Kに含まれる前年比較値を重複として除去していない（3年CAGRが過小、自社株買いが二重計上）。
   - 修正提出（10-Q/A・10-K/A）より初回提出の値を優先している。`frame`を使っていない。
   - FCFが未実装。EPSの基本・希薄化後が混在。`epsGrowthYoY`の中身は純利益の成長率。
   - 欠損を`??0`でゼロ扱いしている箇所が複数ある。
   - スクリーナーは`opMargin`がnullの銘柄でTypeErrorになる（screener.js:164-165、最新版も同じ）。
   - Yahoo v7/v10はcrumbが必須で、空の応答になり得る。SEC以外のリクエストにUser-Agentがない。429応答への対応・リトライがない。キャッシュに上限がない。
3. **段階買付の「現在の弾」**（`localStorage['pm-staged-funding-stage']`）が主ステートの外にあり、クラウド同期されない。別PCでは第1弾に戻ってしまう。スキーマ変更が必要なため、方針を承認してもらってから実装する。

### 中
4. デプロイ用サービスアカウントが未設定。`firebase init hosting:github`は1回目がIAMの反映遅れで失敗し、2回目はOAuthの待ち受けが途中で終了した。未使用のサービスアカウント`github-action-1261182527@finance-base-edcc7.iam.gserviceaccount.com`（鍵なし）が残っているので、削除候補。**Claude Code環境では、IAM変更とサービスアカウント鍵の作成はガードレールでブロックされた。** オーナー自身が操作する前提で進めること。
5. 市場データ（Fear & Greed、VIX、^GSPC、テクニカル指標）を第三者のCORSプロキシ（allorigins / corsproxy.io / codetabs）経由で取得している。保有ティッカーが第三者に渡るうえ、本番ではCORSエラーも出ている。自前のFunctions（`/api/market`）に置き換える。
6. `validate()`は未知のキーを捨てる。スキーマを拡張するときはversionを上げ、移行処理を書く。
7. `research/library.html`は旧53KB版。最新は84KB版。
8. GitHubの公開履歴に、オーナーの個人メールアドレスが含まれたコミットが残っている（`docs/MIGRATION_PROGRESS.md`の過去版。現行版では削除済み）。履歴の書き換え（force push）は**オーナーの承認なしに行わないこと。**

### 低
9. バージョン表記が不一致（V2.3 / V2.6 / V2.7）。
10. CRDOは通常のリバランスでは`wait=true`だが、段階買付では購入対象になる（仕様の確認が必要）。

### オーナー側の作業
- 本番URLで証券口座と照合し、22ロットの口座区分・原価（`MOD`の原価が¥0）・現金を修正 →「実保有・現金を確認」→ クラウドに保存（リビジョン2）。
- Phase 2で使う`SEC_USER_AGENT`（実在する運用連絡先）の指定。**架空のメールアドレスは不可。値は`functions/.env`（gitignore済み）またはFunctionsのパラメーターに入れ、コミットしない。**

---

## 8. 次の作業（推奨順）

### Phase 2：Stock Analyzerバックエンド（Blazeなし・Emulatorで進められる範囲）
1. `Documents\masya_app`の最新ソースを`functions/src/legacy/`へ取り込む（旧版と差し替え。差分は記録する）。画面ファイルはPhase 3用に`research/`または新しいディレクトリへ移す。
2. 財務データ層を作り直す（`functions/src/sec/`などに分離）。
   - `frame`、または期末日と期間日数で重複を除く。修正提出（/A）を優先する。
   - 第4四半期 = 年次（10-K、約365日）− 9か月累計（または Q1+Q2+Q3）で合成する。
   - 前年同期比とTTMは、配列の位置ではなく期末日で突き合わせる。
   - FCF = 営業CF（`NetCashProvidedByUsedInOperatingActivities`）− 設備投資（`PaymentsToAcquirePropertyPlantAndEquipment`）。
   - EPSは希薄化後を基本にし、表示に定義を明記する。欠損は`null`のまま扱い、UIに「欠損」と表示する。
3. SECへのアクセス：`sec-gateway.js`に429/503応答とRetry-Afterへの対応、指数バックオフ、キャッシュ上限（LRU。抽出後の値のみ保持）を追加する。User-Agentは`SEC_USER_AGENT`（実在する連絡先）を使う。
4. Yahooの代替案を比較する（v8 chartは比較的安定。v7/v10はcrumbが必要）。取得元・更新時刻・通貨を、APIの応答と画面に表示する。
5. **フィクスチャテスト**：PLTR・APP・NVDAの公式10-Q/10-K（companyfacts JSONを保存）から、売上・営業利益・EPS・FCF・前年同期比・TTM・Rule of 40を計算し、手計算した期待値と照合する。旧Netlify版の出力とも比較し、差異の原因を`docs/`に記録する。
6. Functions Emulatorで`/api/analyze`・`/api/screener`・`/api/chart`を、認証付きで結合テストする（`firebase.json`のHostingリライトは、本番前まで追加しない）。

### Blazeが必要になる時点（要承認）
- Cloud Functionsの本番デプロイ前に、費用の見込み（`maxInstances:1`、512MiB、180秒、同時実行1）、予算アラートの金額、「予算アラートは課金を止める仕組みではない」ことを説明し、承認を得る。

### Phase 3以降
- ナビゲーションの統合（ダッシュボード／ポートフォリオ／売買・リバランス／個別企業分析／銘柄スクリーナー／市場分析／株価チャート／投資指標ライブラリ／取引履歴・投資ジャーナル／設定・データ管理）。銘柄の情報は一元管理する（保有・ウォッチリスト・分析・仮説・計画で共通に使う）。
- PR #16のマージ後は、本番デプロイを`firebase-production.yml`（承認ゲート）経由に一本化する。
- 最終工程：旧サイトの最終バックアップ → 移行案内 → Netlify・GitHub Pagesの停止（**オーナーの承認が必須**）。

---

## 9. 参照
- `docs/MIGRATION_PROGRESS.md`：時系列の詳細ログ・検証結果・ブロッカー
- `docs/MIGRATION_AUDIT.md`：PR #16の監査、スキーマ、Stock Analyzerの欠陥、機能の対応表
- `docs/DEPLOYMENT.md`：プレビュー・本番の流れ、サービスアカウントの初期設定、ロールバック
- `docs/firebase-migration.md`：データ移行の手順（旧サイトでJSONを書き出し → 新サイトで取り込み → クラウドに保存）
- `docs/specification.md` / `docs/staged-funding.md`：既存の業務仕様
