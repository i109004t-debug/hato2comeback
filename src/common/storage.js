export async function* objectPages(runtime, Bucket, Prefix) {
  let token;
  const seen = new Set();
  do {
    const page = await runtime.s3.listObjectsV2({ Bucket, Prefix, ...(token ? { ContinuationToken: token } : {}) });
    yield page.Contents ?? [];
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!token || seen.has(token))) throw new Error('Invalid S3 cursor');
    if (token) seen.add(token);
  } while (token);
}

export async function deleteDeliveryIndex(runtime, addrId) {
  if (!/^[a-f0-9]{64}$/.test(addrId)) throw new TypeError('Invalid recipient identifier');
  const PK = `ADDR#${addrId}`;
  for await (const page of runtime.store.queryPages({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': { S: PK } } })) {
    for (const item of page.items) {
      await runtime.store.delete(PK, item.SK, { ConditionExpression: 'attribute_exists(PK)' });
    }
  }
}
