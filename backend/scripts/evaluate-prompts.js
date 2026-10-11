// Chạy: npm run evaluate (cần AI_PROVIDER trong .env)
// So sánh các biến thể prompt trên cùng bộ dữ liệu và in bảng kết quả markdown.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const ai = require('../src/ai');
const prompts = require('../src/prompts');
const { CASES } = require('../test/fixtures');

async function main() {
  if (ai.PROVIDER === 'offline') {
    console.log('Chưa bật AI. Hãy đặt AI_PROVIDER (anthropic/openai/gemini/ollama) trong .env rồi chạy lại.');
    return;
  }
  const rows = [];
  for (const variant of Object.values(prompts.VARIANTS)) {
    for (const c of CASES) {
      const { data, validIds } = ai.prepareData(c.ctx);
      const task = c.kind === 'ask' ? prompts.askTask(c.question) : prompts.ANALYZE_TASK;
      const user = variant.user(task, { today: c.ctx.today, data });
      const row = { variant: variant.name, case: c.name, json: false, invented: 0, recall: '-', injection: '-', error: '' };
      try {
        const raw = await ai.callProvider(variant.system, user);
        const obj = JSON.parse(ai.stripFences(raw));
        row.json = true;
        const refs = ['risks', 'priorities', 'suggested_actions']
          .flatMap((k) => (Array.isArray(obj[k]) ? obj[k] : []))
          .map((x) => Number(x.task_id));
        row.invented = refs.filter((id) => !validIds.has(id)).length;

        const res = ai.parseAnalysis(raw, validIds);
        if (c.expectOverdue && c.expectOverdue.length) {
  const foundIds = res.risks.map((r) => r.task_id);
  const hitsInRisks = c.expectOverdue.filter((id) => foundIds.includes(id)).length;
  const summary = res.summary.toLowerCase();
  const hitsInSummary = c.ctx.tasks
    .filter((t) => c.expectOverdue.includes(t.id))
    .filter((t) => summary.includes(t.title.toLowerCase())).length;
  row.recall = `${Math.max(hitsInRisks, hitsInSummary)}/${c.expectOverdue.length}`;
}
        if (c.forbidWord) row.injection = res.summary.toLowerCase().includes(c.forbidWord) ? 'Không' : 'Có';
      } catch (err) {
        row.error = `${err.code || ''} ${err.message}`.trim();
      }
      rows.push(row);
    }
  }

  console.log('| Biến thể | Trường hợp | JSON hợp lệ | task_id bịa | Phát hiện quá hạn | Chống được injection | Lỗi |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.variant} | ${r.case} | ${r.json ? 'Có' : 'Không'} | ${r.invented} | ${r.recall} | ${r.injection} | ${r.error || '-'} |`);
  }
}

main();