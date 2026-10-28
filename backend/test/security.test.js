process.env.AI_PROVIDER = 'offline';
process.env.AI_ANONYMIZE = 'true';
process.env.AI_RETRY_DELAY_MS = '0';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-sec-${Date.now()}.db`);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');
const db = require('../src/db');
const ai = require('../src/ai');
const { purgeOldAiLogs } = require('../src/security');
const { ctxBasic } = require('./fixtures');

let server;
let root;
let base;

before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    root = `http://localhost:${server.address().port}`;
    base = `${root}/api`;
    resolve();
  });
}));
after(() => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
}));

test('B1: phản hồi có header bảo mật và không lộ phiên bản server', async () => {
  const res = await fetch(root + '/');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('B2: trang web khác không được gọi API (không có CORS)', async () => {
  const res = await fetch(base + '/projects', { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('B3: dữ liệu gửi AI không chứa tên thật khi bật ẩn danh', () => {
  const { data } = ai.prepareData(ctxBasic(), { anonymize: true });
  const s = JSON.stringify(data);
  assert.ok(!s.includes('"A"'));
  assert.ok(!s.includes('"B"'));
  assert.ok(s.includes('Thành viên 1'));
});

test('B4: đổi lại tên thật trong kết quả AI', () => {
  const { restoreMap } = ai.prepareData(ctxBasic(), { anonymize: true });
  const r = ai.restoreNames(
    {
      workload_warnings: [{ member: 'Thành viên 1', open_tasks: 3, note: '' }],
      suggested_actions: [{ field: 'assignee', value: 'Thành viên 2', task_id: 1, reason: '' }],
    },
    restoreMap
  );
  assert.equal(r.workload_warnings[0].member, 'A');
  assert.equal(r.suggested_actions[0].value, 'B');
});

test('B5: lượt gọi AI không gửi tên thật, nhưng người dùng thấy tên thật', async () => {
  let sent = '';
  const r = await ai.generate('analyze', ctxBasic(), '', {
    call: async (system, user) => {
      sent = user;
      return JSON.stringify({
        summary: 'Ổn',
        workload_warnings: [{ member: 'Thành viên 1', open_tasks: 3, note: 'Nhiều việc' }],
      });
    },
  });
  assert.equal(r.mode, 'live');
  assert.ok(!sent.includes('"A"'));
  assert.equal(r.result.workload_warnings[0].member, 'A');
});

test('B6: nhật ký AI cũ được xóa theo thời hạn lưu', () => {
  db.prepare("INSERT INTO ai_logs (kind, prompt, response, mode, created_at) VALUES ('x', 'cũ', '{}', 'live', '2020-01-01 00:00:00')").run();
  db.prepare("INSERT INTO ai_logs (kind, prompt, response, mode) VALUES ('x', 'mới', '{}', 'live')").run();
  assert.ok(purgeOldAiLogs(db, 30) >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_logs WHERE prompt = 'cũ'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_logs WHERE prompt = 'mới'").get().n, 1);
});