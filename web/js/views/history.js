import { errorText } from '../api.js';
import { clone, element, tableRows, showMessage, on, formatCount, formatTime, statusLabel, createActionGate } from '../dom.js';

export function historyRow(campaign) {
  return { state: statusLabel(campaign.status), title: campaign.subject || '件名の保持期間が過ぎています', topic: campaign.topic_display ?? campaign.topic ?? '—', created: formatTime(campaign.created_at), scheduled: campaign.scheduled_at ? formatTime(campaign.scheduled_at) : '', accepted: `${formatCount(campaign.counts?.accepted)} ／ ${formatCount(campaign.recipients_total)}`, problems: `${formatCount(campaign.counts?.failed)} ／ ${formatCount(campaign.counts?.unknown)}`, skipped: formatCount(campaign.counts?.skipped_blocked) };
}

export async function mount(ctx) {
  const root = clone('history-template');
  ctx.root.replaceChildren(root);
  const gate = createActionGate();
  let cursor;
  async function load(next) {
    await gate.run(async () => {
      root.querySelector('[data-next]').disabled = true;
      try {
        const page = await ctx.api.request('/campaigns', { query: { limit: 50, cursor: next } });
        cursor = page.cursor;
        tableRows(root.querySelector('[data-history]'), page.items.map((campaign) => {
          const row = historyRow(campaign);
          const link = element('a', `${row.topic} ／ ${row.title}`);
          link.href = `#/send/${campaign.campaign_id}`;
          return [row.state, link, [row.created, row.scheduled].filter(Boolean).join(' ／ '), row.accepted, row.problems, row.skipped];
        }));
      } catch (error) { showMessage(root, errorText(error), true); }
    });
    root.querySelector('[data-next]').disabled = !cursor;
  }
  on(root, '[data-next]', 'click', () => load(cursor));
  await load();
}
