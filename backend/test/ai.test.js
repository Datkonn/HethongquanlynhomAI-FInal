process.env.AI_PROVIDER = 'offline';
process.env.AI_RETRY_DELAY_MS = '0';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-ai-${Date.now()}.db`);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');
const ai = require('../src/ai');
const { ctxBasic, ctxLarge } = require('./fixtures');

let server;
let base;

before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    base = `http://localhost:${server.address().port}/api`;
    resolve();
  });
}));
after(() => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
}));

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

let counter = 0;
async function newUser() {
  const email = `aiuser${Date.now()}${counter++}@test.local`;
  const r = await call('POST', '/auth/register', { body: { name: 'Thử nghiệm', email, password: '123456' } });
  return { token: r.data.token, id: r.data.user.id, email };
}

async function newProject(owner) {
  const r = await call('POST', '/projects', { token: owner.token, body: { name: 'Dự án thử' } });
  return r.data.id;
}

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
test('phòng thử prompt: danh sách phiên bản và nhật ký', async () => {
  const owner = await newUser();
  const pid = await newProject(owner);
  const v = await call('GET', '/lab/variants?kind=analyze', { token: owner.token });
  assert.equal(v.status, 200);
  assert.deepEqual(v.data.map((x) => x.id), ['v1_basic', 'v2_schema', 'v3_final']);
  assert.ok(v.data[2].template.includes('[SYSTEM]'));
  const logs = await call('GET', `/projects/${pid}/ai/logs`, { token: owner.token });
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.data));
});

test('AI Chatbox: hỏi đáp qua API chatbox (POST /api/ai/chat)', async () => {
  const user = await newUser('Chatter');
  const pid = await newProject(user);

  // 1. Chưa đăng nhập
  const unauth = await call('POST', '/ai/chat', { body: { message: 'Chào AI' } });
  assert.equal(unauth.status, 401);

  // 2. Chat trong ngữ cảnh dự án cụ thể
  const inProject = await call('POST', '/ai/chat', {
    token: user.token,
    body: { projectId: pid, message: 'Dự án có những việc nào quá hạn không?' },
  });
  assert.equal(inProject.status, 200);
  assert.ok(inProject.data.answer);
  assert.equal(typeof inProject.data.answer, 'string');

  // 3. Chat tổng thể không có projectId (ở dashboard)
  const general = await call('POST', '/ai/chat', {
    token: user.token,
    body: { message: 'Tổng quan tiến độ các dự án thế nào?' },
  });
  assert.equal(general.status, 200);
  assert.ok(general.data.answer);
  assert.equal(typeof general.data.answer, 'string');
});
