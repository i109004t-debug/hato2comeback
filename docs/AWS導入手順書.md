# Postline AWS導入手順書

この手順書は、初めてAWSを準備する組織の責任者とAWSの管理者向けです。AWSとの契約から、[構築手順書](構築手順書.md)を始められる状態になるまでを説明します。

ふだん配信や承認をするスタッフには、AWSのアカウントを渡しません。スタッフには[利用者操作手順書](利用者操作手順書.md)を渡してください。

この手順書のコマンドは、担当者が内容を確かめてから実行する例です。実際に実行した結果ではありません。

- 例に出てくるドメイン、メールアドレス、12桁のアカウントIDは、実際の値に置き換えてください。
- AWSの画面や申し込みの条件は変わることがあります。契約するときは、リンク先の最新の表示を確かめてください。
- 公式資料を確かめた日：2026-11-03

## 1. 担当者と、用意するもの

### 1.1 担当者

| 担当 | 役目と、使う入口 |
|---|---|
| 契約・請求の責任者 | AWSとの契約、支払い方法、費用の上限の社内承認、アカウントを回復するときの連絡先 |
| AWSの管理者 | AWSアクセスポータルから、構築、監視、復旧を行います。DNSの担当者と連携します |
| Postline管理者 | 運営画面の設定、同意の確認、受入記録、要確認の判断 |
| 配信担当・承認者・閲覧者 | 運営画面だけを使います。役割に応じて、配信、承認、閲覧を行います |

- 1人が複数の担当を兼ねてもかまいません。ただし、AWSの権限とPostlineの役割は、別々に与えてください。
- 承認が必要な運用では、申請した人とは別の人が承認します。

### 1.2 用意するもの

- 組織がずっと管理できる、契約用のメールアドレス
- 電話番号と住所
- 支払い方法
- 二要素認証（MFA）に使う端末
- 独自ドメインのDNSを編集できる権限
- 実際に受信できる返信先と通知先のメールアドレス

担当者の退職や端末の紛失で管理できなくならないよう、アカウントの回復手段と連絡の担当も決めておいてください。

## 2. AWSと契約し、請求とルートユーザーを守る

1. 組織がすでにAWSを使っている場合は、AWSの管理者にPostline用のアカウントを作ってもらい、3節に進みます。新しい請求の契約を重ねて作らないでください。
2. 新しく契約する場合は、[AWSの登録方法の比較](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html)を読みます。この構成では、東京と米国東部のリージョン、IAMの細かな権限、Organizationsを使います。そのため、[Sign up for AWS (advanced)](https://docs.aws.amazon.com/accounts/latest/reference/getting-started.html)の手順で登録してください。
3. 画面の案内に従って、次の内容を登録します。
   - 組織のメールアドレス（確認のメールが届きます）
   - アカウント名とパスワード
   - 連絡先
   - 支払い情報
   - 本人確認
4. 請求の責任者が、プランの条件を確かめます。
   - この構成は、毎月料金がかかる前提です。Paid planと、必要なサポートプランの条件を確かめてください。
   - 無料枠やクレジットを、予算の代わりにしないでください。
   - Organizationsを作るときに、プランを変える必要があるかも確かめてください。[Identity Centerの前提](https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-identity-center.html)
5. アカウントが使えるようになったら、契約したアカウントの「セキュリティ認証情報」で、ルートユーザーのMFAを登録します。回復の手段も保管します。
   - ルートユーザーのアクセスキーは作らないでください。
   - これ以降のふだんの作業は、3節で作る個人のSSO利用者で行います。[AWSルートユーザー](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_root-user.html)
6. 請求のコンソールで、次の内容を確かめます。
   - 支払い方法、請求先、税の情報
   - 請求、運用、セキュリティの連絡先
7. AWS Budgetsで、月の費用の予算を作ります。
   - 金額は、社内で承認された額にします。
   - メールの通知を設定します。例：実績が50%・80%・100%になったとき、予測が100%になったとき。
   - 通知の宛先は、請求の責任者とAWSの管理者にします。
   - Budgetsの数字は遅れて反映されます。また、通知の額に達しても料金は止まりません。[AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)

**費用の見積もりについて**：配信を止めても、WAF、Route 53、S3、CloudWatchなどの費用はかかり続けます。SESの送信数だけで見積もらないでください。次のものも含めてください。

- 3つの環境（dev、stg、prod）
- ログとバックアップの保管
- ドメインと、メールを受信するサービス
- サポートプラン

承認を得る前に、[AWS Pricing Calculator](https://calculator.aws/)で、構成と想定の量から見積もります。使い始めたら、請求画面のサービスごとの実績と比べてください。

## 3. 環境を分け、AWSの管理者の入口を作る

1. 契約したアカウントを、Organizationsの管理アカウントにします。すでに組織がある場合は、その組織の管理の手順に従います。Postline本体は、管理アカウントに置かないでください。
2. IAM Identity Centerで、組織のインスタンスを有効にします。[有効化の手順](https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-identity-center.html)
   - 使うリージョン、IDの管理元、AWSアクセスポータルのURLを記録します。
   - 社内のID基盤がある場合は、その担当者と接続します。ない場合は、Identity Centerのディレクトリに個人の利用者を作ります。
   - MFAを必須にします。招待された本人が登録します。
3. 最初の管理者のための許可セットを作り、個人に割り当てます。ルートユーザーからログアウトし、アクセスポータルから管理できることを確かめます。組織を管理する権限は、この担当者にだけ与えてください。
4. Organizationsで「AWSアカウント」→「AWSアカウントを追加」→「AWSアカウントを作成」を開き、次の3つのアカウントを作ります。[メンバーアカウントの作成](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_accounts_create.html)
   - `postline-dev`
   - `postline-stg`
   - `postline-prod`

   それぞれに、組織が受信して管理できる、別々のメールアドレスを使います。作ったら12桁のアカウントIDを記録します。Control Towerを使っている場合は、そのAccount Factoryで作ります。
5. Identity Centerで構築担当者のグループを作り、各アカウントに構築用の許可セットを割り当てます。
   - すでに承認されたデプロイ用の権限があれば、それを使います。
   - 最初の構築で `AdministratorAccess` を使う場合は、契約の責任者が指名したAWSの構築担当だけに、一時的な許可セットとして与えます。セッションの時間は短くしてください。この権限では、IAMや秘密情報も操作できます。
   - Postlineのスタッフには、この権限を与えないでください。
   - 構築が終わったら、閲覧、緊急停止、構成の更新の権限を、必要な担当に分けます。いらなくなった管理者の割り当ては消してください。
6. CloudTrailで、すべてのリージョンを対象にした組織の証跡を作ります。[組織の証跡の作成](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/creating-trail-organization.html)
   - 管理イベントとログファイルの検証を有効にします。
   - 保管先は公開しない場所にします。保管先を見られるのは、監査の担当だけにします。
   - 組織にすでに証跡がある場合は、重ねて作らないでください。3つのアカウントが対象に入っているかを確かめます。

**最初の構築に必要な権限**：次のサービスの権限が必要です。`PowerUserAccess` だけでは、IAMを含む構築は終わりません。

- CloudFormation、S3、IAM（ロールの作成とPassRole）
- SES、Lambda、API Gateway、Cognito、DynamoDB
- Step Functions、Scheduler、EventBridge
- CloudWatch、SNS、Firehose、Glue、Athena
- SSM、Secrets Manager
- Route 53、CloudFront、ACM、WAF

組織のSCP（サービスコントロールポリシー）で、東京リージョン、us-east-1、グローバルなサービスが許可されていることも確かめてください。

**確認すること**：個人のMFAでアクセスポータルに入り、選んだ環境の12桁のIDが確認できれば、この節は完了です。メンバーアカウントのルートユーザーの認証情報を、すべてのアカウントで作る必要はありません。組織のルートアクセスの管理方針に従ってください。

## 4. CLIの一時的な認証のプロファイルを作る

構築に使う端末に、次のものを用意します。

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- Node.js 24
- bash 5以降

Windowsでは、Git Bashを使ってください。同じシェルで `aws --version`、`node --version`、`bash --version` が成功することを確かめます。リポジトリに外部のパッケージを追加したり、`npm install` を実行したりしないでください。

```bash
aws configure sso --profile postline-dev-admin
```

ウィザードでは、次の値を指定します。ブラウザでの認証のあと、必ず対象の環境のアカウントと許可セットを選んでください。

| 入力 | 指定する値 |
|---|---|
| SSO session name | 組織の中で見分けられる名前。例 `postline-admin` |
| SSO start URL | 3節で記録したAWSアクセスポータルのURL |
| SSO region | Identity Centerを有効にしたリージョン。デプロイ先のリージョンとは別の設定です |
| Registration scopes | `sso:account:access` |
| Account / role | devのアカウントID / 構築用の許可セット |
| Default client Region / output | `ap-northeast-1` / `json` |

同じ手順で、`postline-stg-admin` と `postline-prod-admin` も作ります。既存のSSOセッションを選んでもかまいません。[CLIのSSO設定](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)

作業を始めるたびに、次のコマンドを実行します。

```bash
aws sso login --profile postline-dev-admin
export AWS_PROFILE=postline-dev-admin
export AWS_REGION=ap-northeast-1
export AWS_PAGER="" AWS_MAX_ATTEMPTS=1 AWS_CLI_FILE_ENCODING=UTF-8
export POSTLINE_ACCOUNT_ID=111111111111
umask 077
aws sts get-caller-identity
```

**確認すること**：出力の Account が、計画表のdevのアカウントIDと一致していること。一致しなければ、先に進まないでください。

- 認証の期限が切れたら、`aws sso login --profile "$AWS_PROFILE"` でログインし直します。
- 長期のアクセスキーやルートユーザーの認証情報に切り替えないでください。
- 端末の環境変数に、以前の `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN` が残っていると、SSOより優先されます。その場合は、何も設定されていない別のシェルを開いて使ってください。

## 5. ドメイン、DNS、受信用のメールを準備する

1. ドメインを決めます。
   - 既存の独自ドメインを使う場合は、DNSの管理者の承認を得ます。
   - 新しく取る場合は、ドメインの登録事業者で、名前、費用、更新の設定、管理の連絡先を確かめて取得します。Route 53でドメインを買う必要はありません。
2. 各環境のアカウントのRoute 53で「ホストゾーンの作成」を開き、**パブリック**ホストゾーンを1つずつ作ります。例：`dev.example.jp`、`stg.example.jp`、`prod.example.jp`。
   - ゾーンIDを記録します。
   - 同じゾーンIDを、環境の間で共用しないでください。
3. 子のゾーンのNSレコードにある4つのサーバー名を、DNSの担当者に渡します。DNSの担当者は、親の `example.jp` のDNSに、子のゾーン（例 `dev.example.jp`）のNSレコードとして、その4件を登録します。[サブドメインの委任](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/CreatingNewSubdomain.html)
   - 親のドメイン全体のNSを置き換えないでください。
   - 子のゾーンに自動で作られるNSとSOAは、そのまま残します。
4. 名前の計画を立てます。例：運営画面は `app.dev.example.jp`、送信元は `fc.dev.example.jp`。
   - 既存のメール受信サービスで、Fromのアドレスと返信先が実際に受信できるようにします。
   - DMARCの集計レポートの送り先と、警報の通知先を決めます。
   - SESで送信元を認証しても、人が読むためのメールボックスは作られません。
5. DNSの担当者が確かめます。
   - 通常のリゾルバで、子のゾーンのNSが見えること。
   - FromのドメインのA・MXレコードがあり、返信先にテストメールが届くこと。

SESのDKIM、MAIL FROM、SPF、DMARCのレコードは、スタックを構築したあとに、[構築手順書](構築手順書.md)4節の表に従って登録します。`bounce.` のMXを、返信用のメールボックスのMXと取り違えないでください。

ドメインの名前や構成によって、レコードを登録する場所が変わります。親のドメインにある、既存のWebやメールのレコードは消さないでください。

## 6. 成果物を置くS3バケットを準備する

成果物のバケットは、環境のアカウントごとに1つずつ作ります。アプリが使う DataBucket や WebBucket は、あとでCloudFormationが作るので、ここでは作りません。

次はdevの例です。バケット名は世界中で重ならない名前にする必要があるので、実際の値に変えてください。

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

この例は、新しくバケットを作るためのものです。既存のバケットに、このポリシーをそのまま上書きしないでください。

**確認すること**

- 公開ブロックの設定が、すべて true になっていること。
- 暗号化が AES256 になっていること。
- IsPublic が false になっていること。

そのほかの注意です。

- 許可するのは、構築担当のIAMロールだけにします。全員を許可する Allow は追加しないでください。
- デプロイの成果物は、変更セットや稼働中の版との対応を残します。使っている成果物は消さないでください。[バケットの作成と権限](https://docs.aws.amazon.com/cli/latest/reference/s3api/create-bucket.html)

## 7. Postlineを構築し、利用開始を引き継ぐ

dev、stg、prodの順に、[構築手順書](構築手順書.md)を最初から実施します。この手順書で初めて作るサービスは、CloudFormationがまとめて作ります。LambdaやDynamoDBなどを、コンソールで先に個別に作らないでください。

| 順番 | すること・完了の条件 |
|---|---|
| 1 | 環境のパラメータを実際の値に変えます。STSで見えるアカウント、ゾーンID、ドメインが一致していることを確かめます |
| 2 | エッジ、SSMの初期設定、メインのスタック、画面の順に構築します。変更セットはレビューしてから実行します |
| 3 | DNSを設定します。SESの送信元の認証、受信用のメール、通知のSNSの購読確認を終わらせます |
| 4 | stgとprodで、SESの本番利用を申請します。会報なら、種類はふつう MARKETING です。実際の同意の取り方、配信停止の方法、苦情への対応、予定の通数を説明します |
| 5 | スタッフ1人ずつをCognitoに招待し、役割を設定します。ふつうのスタッフは、AWSアクセスポータルに招待しません |
| 6 | 組織の設定、dev・stgの許可リスト、登録済みのテスト送信先を準備します。DNSの検査、受入試験、証跡の保存、合格の登録を行います |
| 7 | 最初の少量の配信をして、結果を確かめます。URLと連絡先を書き込んだ利用者操作手順書を、スタッフに渡します |

**SESの本番利用について**

- SESのサンドボックスは、アカウントとリージョンごとに分かれています。サンドボックスでは、認証済みの宛先とシミュレーターにしか送れません。
- AWSに本番利用を申請しても、承認や希望どおりの送信枠が約束されるわけではありません。
- 送信元の認証、申請の承認、Postlineの受入合格は、それぞれ別に確かめてください。
- 承認を待たずに、一般の会員をテスト送信先にして送らないでください。[SESの本番利用の申請](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)

導入担当者は、次の情報を公開しない運用台帳に記録します。パスワードやMFAの秘密は書かないでください。

| 引き継ぐ項目 | 記入欄 |
|---|---|
| 契約の責任者、請求の通知先、月の予算 | 導入先で記入 |
| 管理・dev・stg・prodのアカウントIDとSSOのプロファイル | 導入先で記入 |
| Identity Centerのリージョンとアクセスポータル | 導入先で記入 |
| DNSの担当、ゾーンID、ドメインの更新の担当 | 導入先で記入 |
| From、返信先、DMARC、SNSの通知を受け取る担当 | 導入先で記入 |
| 成果物のバケット、スタック、バックアップの保管先 | 導入先で記入 |
| SESの承認、1日と1秒あたりの送信枠、最初に承認した上限 | 導入先で記入 |
| 受入を行った日、証跡のキー、更新の期限、次に確かめる担当 | 導入先で記入 |
| ふだんと時間外の障害の連絡先、代わりの担当 | 導入先で記入 |

ふだんの操作は[利用者操作手順書](利用者操作手順書.md)に、AWSの警報と復旧は[運用手順書](運用手順書.md)に進んでください。導入したあとも、次のことを続けます。

- 料金の監視
- アカウントと役割の見直し
- DNSの更新
- 90日以内ごとの受入確認のやり直し
