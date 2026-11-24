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

- http://localhost:5000/portfolio_manager.html#analysis を開く（`firebase.emulator.json`の`/api/*`転送が有効）
- demoプロジェクトのAuth/Firestore/Functionsを使うため、本番データには触れない。SECへのアクセスには`functions/.env`の`SEC_USER_AGENT`が必要
- 本番の`firebase.json`には、Cloud Functionsをデプロイするまで`/api`の転送を追加しない

## Cloud Functions（本番）

```powershell
npm test
npm run test:api
npx firebase deploy --only functions --project finance-base-edcc7
```

- `functions/.env`（gitignore）の`SEC_USER_AGENT`がデプロイ時に環境変数として設定される。リポジトリには書かない
- 全関数 `maxInstances: 1` / `concurrency: 1` / 512MiB / 180秒（費用の上限を抑えるため）。変更時は費用見込みを再確認
- 古いコンテナイメージは3日で自動削除（`firebase functions:artifacts:setpolicy --location asia-northeast1 --days 3`）
- Hostingの`/api/*`転送は`firebase.json`に記載。Functionsを削除する場合は転送も外すこと
