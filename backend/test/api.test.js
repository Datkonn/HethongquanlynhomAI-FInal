process.env.AI_PROVIDER = 'offline';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-test-${Date.now()}.db`);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/server');

let server;
let base;

before(() => new Promise((resolve) => {
  server = app.listen(0, () => {
    base = `http://localhost:${server.address().port}/api`;
    resolve();
  });
}));
after(() => new Promise((resolve) => server.close(resolve)));

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
  const email = `user${Date.now()}${counter++}@test.local`;
  const r = await call('POST', '/auth/register', { body: { name: 'Thử nghiệm', email, password: '123456' } });
  return { token: r.data.token, id: r.data.user.id, email };
}

async function newProject(owner) {
  const r = await call('POST', '/projects', { token: owner.token, body: { name: 'Dự án thử' } });
  return r.data.id;
}

test('đăng ký, đăng nhập và lấy thông tin tài khoản', async () => {
  const u = await newUser();
  const r = await call('GET', '/auth/me', { token: u.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.email, u.email);
});

test('sai mật khẩu bị từ chối với 401', async () => {
  const r = await call('POST', '/auth/login', { body: { email: 'manager@demo.com', password: 'sai' } });
  assert.equal(r.status, 401);
});

test('người ngoài dự án không xem được dự án (403)', async () => {
  const owner = await newUser();
  const other = await newUser();
  const pid = await newProject(owner);
  const r = await call('GET', `/projects/${pid}`, { token: other.token });
  assert.equal(r.status, 403);
});

test('thành viên không tạo được nhiệm vụ, quản lý thì tạo được', async () => {
  const owner = await newUser();
  const member = await newUser();
  const pid = await newProject(owner);
  await call('POST', `/projects/${pid}/members`, { token: owner.token, body: { email: member.email, role: 'member' } });

  const denied = await call('POST', `/projects/${pid}/tasks`, { token: member.token, body: { title: 'Việc mới' } });
  assert.equal(denied.status, 403);

  const ok = await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: 'Việc mới' } });
  assert.equal(ok.status, 201);
});

test('thành viên chỉ đổi được trạng thái nhiệm vụ của chính mình', async () => {
  const owner = await newUser();
  const member = await newUser();
  const other = await newUser();
  const pid = await newProject(owner);
  await call('POST', `/projects/${pid}/members`, { token: owner.token, body: { email: member.email } });
  await call('POST', `/projects/${pid}/members`, { token: owner.token, body: { email: other.email } });

  const mine = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Của tôi', assignee_id: member.id },
  });
  const theirs = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Của người khác', assignee_id: other.id },
  });

  const ok = await call('PUT', `/tasks/${mine.data.id}`, { token: member.token, body: { status: 'done' } });
  assert.equal(ok.status, 200);

  const no = await call('PUT', `/tasks/${theirs.data.id}`, { token: member.token, body: { status: 'done' } });
  assert.equal(no.status, 403);
});

test('dữ liệu nhiệm vụ không hợp lệ bị trả về 400', async () => {
  const owner = await newUser();
  const pid = await newProject(owner);
  const r = await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: '   ' } });
  assert.equal(r.status, 400);
  const d = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'x', deadline: '2026-13-45' },
  });
  assert.equal(d.status, 400);
});

test('AI phân tích trả về kết quả có cấu trúc, đánh dấu chế độ dự phòng', async () => {
  const owner = await newUser();
  const pid = await newProject(owner);
  const task = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc trễ', deadline: '2020-01-01' },
  });
  const r = await call('POST', `/projects/${pid}/ai/analyze`, { token: owner.token, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'offline');
  assert.ok(Array.isArray(r.data.result.risks));
  assert.ok(r.data.result.risks.some((x) => x.task_id === task.data.id));
});

test('người ngoài dự án không gọi được AI (403)', async () => {
  const owner = await newUser();
  const other = await newUser();
  const pid = await newProject(owner);
  const r = await call('POST', `/projects/${pid}/ai/analyze`, { token: other.token, body: {} });
  assert.equal(r.status, 403);
});

test('câu hỏi AI quá 500 ký tự bị từ chối', async () => {
  const owner = await newUser();
  const pid = await newProject(owner);
  const r = await call('POST', `/projects/${pid}/ai/ask`, { token: owner.token, body: { question: 'a'.repeat(501) } });
  assert.equal(r.status, 400);
});

test('AI bị giới hạn số lượt gọi (429) khi gửi quá nhiều', async () => {
  const owner = await newUser();
  const pid = await newProject(owner);
  let last = null;
  for (let i = 0; i < 11; i++) {
    last = await call('POST', `/projects/${pid}/ai/analyze`, { token: owner.token, body: {} });
  }
  assert.equal(last.status, 429);
});