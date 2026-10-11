process.env.AI_PROVIDER = 'offline';
process.env.AI_RETRY_DELAY_MS = '0';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/ai');
const { ctxBasic, ctxLarge } = require('./fixtures');

const ids = new Set([1, 2, 3]);
const validJson = JSON.stringify({
  summary: 'Ổn',
  risks: [{ task_id: 1, task_title: 'A', severity: 'high', reason: 'trễ' }],
});

test('parseAnalysis từ chối nội dung không phải JSON', () => {
  assert.throws(() => ai.parseAnalysis('không phải json', ids), (e) => e.code === 'BAD_FORMAT');
});

test('parseAnalysis từ chối nội dung rỗng', () => {
  assert.throws(() => ai.parseAnalysis('   ', ids), (e) => e.code === 'EMPTY');
});

test('parseAnalysis bỏ được khối markdown ```json', () => {
  const r = ai.parseAnalysis('```json\n' + validJson + '\n```', ids);
  assert.equal(r.summary, 'Ổn');
  assert.equal(r.risks.length, 1);
});

test('sanitize loại bỏ task_id không có trong dữ liệu (chống bịa)', () => {
  const r = ai.parseAnalysis(
    JSON.stringify({ summary: 'x', risks: [{ task_id: 999, task_title: 'ma', severity: 'high', reason: '' }] }),
    ids
  );
  assert.equal(r.risks.length, 0);
});

test('sanitize đổi mức độ không hợp lệ thành medium', () => {
  const r = ai.parseAnalysis(
    JSON.stringify({ summary: 'x', risks: [{ task_id: 1, severity: 'khẩn cấp', reason: '' }] }),
    ids
  );
  assert.equal(r.risks[0].severity, 'medium');
});

test('sanitize yêu cầu có phần tóm tắt', () => {
  assert.throws(() => ai.parseAnalysis(JSON.stringify({ risks: [] }), ids), (e) => e.code === 'BAD_FORMAT');
});

test('prepareData giới hạn số nhiệm vụ và đánh dấu đã cắt bớt', () => {
  const { data, truncated, validIds } = ai.prepareData(ctxLarge(150));
  assert.equal(data.tasks.length, ai.MAX_TASKS);
  assert.equal(truncated, true);
  assert.equal(validIds.size, ai.MAX_TASKS);
  assert.equal(data.total_tasks, 150);
});

test('prepareData không đưa email hay mật khẩu vào dữ liệu gửi AI', () => {
  const { data } = ai.prepareData({ ...ctxBasic(), members: [{ id: 1, name: 'A', role: 'member', email: 'a@x.com' }] });
  const s = JSON.stringify(data);
  assert.ok(!s.includes('@'));
  assert.ok(!s.includes('password'));
});

test('generate trả về kết quả live khi AI trả lời đúng định dạng', async () => {
  const r = await ai.generate('analyze', ctxBasic(), '', { call: async () => validJson });
  assert.equal(r.mode, 'live');
  assert.equal(r.result.summary, 'Ổn');
});

test('generate thử lại một lần khi định dạng sai rồi thành công', async () => {
  let n = 0;
  const r = await ai.generate('analyze', ctxBasic(), '', { call: async () => (++n === 1 ? 'hỏng' : validJson) });
  assert.equal(r.mode, 'live');
  assert.equal(n, 2);
});

test('generate chuyển sang dự phòng khi lỗi timeout (không thử lại)', async () => {
  let n = 0;
  const r = await ai.generate('analyze', ctxBasic(), '', {
    call: async () => {
      n++;
      throw Object.assign(new Error('AI phản hồi quá lâu'), { code: 'TIMEOUT' });
    },
  });
  assert.equal(r.mode, 'offline');
  assert.equal(n, 1);
    assert.equal(typeof r.notice, 'string');
  assert.ok(Array.isArray(r.result.risks));
});

test('generate chuyển sang dự phòng khi AI luôn trả sai định dạng', async () => {
  const r = await ai.generate('analyze', ctxBasic(), '', { call: async () => 'hỏng' });
  assert.equal(r.mode, 'offline');
});

test('generate báo đã cắt bớt dữ liệu khi dự án quá lớn', async () => {
  const r = await ai.generate('analyze', ctxLarge(150));
  assert.equal(r.truncated, true);
});

test('fallbackAnalysis đánh dấu nhiệm vụ quá hạn là rủi ro cao', () => {
  const r = ai.fallbackAnalysis(ctxBasic());
  assert.ok(r.risks.some((x) => x.task_id === 1 && x.severity === 'high'));
});
test('sanitize đếm số mục bị loại để so sánh biến thể', () => {
  const r = ai.parseAnalysis(
    JSON.stringify({
      summary: 'x',
      risks: [{ task_id: 1, severity: 'high', reason: '' }, { task_id: 999, reason: '' }],
    }),
    ids
  );
  assert.equal(r.risks.length, 1);
  assert.equal(r._dropped, 1);
});