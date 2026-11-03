import { eraseMatch } from '../../common/erase.js';
import { invalid } from '../../common/http.js';
import { normalizeEmail } from '../../common/email.js';

export async function eraseSuppression(event, runtime) {
  const email = normalizeEmail(event.email).email;
  if (!/^[a-f0-9]{64}$/.test(event.erase_mac ?? '')) throw invalid('erase_mac');
  try {
    const match = await eraseMatch(runtime, email);
    if (match !== event.erase_mac || !await runtime.store.get('ERASED', match)) throw new Error('Erase record required');
    try { await runtime.ses.deleteSuppressedDestination({ EmailAddress: email }); } catch (error) {
      if (error.name !== 'NotFoundException') throw error;
    }
    return { status: 'DONE' };
  } catch {
    await runtime.notify('ERASE_SUPPRESSION_FAILED', 'contact');
    return { status: 'FAILED', code: 'ERASE_SUPPRESSION_FAILED' };
  }
}
