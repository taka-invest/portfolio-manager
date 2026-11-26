# デプロイとロールバック手順（Firebase Hosting）

フロー: **GitHub PR → 自動テスト → Firebaseプレビュー → レビュー → 本人承認 → Firebase本番**

| 段階 | 仕組み | 本番への影響 |
|---|---|---|
| PR作成・push | `.github/workflows/verify.yml` の `verify`（単体・Firestoreルール・Playwright PC/スマホ） | なし |
| プレビュー | 同 `preview` ジョブ。`verify`成功後のみ、同一リポジトリのブランチのみ、固定チャネル`preview`（30日で失効）へ | なし（liveチャネルは指定できない） |
| 本番 | `.github/workflows/firebase-production.yml`。**手動実行のみ**（`main`で`DEPLOY`と入力）→ 全テスト → GitHub環境`production`で**taka-investの承認**後にliveへ | あり |

- プレビューURL: https://finance-base-edcc7--preview-es1ecisz.web.app （Googleログインの承認済みドメイン登録済み）
- 本番URL: https://finance-base-edcc7.web.app
- push・PR・マージだけで本番に出ることはない（`tests/firebase-foundation.test.js`で検査）。
- GitHub Secret `FIREBASE_SERVICE_ACCOUNT_FINANCE_BASE_EDCC7` 未設定の間はプレビュー配備を警告付きでスキップする。

## デプロイ用サービスアカウント（初回のみ・本人操作）

Claude Codeの安全設定により、IAM変更と鍵作成はClaudeからは実行しない。本人が公式コマンドで行う。

```powershell
cd $env:USERPROFILE\Documents\Claude\portfolio-manager
firebase init hosting:github
```

回答例:
- GitHubリポジトリ: `taka-invest/portfolio-manager`（ブラウザーでtaka-investとしてGitHub連携を承認）
- ビルドスクリプトを実行するか: **No**（ワークフローは本リポジトリの既存ファイルを使う）
- マージ時に本番へ自動デプロイするか: **No**（本番自動デプロイは禁止）
- 自動生成される`.github/workflows/firebase-hosting-pull-request.yml`は既存の`verify.yml`と重複するため削除する（Claudeが対応）
- `firebase.json`や`public`ディレクトリの上書きを聞かれたら: **No**

これでサービスアカウント `github-action-…@finance-base-edcc7.iam.gserviceaccount.com`（Hosting管理・Auth管理などFirebase公式の既定ロール）と、GitHub Secret `FIREBASE_SERVICE_ACCOUNT_FINANCE_BASE_EDCC7` が作られる。鍵ファイルはローカルに残らない。Firestoreのデータ読み書き権限は付与されない。

## ロールバック

1. **最速**: Firebase Console → Hosting → リリース履歴 → 戻したいバージョンの「︙」→「ロールバック」。
2. CLI: 直前の検証済みプレビューを本番へ複製（テスト済みの同一ファイル）
   ```powershell
   firebase hosting:clone finance-base-edcc7:preview finance-base-edcc7:live
   ```
3. Gitで修正をrevert → PR → プレビュー確認 → 本番ワークフローを再実行。

データ（Firestore）はHostingのロールバックの影響を受けない。誤った上書きをした場合は、クラウド上の`users/{uid}/backups/*`（上書き直前のスナップショット）か、保存時に自動ダウンロードされたJSON（`portfolio-manager-backup-YYYYMMDDHHmm.json`）から「JSONを選択」で差分確認のうえ復元する。

## Firestoreルール

ルールの本番反映はHostingとは別操作（現状は手動）:
```powershell
npm run test:rules
firebase deploy --only firestore:rules --project finance-base-edcc7
```

## ローカルでの通し確認（Emulator）

```powershell
npm run dev:emulators
```

- http://localhost:5100/portfolio_manager.html#analysis を開く（`firebase.emulator.json`の`/api/*`転送が有効）
- demoプロジェクトのAuth/Firestore/Functionsを使うため、本番データには触れない。SECへのアクセスには`functions/.env`の`SEC_USER_AGENT`が必要
- 本番の`firebase.json`には、Cloud Functionsをデプロイするまで`/api`の転送を追加しない

## Cloud Functions（本番）

```powershell
npm test
npm run test:api
npx firebase deploy --only functions --project finance-base-edcc7
```

- `functions/.env`（gitignore）の`SEC_USER_AGENT`がデプロイ時に環境変数として設定される。リポジトリには書かない
- 同じく `FINNHUB_API_KEY`（個別企業分析の次回決算・コンセンサス用、任意）。未設定なら分析画面は「サーバーにFinnhubキーが未設定です」と表示し、自分の想定だけ使える。本人が `functions/.env` に1行追加してから Functions をデプロイする
- 全関数 `maxInstances: 1` / `concurrency: 1` / 512MiB / 180秒（費用の上限を抑えるため）。変更時は費用見込みを再確認
- 古いコンテナイメージは3日で自動削除（`firebase functions:artifacts:setpolicy --location asia-northeast1 --days 3`）
- Hostingの`/api/*`転送は`firebase.json`に記載。Functionsを削除する場合は転送も外すこと
- 同時1件のため、クライアントは1関数あたり1リクエストずつ送る（スクリーナーは1バッチずつ・混雑429/5xxは1回だけ再試行）。並列化してもSECの毎秒2件制限で速くならない
- スクリーナーは1リクエスト90秒で新しい銘柄の取得を打ち切り、残りは「時間切れ」行で返す（関数の180秒強制終了で全件失うのを防ぐ）
- 取得キャッシュは件数40かつ応答サイズ合計40MBまで（companyfactsは1社数MB。全件スキャンで512MiBを超えないため）

## Firestoreのバックアップと復元

- 日次バックアップ・7日保持（2026-11-26設定、スケジュールID `ac6cf8ea-…`）。削除保護は有効。PITRは無効
- 一覧：`npx firebase firestore:backups:list --project finance-base-edcc7`
- 復元は**新しいデータベースへ**行う（本番の `(default)` は上書きしない）。中身を確認してから、必要な分だけアプリの「JSONを選択」または差分確認付きの取り込みで戻す
  ```powershell
  npx firebase firestore:databases:restore --database restored-YYYYMMDD --backup <バックアップ名> --project finance-base-edcc7
  ```
  確認後、復元用データベースは不要になったら削除する（保存料がかかるため。削除は要承認）
- アプリ側の保護も併用：上書き前のクラウド上バックアップ（`users/{uid}/backups`）、保存前のJSON自動ダウンロード、別端末の変更を消さない同期

## 緊急停止・費用の上限

費用が想定外に増えた、または不審なアクセスがある場合の止め方（上から順に影響が小さい）。

1. **APIの利用を止める（データは残る）**：自分のUIDの許可を外す。60秒以内に全APIが403になり、上流（SEC・Yahoo）への問い合わせも止まる。
   ```powershell
   node scripts/allowlist-uid.mjs <UID> --disable
   ```
   再開は `--disable` を付けずに同じコマンドを実行。未ログイン・未許可のリクエストは認証で即401となり、上流には届かない
2. **関数ごと止める**：Firebase Console → Functions、またはGoogle Cloud Console → Cloud Run で該当サービスを削除する（再開は`firebase deploy --only functions`）。Hostingの画面は動き続け、APIだけ「未公開」と表示される
3. **上限**：全関数 `maxInstances: 1`。どれだけ呼ばれても同時に動くのは1関数1台のため、費用は時間に比例する上限で止まる。予算アラート（月1,000円・50/90/100%）を必ず有効にしておく
4. ログ確認は `npx firebase functions:log --project finance-base-edcc7 --only <関数名>`。アプリのログはAPI名・ステータス・処理時間・エラー分類のみ。**監査ログ（AuditLog）にはアカウントのメールが含まれるため、ログをファイルに保存・共有しない**
