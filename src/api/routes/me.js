export async function get({ runtime, user }) {
  const org = await runtime.store.get('SETTINGS', 'ORG');
  return { ...user, organization_name: org?.legal?.sender_name ?? '' };
}

export default { 'me.get': get };
