process.env.AI_PROVIDER = 'offline';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-dash-${Date.now()}.db`);

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

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

let seq = 0;
async function newUser(name = 'Người dùng') {
  const email = `dash_${Date.now()}_${seq++}@test.local`;
  const r = await call('POST', '/auth/register', { body: { name, email, password: 'password123' } });
  return { token: r.data.token, id: r.data.user.id, email, name };
}

test('Dashboard: yêu cầu đăng nhập (401 khi không có token)', async () => {
  const res = await call('GET', '/dashboard');
  assert.equal(res.status, 401);
});

test('Dashboard: người dùng mới chưa có dự án', async () => {
  const u = await newUser('Mới toanh');
  const res = await call('GET', '/dashboard', { token: u.token });
  assert.equal(res.status, 200);
  assert.equal(res.data.overview.total_projects, 0);
  assert.equal(res.data.overview.total_tasks, 0);
  assert.equal(res.data.overview.total_members, 0);
  assert.equal(res.data.overview.my_tasks, 0);
  assert.equal(res.data.task_stats.total, 0);
  assert.equal(res.data.projects.length, 0);
  assert.equal(res.data.upcoming_tasks.length, 0);
});

test('Dashboard: hiển thị tổng số dự án, công việc, thành viên, tiến độ và việc sắp đến hạn', async () => {
  const owner = await newUser('Trưởng dự án');
  const dev = await newUser('Lập trình viên');

  // Tạo dự án
  const pRes = await call('POST', '/projects', {
    token: owner.token,
    body: { name: 'Dự án Dashboard Alpha', start_date: '2026-01-01', end_date: '2026-12-31' },
  });
  assert.equal(pRes.status, 201);
  const pid = pRes.data.id;

  // Mời thành viên dev
  await call('POST', `/projects/${pid}/members`, {
    token: owner.token,
    body: { email: dev.email, role: 'member' },
  });

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const future = new Date(now.getTime() + 2 * 24 * 3600 * 1000);
  const futureStr = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}`;

  // 1 task done (giao cho dev)
  await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc đã xong', assignee_id: dev.id, status: 'done', deadline: todayStr },
  });

  // 1 task doing (giao cho owner, hạn hôm nay)
  await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc hôm nay', assignee_id: owner.id, status: 'doing', deadline: todayStr },
  });

  // 1 task todo (giao cho dev, quá hạn)
  await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc trễ hạn', assignee_id: dev.id, status: 'todo', deadline: '2020-01-01' },
  });

  // 1 task doing (giao cho owner, sắp đến hạn trong 2 ngày)
  await call('POST', `/projects/${pid}/tasks`, {
    token: owner.token,
    body: { title: 'Việc sắp đến hạn', assignee_id: owner.id, status: 'doing', deadline: futureStr },
  });

  // Kiểm tra Dashboard của owner
  const res = await call('GET', '/dashboard', { token: owner.token });
  assert.equal(res.status, 200);

  const { overview, task_stats, projects, upcoming_tasks } = res.data;

  // 1. Tổng quan
  assert.equal(overview.total_projects, 1);
  assert.equal(overview.total_tasks, 4);
  assert.equal(overview.total_members, 2); // owner + dev
  assert.equal(overview.my_tasks, 2); // 2 việc giao cho owner

  // 2. Thống kê công việc
  assert.equal(task_stats.total, 4);
  assert.equal(task_stats.done, 1);
  assert.equal(task_stats.doing, 2);
  assert.equal(task_stats.todo, 1);
  assert.equal(task_stats.overdue, 1); // việc trễ hạn 2020-01-01
  assert.equal(task_stats.progress, 25); // 1 / 4 = 25%

  // 3. Biểu đồ tiến độ dự án
  assert.equal(projects.length, 1);
  assert.equal(projects[0].task_count, 4);
  assert.equal(projects[0].done_count, 1);
  assert.equal(projects[0].progress, 25);

  // 4. Danh sách công việc sắp đến hạn (bao gồm quá hạn, hôm nay, và trong 7 ngày tới)
  // Việc đã done sẽ không nằm trong upcoming_tasks
  assert.ok(upcoming_tasks.length >= 3);
  const titles = upcoming_tasks.map((t) => t.title);
  assert.ok(titles.includes('Việc trễ hạn'));
  assert.ok(titles.includes('Việc hôm nay'));
  assert.ok(titles.includes('Việc sắp đến hạn'));
  assert.ok(!titles.includes('Việc đã xong'));

  const overdueTask = upcoming_tasks.find((t) => t.title === 'Việc trễ hạn');
  assert.equal(overdueTask.deadline_status, 'overdue');

  const todayTask = upcoming_tasks.find((t) => t.title === 'Việc hôm nay');
  assert.equal(todayTask.deadline_status, 'today');

  const upcomingTask = upcoming_tasks.find((t) => t.title === 'Việc sắp đến hạn');
  assert.equal(upcomingTask.deadline_status, 'upcoming');
});

