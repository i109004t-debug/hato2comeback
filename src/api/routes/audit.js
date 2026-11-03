import { listRecords } from '../../common/records.js';

export default { 'audit.list': ({ runtime, query }) => listRecords(runtime, `AUDIT#${query.month}`, query) };
