process.env.AI_PROVIDER = 'offline';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-rep-${Date.now()}.db`);

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

async function call(method, path, { token, body, rawRes } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (rawRes) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer: buf, text: buf.toString('utf8'), headers: res.headers };
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

let seq = 0;
async function newUser(name = 'Thử nghiệm') {
  const email = `rep${Date.now()}${seq++}@test.local`;
  const r = await call('POST', '/auth/register', { body: { name, email, password: '123456' } });
  return { token: r.data.token, id: r.data.user.id, email, name };
}

async function setupProject() {
  const owner = await newUser('Chủ dự án');
  const alice = await newUser('Alice');
  const bob = await newUser('Bob');
  const p = await call('POST', '/projects', {
    token: owner.token,
    body: { name: 'Dự án Báo cáo & Thống kê', start_date: '2026-01-01', end_date: '2026-12-31' },
  });
  const pid = p.data.id;
  await call('POST', `/projects/${pid}/members`, { token: owner.token, body: { email: alice.email, role: 'member' } });
  await call('POST', `/projects/${pid}/members`, { token: owner.token, body: { email: bob.email, role: 'member' } });

  // Tạo các nhiệm vụ với trạng thái và hạn khác nhau
  // 1. Hoàn thành
  await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc 1 (xong)', assignee_id: alice.id, status: 'done', deadline: '2026-02-01' },
  });
  // 2. Quá hạn
  await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc 2 (quá hạn)', assignee_id: alice.id, status: 'doing', deadline: '2020-01-01' },
  });
  // 3. Đang làm còn hạn
  await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc 3 (đang làm)', assignee_id: bob.id, status: 'doing', deadline: '2099-05-01' },
  });
  // 4. Chưa làm còn hạn
  await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc 4 (chưa làm)', assignee_id: bob.id, status: 'todo', deadline: '2099-06-01' },
  });

  return { owner, alice, bob, pid };
}

test('R1: Thống kê tỷ lệ hoàn thành dự án, số việc hoàn thành và quá hạn', async () => {
  const { owner, pid } = await setupProject();
  const res = await call('GET', `/projects/${pid}/stats`, { token: owner.token });
  assert.equal(res.status, 200);
  assert.equal(res.data.total, 4);
  assert.equal(res.data.done, 1);
  assert.equal(res.data.overdue, 1);
  assert.equal(res.data.progress, 25); // 1/4 = 25%
  assert.equal(res.data.byStatus.done, 1);
  assert.equal(res.data.byStatus.doing, 2);
  assert.equal(res.data.byStatus.todo, 1);
});

test('R2: Biểu đồ hiệu suất và khối lượng theo từng thành viên', async () => {
  const { owner, pid, alice, bob } = await setupProject();
  const res = await call('GET', `/projects/${pid}/stats`, { token: owner.token });
  assert.equal(res.status, 200);

  const a = res.data.byMember.find((m) => m.id === alice.id);
  assert.ok(a);
  assert.equal(a.total, 2);
  assert.equal(a.done, 1);
  assert.equal(a.open, 1);
  assert.equal(a.overdue, 1);
  assert.equal(a.completion_rate, 50); // 1/2 = 50%
  assert.equal(a.performance_grade, 'Cần chú ý'); // vì có 1 việc quá hạn

  const b = res.data.byMember.find((m) => m.id === bob.id);
  assert.ok(b);
  assert.equal(b.total, 2);
  assert.equal(b.done, 0);
  assert.equal(b.completion_rate, 0);
});

test('R3: Báo cáo tiến độ phân bổ theo tuần hoặc tháng', async () => {
  const { owner, pid } = await setupProject();
  const res = await call('GET', `/projects/${pid}/stats`, { token: owner.token });
  assert.equal(res.status, 200);
  assert.ok(res.data.byPeriod);
  assert.ok(Array.isArray(res.data.byPeriod.month));
  assert.ok(Array.isArray(res.data.byPeriod.week));
  assert.ok(res.data.byPeriod.month.length > 0);

  const rep = await call('GET', `/projects/${pid}/report`, { token: owner.token });
  assert.equal(rep.status, 200);
  assert.equal(rep.data.summary.total, 4);
  assert.equal(rep.data.summary.done, 1);
  assert.equal(rep.data.summary.progress, 25);
  assert.ok(Array.isArray(rep.data.tasks));
});

test('R4: Xuất báo cáo Excel (CSV) với UTF-8 BOM và đầy đủ nội dung', async () => {
  const { owner, pid } = await setupProject();
  const res = await call('GET', `/projects/${pid}/export/csv`, { token: owner.token, rawRes: true });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/csv'));
  assert.ok(res.headers.get('content-disposition').includes(`bao-cao-du-an-${pid}.csv`));

  // Kiểm tra 3 byte đầu tiên là UTF-8 BOM (0xEF, 0xBB, 0xBF)
  assert.equal(res.buffer[0], 0xef);
  assert.equal(res.buffer[1], 0xbb);
  assert.equal(res.buffer[2], 0xbf);

  const text = res.text;
  assert.ok(text.includes('BÁO CÁO TIẾN ĐỘ VÀ THỐNG KÊ DỰ ÁN'));
  assert.ok(text.includes('Tỷ lệ hoàn thành dự án:,25%'));
  assert.ok(text.includes('HIỆU SUẤT VÀ KHỐI LƯỢNG THEO THÀNH VIÊN'));
  assert.ok(text.includes('DANH SÁCH CHI TIẾT CÔNG VIỆC'));
  assert.ok(text.includes('Việc 1 (xong)'));
  assert.ok(text.includes('Quá hạn'));
});

test('R5: Người ngoài dự án không được xem báo cáo hoặc xuất dữ liệu (403)', async () => {
  const { pid } = await setupProject();
  const outsider = await newUser('Người ngoài');
  assert.equal((await call('GET', `/projects/${pid}/stats`, { token: outsider.token })).status, 403);
  assert.equal((await call('GET', `/projects/${pid}/report`, { token: outsider.token })).status, 403);
  assert.equal((await call('GET', `/projects/${pid}/export/csv`, { token: outsider.token })).status, 403);
});
