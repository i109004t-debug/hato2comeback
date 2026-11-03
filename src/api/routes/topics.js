export async function list({ runtime }) {
  const [topics, counts] = await Promise.all([
    runtime.ses.getContactList({ ContactListName: runtime.contactList }),
    runtime.store.get('SETTINGS', 'TOPIC_COUNTS'),
  ]);
  return { items: (topics.Topics ?? []).map((item) => ({ ...item, subscribers: counts?.counts?.[item.TopicName] ?? null })), counted_at: counts?.counted_at ?? null };
}

export default { 'topics.list': list };
