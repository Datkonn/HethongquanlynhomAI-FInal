process.env.AI_PROVIDER = 'offline';
process.env.AI_RETRY_DELAY_MS = '0';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-func-${Date.now()}.db`);

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
after(() => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
}));

async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

let seq = 0;
async function newUser(name = 'Thử nghiệm') {
  const email = `func${Date.now()}${seq++}@test.local`;
  const r = await call('POST', '/auth/register', { body: { name, email, password: '123456' } });
  return { token: r.data.token, id: r.data.user.id, email, name };
}

// Mỗi test có dự án riêng: quản lý + 2 thành viên
async function setup() {
  const owner = await newUser('Quản lý');
  const memberA = await newUser('Thành viên A');
  const memberB = await newUser('Thành viên B');
  const p = await call('POST', '/projects', {
    token: owner.token,
    body: { name: 'Dự án kiểm thử', start_date: '2026-01-01', end_date: '2099-12-31' },
  });
  const pid = p.data.id;
  await call('POST', `/projects/${pid}/members`, { token: owner.token, body: { email: memberA.email, role: 'member' } });
  await call('POST', `/projects/${pid}/members`, { token: owner.token, body: { email: memberB.email, role: 'member' } });
  return { owner, memberA, memberB, pid };
}

test('F1: đăng nhập bằng tài khoản demo', async () => {
  const r = await call('POST', '/auth/login', { body: { email: 'manager@demo.com', password: '123456' } });
  assert.equal(r.status, 200);
  assert.ok(r.data.token);
});

test('F2: tạo, xem và sửa dự án', async () => {
  const { owner, pid } = await setup();
  const list = await call('GET', '/projects', { token: owner.token });
  assert.ok(list.data.some((p) => p.id === pid && p.my_role === 'manager'));

  const got = await call('GET', `/projects/${pid}`, { token: owner.token });
  assert.equal(got.data.members.length, 3);

  const upd = await call('PUT', `/projects/${pid}`, { token: owner.token, body: { name: 'Đã sửa', status: 'closed' } });
  assert.equal(upd.data.name, 'Đã sửa');
  assert.equal(upd.data.status, 'closed');
});

test('F3: thêm, sửa, xóa nhiệm vụ (quản lý)', async () => {
  const { owner, pid, memberA } = await setup();
  const c = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc 1', assignee_id: memberA.id, priority: 'high', deadline: '2099-01-01' },
  });
  assert.equal(c.status, 201);
  assert.equal(c.data.assignee_name, 'Thành viên A');

  const u = await call('PUT', `/tasks/${c.data.id}`, { token: owner.token, body: { title: 'Việc 1 đã sửa', priority: 'low' } });
  assert.equal(u.data.title, 'Việc 1 đã sửa');
  assert.equal(u.data.priority, 'low');

  const d = await call('DELETE', `/tasks/${c.data.id}`, { token: owner.token });
  assert.equal(d.status, 200);
  const left = await call('GET', `/projects/${pid}/tasks`, { token: owner.token });
  assert.equal(left.data.length, 0);
});

test('F4: tìm kiếm, lọc và sắp xếp nhiệm vụ', async () => {
  const { owner, pid, memberA } = await setup();
  const mk = (body) => call('POST', `/projects/${pid}/tasks`, { token: owner.token, body });
  await mk({ title: 'Thiết kế giao diện', priority: 'low', status: 'todo' });
  await mk({ title: 'Xây dựng API', priority: 'high', status: 'doing', assignee_id: memberA.id });
  await mk({ title: 'Viết báo cáo', priority: 'medium', status: 'done' });

  const q = (qs) => call('GET', `/projects/${pid}/tasks?${qs}`, { token: owner.token }).then((r) => r.data);
  assert.equal((await q('q=API')).length, 1);
  assert.equal((await q('status=done')).length, 1);
  assert.equal((await q('priority=high')).length, 1);
  assert.equal((await q('assignee=none')).length, 2);
  assert.equal((await q(`assignee=${memberA.id}`)).length, 1);
  assert.equal((await q('sort=priority'))[0].priority, 'high');
});

test('F5: thống kê tiến độ và nhiệm vụ quá hạn', async () => {
  const { owner, pid } = await setup();
  const mk = (body) => call('POST', `/projects/${pid}/tasks`, { token: owner.token, body });
  await mk({ title: 'Đã xong', status: 'done', deadline: '2020-01-01' });
  await mk({ title: 'Trễ hạn', status: 'todo', deadline: '2020-01-01' });
  await mk({ title: 'Còn hạn', status: 'todo', deadline: '2099-01-01' });

  const s = await call('GET', `/projects/${pid}/stats`, { token: owner.token });
  assert.equal(s.data.total, 3);
  assert.equal(s.data.done, 1);
  assert.equal(s.data.overdue, 1);
  assert.equal(s.data.progress, 33);
});

test('F6: phân quyền thành viên và người ngoài dự án', async () => {
  const { owner, pid, memberA } = await setup();
  const outsider = await newUser('Người ngoài');
  const mine = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Của A', assignee_id: memberA.id },
  });

  // Thành viên bị chặn các thao tác quản lý
  assert.equal((await call('POST', `/projects/${pid}/tasks`, { token: memberA.token, body: { title: 'x' } })).status, 403);
  assert.equal((await call('DELETE', `/tasks/${mine.data.id}`, { token: memberA.token })).status, 403);
  assert.equal((await call('PUT', `/projects/${pid}`, { token: memberA.token, body: { name: 'x' } })).status, 403);
  assert.equal(
    (await call('POST', `/projects/${pid}/members`, { token: memberA.token, body: { email: outsider.email } })).status,
    403
  );
  // Người ngoài không xem được dự án
  assert.equal((await call('GET', `/projects/${pid}`, { token: outsider.token })).status, 403);

  // Thành viên chỉ đổi được trạng thái việc của mình
  assert.equal((await call('PUT', `/tasks/${mine.data.id}`, { token: memberA.token, body: { status: 'doing' } })).status, 200);
  assert.equal((await call('PUT', `/tasks/${mine.data.id}`, { token: memberA.token, body: { title: 'Đổi tên' } })).status, 403);
});

test('F7: quản lý thành viên dự án', async () => {
  const { owner, pid, memberB } = await setup();
  const t = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Của B', assignee_id: memberB.id },
  });

  const rm = await call('DELETE', `/projects/${pid}/members/${memberB.id}`, { token: owner.token });
  assert.equal(rm.status, 200);

  // Khi xóa thành viên, nhiệm vụ của người đó trở thành chưa phân công
  const list = await call('GET', `/projects/${pid}/tasks`, { token: owner.token });
  const task = list.data.find((x) => x.id === t.data.id);
  assert.equal(task.assignee_id, null);

  // Dự án phải luôn có ít nhất một quản lý
  const self = await call('DELETE', `/projects/${pid}/members/${owner.id}`, { token: owner.token });
  assert.equal(self.status, 400);
});

test('F8: nhật ký hoạt động ghi lại thay đổi', async () => {
  const { owner, pid } = await setup();
  await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: 'Nhiệm vụ ghi log' } });
  const r = await call('GET', `/projects/${pid}/activity`, { token: owner.token });
  assert.equal(r.status, 200);
  assert.ok(r.data.some((a) => a.action.includes('tạo nhiệm vụ')));
});

test('F9: phân tích và hỏi đáp AI dùng dữ liệu thật của dự án', async () => {
  const { owner, pid } = await setup();
  const late = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc trễ', deadline: '2020-01-01' },
  });

  const a = await call('POST', `/projects/${pid}/ai/analyze`, { token: owner.token, body: {} });
  assert.equal(a.status, 200);
  assert.equal(typeof a.data.result.summary, 'string');
  assert.ok(a.data.result.risks.some((x) => x.task_id === late.data.id));

  const q = await call('POST', `/projects/${pid}/ai/ask`, {
    token: owner.token,
    body: { question: 'Nhiệm vụ nào quá hạn?' },
  });
  assert.equal(q.status, 200);
  assert.ok(q.data.result.summary.includes('quá hạn'));
});

test('F10: so sánh và chạy từng biến thể prompt', async () => {
  const { owner, pid } = await setup();
  await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: 'Việc trễ', deadline: '2020-01-01' } });

  const cmp = await call('POST', `/projects/${pid}/ai/compare`, { token: owner.token, body: {} });
  assert.equal(cmp.status, 200);
  assert.deepEqual(cmp.data.runs.map((r) => r.variant), ['v1_basic', 'v2_schema', 'v3_final']);
  assert.ok(cmp.data.runs.every((r) => r.metrics && typeof r.metrics.json_ok === 'boolean'));

  const one = await call('POST', `/projects/${pid}/ai/run`, { token: owner.token, body: { variant: 'v2_schema' } });
  assert.equal(one.status, 200);
  assert.equal(one.data.variant, 'v2_schema');

  assert.equal((await call('POST', `/projects/${pid}/ai/run`, { token: owner.token, body: {} })).status, 400);
  assert.equal((await call('POST', `/projects/${pid}/ai/run`, { token: owner.token, body: { variant: 'v9' } })).status, 400);
});

test('F11: kiểm tra đầu vào và xử lý lỗi', async () => {
  const { owner, pid, memberA } = await setup();
  assert.equal((await call('GET', '/projects/abc', { token: owner.token })).status, 400);
  assert.equal((await call('POST', '/projects', { token: owner.token, raw: '{bad json' })).status, 400);
  assert.equal((await call('GET', '/khong-ton-tai', { token: owner.token })).status, 404);
  assert.equal(
    (await call('POST', '/projects', { token: owner.token, body: { name: 'x', start_date: '2026-05-01', end_date: '2026-01-01' } })).status,
    400
  );
  assert.equal((await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: '   ' } })).status, 400);
  // Người phụ trách phải thuộc dự án
  const outsider = await newUser('Ngoài');
  assert.equal(
    (await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: 'x', assignee_id: outsider.id } })).status,
    400
  );
  assert.equal(memberA.id > 0, true);
});

test('F12: xóa dự án', async () => {
  const { owner, pid, memberA } = await setup();
  assert.equal((await call('DELETE', `/projects/${pid}`, { token: memberA.token })).status, 403);
  assert.equal((await call('DELETE', `/projects/${pid}`, { token: owner.token })).status, 200);
  assert.equal((await call('GET', `/projects/${pid}`, { token: owner.token })).status, 403);
});


test('F13: tài khoản thành viên (role: member) bị chặn tạo dự án (403) và không được thêm/sửa/xóa trong dự án', async () => {
  const memReg = await call('POST', '/auth/register', {
    body: { name: 'Thành viên Test', email: `mem_${Date.now()}@test.local`, password: '123456', role: 'member' }
  });
  assert.equal(memReg.status, 201);
  const memToken = memReg.data.token;
  const memId = memReg.data.user.id;
  assert.equal(memReg.data.user.role, 'member');

  // 1. Chặn tạo dự án
  const createProj = await call('POST', '/projects', {
    token: memToken,
    body: { name: 'Dự án của member' }
  });
  assert.equal(createProj.status, 403);

  // 2. Thêm vào dự án của quản lý
  const { owner, pid } = await setup();
  await call('POST', `/projects/${pid}/members`, { token: owner.token, body: { email: memReg.data.user.email, role: 'member' } });

  // 3. Chặn thêm nhiệm vụ
  const addTask = await call('POST', `/projects/${pid}/tasks`, {
    token: memToken,
    body: { title: 'Member cố thêm việc' }
  });
  assert.equal(addTask.status, 403);

  // 4. Quản lý tạo việc và giao cho member
  const taskCreated = await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc quản lý giao', assignee_id: memId }
  });
  const taskId = taskCreated.data.id;

  // 5. Member sửa thông tin chi tiết nhiệm vụ (tiêu đề, hạn chót,...) -> bị chặn 403
  const editTaskDetails = await call('PUT', `/tasks/${taskId}`, {
    token: memToken,
    body: { title: 'Member cố đổi tên việc' }
  });
  assert.equal(editTaskDetails.status, 403);

  // 6. Member cập nhật trạng thái việc của mình -> được phép
  const updateStatus = await call('PUT', `/tasks/${taskId}`, {
    token: memToken,
    body: { status: 'doing' }
  });
  assert.equal(updateStatus.status, 200);
  assert.equal(updateStatus.data.status, 'doing');

  // 7. Member xóa nhiệm vụ -> bị chặn 403
  const deleteTask = await call('DELETE', `/tasks/${taskId}`, {
    token: memToken
  });
  assert.equal(deleteTask.status, 403);

  // 8. Member xóa dự án -> bị chặn 403
  const deleteProj = await call('DELETE', `/projects/${pid}`, {
    token: memToken
  });
  assert.equal(deleteProj.status, 403);

  // 9. Quản lý phân quyền nâng vai trò của member lên "Chủ dự án" (manager)
  const promote = await call('PUT', `/projects/${pid}/members/${memId}`, {
    token: owner.token,
    body: { role: 'manager' }
  });
  assert.equal(promote.status, 200);

  // 10. Sau khi lên Chủ dự án, có toàn quyền thêm, sửa, xóa trong dự án như trưởng nhóm:
  // a) Thêm nhiệm vụ mới thành công
  const addTaskAsMgr = await call('POST', `/projects/${pid}/tasks`, {
    token: memToken,
    body: { title: 'Nhiệm vụ do Chủ dự án mới tạo', priority: 'high', deadline: '2099-01-01' }
  });
  assert.equal(addTaskAsMgr.status, 201);
  const newTaskId = addTaskAsMgr.data.id;

  // b) Sửa chi tiết nhiệm vụ thành công
  const editTaskAsMgr = await call('PUT', `/tasks/${newTaskId}`, {
    token: memToken,
    body: { title: 'Nhiệm vụ đã được Chủ dự án sửa lại', priority: 'low' }
  });
  assert.equal(editTaskAsMgr.status, 200);
  assert.equal(editTaskAsMgr.data.title, 'Nhiệm vụ đã được Chủ dự án sửa lại');

  // c) Sửa thông tin dự án thành công
  const editProjAsMgr = await call('PUT', `/projects/${pid}`, {
    token: memToken,
    body: { name: 'Dự án đã được Chủ dự án cập nhật' }
  });
  assert.equal(editProjAsMgr.status, 200);

  // d) Xóa nhiệm vụ thành công
  const deleteTaskAsMgr = await call('DELETE', `/tasks/${newTaskId}`, {
    token: memToken
  });
  assert.equal(deleteTaskAsMgr.status, 200);
});
