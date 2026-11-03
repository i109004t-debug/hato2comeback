# Postline AWS導入手順書

AWSを初めて準備する組織の責任者・AWS管理者向け。契約から、[構築手順書](構築手順書.md)を開始できる状態までを扱う。通常の配信担当者・承認者にはAWSアカウントを配らず、[利用者操作手順書](利用者操作手順書.md)を渡す。

この文書のコマンドは担当者が確認して実行する例であり、実行済みの結果ではない。例のドメイン、メールアドレス、12桁のアカウントIDは実値へ置き換える。AWSの画面・申込条件は変更されるため、契約時はリンク先の最新表示を確認する。公式資料の確認日：2026-11-03。

## 1. 担当者と用意するもの

| 担当 | 責任・使う入口 |
|---|---|
| 契約・請求責任者 | AWS契約、支払方法、費用上限の社内承認、アカウント回復の連絡先 |
| AWS管理者 | AWSアクセスポータルから構築・監視・復旧。DNS担当者と連携 |
| Postline管理者 | 運営画面の設定、同意の確認、受入記録、要確認の判断 |
| 配信担当・承認者・閲覧者 | 運営画面のみ。役割に応じて配信・承認・閲覧 |

同じ人が兼任してもよいが、AWSの権限とPostlineの役割は別に付与する。承認を必要にする運用では、申請者とは別の人が承認する。

用意するものは、組織が継続管理する契約用メール、電話番号、住所、支払方法、MFA端末、独自ドメインのDNS編集権限、実際に受信できる返信先・通知先。個人の退職・端末紛失で管理不能にならないよう、回復手段と連絡担当も決める。

## 2. AWSを契約し、請求とルートユーザーを保護する

1. 既存の組織AWSがある場合は、管理者へPostline用アカウントの発行を依頼し、3節へ進む。新しい請求契約を重複して作らない。
2. 新規の場合は [AWSの登録方法の比較](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html) を確認する。本構成は東京と米国東部、IAMの個別権限、Organizationsを使うため、[Sign up for AWS (advanced)](https://docs.aws.amazon.com/accounts/latest/reference/getting-started.html) の手順で登録する。
3. 組織のメールを検証し、アカウント名・パスワード、連絡先、支払情報、本人確認を画面に従って登録する。本構成は継続課金を前提とし、Paid planと、必要なサポートプランの条件を請求責任者が確認する。無料枠・クレジットを予算の代わりにしない。Organizationsを作成する際のプラン変更条件も確認する。[Identity Centerの前提](https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-identity-center.html)
4. 有効化後、契約アカウントの「セキュリティ認証情報」でルートユーザーのMFAを登録し、回復手段を保管する。ルートのアクセスキーは作らない。以後の日常作業は3節で作る個人のSSO利用者へ移す。[AWSルートユーザー](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user.html)
5. 請求コンソールで支払方法・請求先・税情報・請求/運用/セキュリティの連絡先を確認する。AWS Budgetsで月額のコスト予算を作成し、社内承認額と、例えば実績50%・80%・100%、予測100%のメール通知を設定する。宛先は請求責任者とAWS管理者にする。Budgetsには反映遅延があり、通知額で料金が止まる仕組みではない。[AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)

配信を停止しても、WAF・Route 53・S3・CloudWatch等の費用は続く。SES送信数だけで見積もらず、3環境、ログ・バックアップ保持、ドメインと受信メールサービス、サポートを含める。承認前に [AWS Pricing Calculator](https://calculator.aws/) で構成と想定量を見積もり、稼働後は請求画面のサービス別実績と比べる。

## 3. 環境を分け、AWS管理者の入口を作る

1. 契約アカウントをOrganizationsの管理アカウントにする。既存組織では既存の管理手順を使う。管理アカウントにPostline本体を置かない。
2. IAM Identity Centerで組織インスタンスを有効にする。使用リージョン、IDソース、AWSアクセスポータルURLを記録する。既存の社内ID基盤があればその担当者と接続し、なければIdentity Centerディレクトリに個人の利用者を作る。MFAを必須にし、招待された本人が登録する。[有効化手順](https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-identity-center.html)
3. 初期管理者用の許可セットと個人への割当を作り、ルートからログアウトしてアクセスポータルから管理できることを確認する。組織管理の権限は、この担当者だけに付与する。
4. Organizationsの「AWSアカウント」→「AWSアカウントを追加」→「AWSアカウントを作成」で `postline-dev`、`postline-stg`、`postline-prod` を作成する。それぞれ異なる、組織が受信・管理できるメールアドレスを使う。12桁のIDを記録する。既存のControl Tower環境ではそのAccount Factoryを使う。[メンバーアカウントの作成](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_accounts_create.html)
5. Identity Centerで構築担当者用グループを作り、各アカウントに構築用許可セットを割り当てる。既存の承認済みデプロイ権限があればそれを使う。初期構築で `AdministratorAccess` を使う場合は、契約責任者が指名したAWS構築担当だけに、一時的な許可セットとして付与し、セッション時間を短くする。この権限はIAMと秘密も操作できる。Postlineスタッフには付与しない。構築後は閲覧・緊急停止・構成更新を必要な担当へ分け、不要な管理者割当を削除する。
6. CloudTrailに全リージョンの組織証跡を作成し、管理イベントとログファイル検証を有効にして非公開の保管先を指定する。組織の既存証跡があれば重複作成せず、3アカウントが対象か確認する。保管先の閲覧は監査担当に限定する。[組織証跡の作成](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/creating-trail-organization.html)

初期構築ではCloudFormation、S3、IAM作成/PassRole、SES、Lambda、API Gateway、Cognito、DynamoDB、Step Functions、Scheduler、EventBridge、CloudWatch/SNS、Firehose/Glue/Athena、SSM、Secrets Manager、Route 53、CloudFront、ACM、WAFの権限が必要。`PowerUserAccess` だけではIAMを含む構築は完了しない。組織のSCPで東京・us-east-1・グローバルサービスが許可されていることも確認する。

完了条件は、個人のMFAでポータルに入り、選んだ環境の12桁IDを確認できること。メンバーアカウントのルート認証情報を一律に作成する必要はない。組織のルートアクセス集中管理方針に従う。

## 4. CLIの一時認証プロファイルを作る

構築端末に [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)、Node.js 24、bash 5以降を準備する。WindowsではGit Bashを使い、同じシェルで `aws --version`、`node --version`、`bash --version` が成功することを確認する。リポジトリに外部パッケージを追加したり `npm install` したりしない。

```bash
aws configure sso --profile postline-dev-admin
```

ウィザードでは次を指定する。ブラウザ認証後、必ず対象環境のアカウントと許可セットを選ぶ。

| 入力 | 指定値 |
|---|---|
| SSO session name | 組織内で識別できる名前。例 `postline-admin` |
| SSO start URL | 3節で記録したAWSアクセスポータルURL |
| SSO region | Identity Centerを有効にしたリージョン。デプロイ先とは別の設定 |
| Registration scopes | `sso:account:access` |
| Account / role | devのアカウントID / 構築用許可セット |
| Default client Region / output | `ap-northeast-1` / `json` |

同じ手順を `postline-stg-admin`、`postline-prod-admin` でも行う。既存のSSOセッションを選んでよい。操作を始めるたびに次を実行する。[CLIのSSO設定](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)

```bash
aws sso login --profile postline-dev-admin
export AWS_PROFILE=postline-dev-admin
export AWS_REGION=ap-northeast-1
export AWS_PAGER="" AWS_MAX_ATTEMPTS=1 AWS_CLI_FILE_ENCODING=UTF-8
export POSTLINE_ACCOUNT_ID=111111111111
umask 077
aws sts get-caller-identity
```

出力のAccountが計画表のdevと一致することを確認する。一致しなければ進めない。認証期限切れは `aws sso login --profile "$AWS_PROFILE"` で入り直す。長期アクセスキーやルート認証情報へ切り替えない。環境変数に以前の `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` が残っている端末では、SSOより優先されないよう別のクリーンなシェルを使う。

## 5. ドメイン、DNS、受信メールを準備する

1. 既存の独自ドメインを使う場合はDNS管理者の承認を得る。新規取得ならドメイン登録事業者で希望名・費用・更新設定・管理連絡先を確認して取得する。Route 53でドメイン自体を購入する必要はない。
2. 各環境のAWSアカウントのRoute 53で「ホストゾーンの作成」を開き、`dev.example.jp` / `stg.example.jp` / `prod.example.jp` の**パブリック**ホストゾーンをそれぞれ作る。ゾーンIDを記録する。同じゾーンIDを環境間で共用しない。
3. 子ゾーンのNSレコードにある4つのサーバー名をDNS担当へ渡す。親 `example.jp` のDNSに、例えば `dev.example.jp` のNSとしてその4件を登録する。親全体のNSを置き換えない。子ゾーンの自動作成NS/SOAは維持する。[サブドメインの委任](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/CreatingNewSubdomain.html)
4. 運営画面を `app.dev.example.jp`、送信元を `fc.dev.example.jp` 等として計画する。既存のメール受信サービスでFromと返信先を実際に受信できるようにし、DMARC集計先・警報の通知先も決める。SESの送信元認証だけでは、人が読むメールボックスは作られない。
5. DNS担当が通常のリゾルバで子ゾーンのNSを確認する。FromのA/MXと返信先へのテストメールの受信を確認する。SESのDKIM、MAIL FROM、SPF、DMARCはスタック構築後に[構築手順書](構築手順書.md)4節の表に従って登録する。`bounce.` のMXを返信用メールボックスのMXと取り違えない。

ドメイン名と構成によって登録先が異なるため、親ドメインの既存Web・メール用レコードを削除しない。

## 6. 成果物用S3バケットを準備する

各環境のアカウントで1つずつ作る。アプリのDataBucketやWebBucketは後でCloudFormationが作るため、ここでは作らない。以下はdevの例。バケット名は全世界で一意の実値へ変更する。

```bash
export ARTIFACT_BUCKET=postline-yourorg-artifacts-dev-111111111111
mkdir -p build
aws sts get-caller-identity
aws s3api create-bucket --region ap-northeast-1 --bucket "$ARTIFACT_BUCKET" \
  --create-bucket-configuration LocationConstraint=ap-northeast-1 \
  --object-ownership BucketOwnerEnforced
aws s3api put-public-access-block --region ap-northeast-1 --bucket "$ARTIFACT_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --region ap-northeast-1 --bucket "$ARTIFACT_BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
cat > build/artifact-tls-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::$ARTIFACT_BUCKET","arn:aws:s3:::$ARTIFACT_BUCKET/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
EOF
aws s3api put-bucket-policy --region ap-northeast-1 --bucket "$ARTIFACT_BUCKET" \
  --policy file://build/artifact-tls-policy.json
aws s3api get-public-access-block --region ap-northeast-1 --bucket "$ARTIFACT_BUCKET"
aws s3api get-bucket-encryption --region ap-northeast-1 --bucket "$ARTIFACT_BUCKET"
aws s3api get-bucket-policy-status --region ap-northeast-1 --bucket "$ARTIFACT_BUCKET"
```

既存バケットへこのポリシーをそのまま上書きしない。新規作成用の例である。公開ブロックの設定がすべてtrue、暗号化がAES256、IsPublicがfalseであることを確認する。許可は構築担当のIAMロールに限定し、全員へのAllowは追加しない。デプロイ成果物は変更セット・稼働版と対応を残し、使用中のものを削除しない。[バケット作成と権限](https://docs.aws.amazon.com/cli/latest/reference/s3api/create-bucket.html)

## 7. Postlineを構築し、利用開始を引き継ぐ

まずdev、次にstg、最後にprodの順で、[構築手順書](構築手順書.md)を最初から実施する。そこで初めて作るサービスはCloudFormationがまとめて構築する。LambdaやDynamoDB等をコンソールで個別に先行作成しない。

| 順番 | 実施すること・完了条件 |
|---|---|
| 1 | 環境パラメータを実値へ変更。STSのアカウントとゾーンID、ドメインを照合 |
| 2 | エッジ→SSM初期設定→主スタック→画面の順に構築。変更セットをレビュー |
| 3 | DNSを設定し、SESの送信元認証・受信メール・通知のSNS購読確認を完了 |
| 4 | stgとprodでSES本番利用を申請。会報は通常MARKETING。実際の同意取得・解除・苦情対応・予定通数を説明 |
| 5 | Cognitoへ個人のスタッフを招待し役割を設定。通常スタッフはAWSアクセスポータルに招待しない |
| 6 | 組織設定、dev/stg許可リスト、登録済みテスト先を準備。DNS検査・受入試験・証跡保存・合格登録 |
| 7 | 初回の少量配信と結果確認。URLと連絡先を記入した利用者手順書を渡す |

SESのSandboxはアカウント・リージョン別で、認証済み宛先またはシミュレーターに制限される。AWSへの本番利用申請は承認や希望送信枠を保証しない。送信元認証・申請承認・Postlineの受入合格は別々に確認する。承認を待たず一般会員をテスト先として送らない。[SES本番利用の申請](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)

導入担当者は次の情報を非公開の運用台帳へ記録する。パスワードやMFA秘密は書かない。

| 引継ぎ項目 | 記入欄 |
|---|---|
| 契約責任者・請求通知・月額予算 | 導入先で記入 |
| 管理/dev/stg/prodのアカウントIDとSSOプロファイル | 導入先で記入 |
| Identity Centerリージョン・アクセスポータル | 導入先で記入 |
| DNS担当・ゾーンID・ドメイン更新担当 | 導入先で記入 |
| From・返信先・DMARC・SNS通知の受信担当 | 導入先で記入 |
| 成果物バケット・スタック・バックアップ保管先 | 導入先で記入 |
| SES承認・日次/速度枠・初回承認上限 | 導入先で記入 |
| 受入実施日・証跡キー・更新期限・次回確認担当 | 導入先で記入 |
| 通常/時間外の障害連絡先・代理担当 | 導入先で記入 |

日常操作は[利用者操作手順書](利用者操作手順書.md)、AWS警報と復旧は[運用手順書](運用手順書.md)に進む。料金の監視、アカウント・役割の棚卸し、DNSの更新、90日以内の再受入を継続する。
