# Postline 実装ガイド（コーディングエージェント向け）

このリポジトリは、ファンクラブ等のメール配信システム「Postline」の実装である。

## 正本

- 実装仕様の正本は `docs/詳細設計書.md`（v2.2）。要件と理由は `docs/基本設計書.md`（v2.2）。
- 節番号・API ID（API-xx）・試験 ID（T-xx）・エラーコードは詳細設計書の表記に合わせる。
- 次の文書は編集しない：`docs/基本設計書.md`、`docs/詳細設計書.md`、`docs/Postline_利用者向けご案内_v0.1.md`。
- 設計の不明点・矛盾は、安全側（送らない・止める・再送しない）を選んで実装し、`docs/実装メモ.md` に「節番号／判断／理由」を追記する。

## 配置

詳細設計書15.1節の `postline/` をリポジトリ直下と読み替える（`package.json`、`infra/`、`scripts/`、`src/`、`web/`、`test/` を直下に置く）。

## 絶対の制約

- 外部パッケージを使わない。`package.json` に `dependencies`・`devDependencies` を書かない。`npm install` をしない。
- `src/` が読み込んでよいのは `node:` の標準モジュールと、Lambda 実行環境に同梱の `@aws-sdk/client-*` だけ。
- AWS SDK は手元に入っていない。**SDK は `src/common/aws.js` の中でだけ、動的 `import()` で遅延読込する。** 他のモジュールは SDK を直接 import しない。各ハンドラーは `createHandler(deps)` を公開し、`deps` に SDK の薄いアダプター（例 `deps.ses.sendEmail(input)`）・時計・待機関数・設定を受け取る。テストは偽物を渡す。
- 運営画面（`web/`）は素の HTML・CSS・JavaScript（ES モジュール）。フレームワーク・ビルド・外部スクリプト・CDN を使わない。`innerHTML` を使わない。PKCE は Web Crypto で自作する。
- インフラは CloudFormation（YAML）と AWS CLI だけ。CDK・Terraform・SAM CLI に依存しない。
- テストは `node --test test/`。追加した処理には必ずテストを付け、作業の最後に全件が通ることを確かめる。
- 実際の AWS アカウントへの操作、ネットワークアクセス、`git commit`・`git push` をしない（コミットは監督側が行う）。

## 書き方

- ES モジュール、Node.js 24。インデント 2 スペース、セミコロンあり。識別子は英語、コメントは日本語で必要な所だけ。
- エラーは `AppError(code, status, message, fieldErrors?)`。想定外は `500 INTERNAL`、スタックはログにだけ出す。
- ログ・メトリクス・エラー応答にメールアドレス・トークン・解除URLを出さない（必要なら伏せ字か HMAC）。
- DynamoDB の更新には必ず条件式を付ける。配信記録は `version` で楽観ロック。
- 送信を含む処理は自動で再試行しない。結果不明（UNKNOWN）は送り直さない。
- 文字コードは UTF-8（BOM なし）、改行は LF。
