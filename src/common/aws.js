export const AWS_APIS = Object.freeze({
  ses: { package: 'sesv2', client: 'SESv2Client', operations: ['GetAccount', 'GetEmailIdentity', 'GetConfigurationSet', 'GetConfigurationSetEventDestinations', 'GetContactList', 'ListContacts', 'GetContact', 'CreateContact', 'UpdateContact', 'DeleteContact', 'GetSuppressedDestination', 'CreateImportJob', 'GetImportJob', 'CreateEmailTemplate', 'GetEmailTemplate', 'TestRenderEmailTemplate', 'DeleteEmailTemplate', 'SendEmail'] },
  ddb: { package: 'dynamodb', client: 'DynamoDBClient', operations: ['GetItem', 'PutItem', 'UpdateItem', 'Query', 'TransactWriteItems', 'BatchGetItem'] },
  s3: { package: 's3', client: 'S3Client', operations: ['PutObject', 'GetObject', 'HeadObject'] },
  sfn: { package: 'sfn', client: 'SFNClient', operations: ['StartExecution', 'DescribeExecution', 'SendTaskSuccess', 'SendTaskFailure'] },
  scheduler: { package: 'scheduler', client: 'SchedulerClient', operations: ['CreateSchedule', 'DeleteSchedule', 'GetSchedule'] },
  cognito: { package: 'cognito-identity-provider', client: 'CognitoIdentityProviderClient', operations: ['AdminGetUser', 'AdminListGroupsForUser'] },
  cloudwatch: { package: 'cloudwatch', client: 'CloudWatchClient', operations: ['GetMetricData', 'DescribeAlarms'] },
  sns: { package: 'sns', client: 'SNSClient', operations: ['Publish'] },
  ssm: { package: 'ssm', client: 'SSMClient', operations: ['GetParameter'] },
  secrets: { package: 'secrets-manager', client: 'SecretsManagerClient', operations: ['GetSecretValue'] },
  lambda: { package: 'lambda', client: 'LambdaClient', operations: ['Invoke'] },
});

const defaultLoad = (name) => import(`@aws-sdk/client-${name}`);

export function createAwsAdapters({ region, load = defaultLoad, timeoutSignal = (ms) => AbortSignal.timeout(ms) } = {}) {
  return Object.fromEntries(Object.entries(AWS_APIS).map(([service, definition]) => {
    let pending;
    const getClient = () => {
      pending ??= load(definition.package).then((sdk) => ({
        sdk,
        client: new sdk[definition.client]({
          ...(region ? { region } : {}),
          // Lambdaの非同期Invokeなど、送信処理を開始するAPIも再試行しない。
          maxAttempts: 1,
          ...(service === 'ses' ? { requestHandler: { connectionTimeout: 10000, requestTimeout: 10000 } } : {}),
        }),
      })).catch((error) => { pending = undefined; throw error; });
      return pending;
    };
    const adapter = Object.fromEntries(definition.operations.map((operation) => {
      const method = operation[0].toLowerCase() + operation.slice(1);
      return [method, async (input) => {
        if (service === 'ddb') {
          const mutations = operation === 'TransactWriteItems' ? (input.TransactItems ?? []).flatMap((item) => [item.Update, item.Put, item.Delete].filter(Boolean)) : ['UpdateItem', 'PutItem'].includes(operation) ? [input] : [];
          if (mutations.some((item) => !item.ConditionExpression)) throw new TypeError('DynamoDB mutations require a condition');
        }
        const { sdk, client } = await getClient();
        return client.send(new sdk[`${operation}Command`](input), service === 'ses' ? { abortSignal: timeoutSignal(10000) } : undefined);
      }];
    }));
    return [service, Object.freeze(adapter)];
  }));
}
