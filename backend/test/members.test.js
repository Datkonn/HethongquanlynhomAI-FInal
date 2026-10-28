process.env.AI_PROVIDER = 'offline';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-mem-${Date.now()}.db`);

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
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

let seq = 0;
async function newUser(name = 'Thử nghiệm') {
  const email = `mem${Date.now()}${seq++}@test.local`;
  const r = await call('POST', '/auth/register', { body: { name, email, password: '123456' } });
  return { token: r.data.token, id: r.data.user.id, email, name };
}
async function newProject(owner) {
  const r = await call('POST', '/projects', { token: owner.token, body: { name: 'Dự án thành viên' } });
  return r.data.id;
}
async function invite(pid, by, email, role = 'member') {
  return call('POST', `/projects/${pid}/invitations`, { token: by.token, body: { email, role } });
}
async function joinVia(pid, owner, user, role = 'member') {
  const inv = await invite(pid, owner, user.email, role);
  await call('POST', `/invitations/${inv.data.id}/accept`, { token: user.token });
  return inv.data.id;
}

test('M1: lời mời phải được chấp nhận mới trở thành thành viên', async () => {
  const owner = await newUser('Chủ');
  const guest = await newUser('Khách');
  const pid = await newProject(owner);
  const inv = await invite(pid, owner, guest.email);
  assert.equal(inv.status, 201);
  const mine = await call('GET', '/invitations/mine', { token: guest.token });
  assert.ok(mine.data.some((x) => x.id === inv.data.id));
  let p = await call('GET', `/projects/${pid}`, { token: owner.token });
  assert.ok(!p.data.members.some((m) => m.id === guest.id));
  assert.equal((await call('POST', `/invitations/${inv.data.id}/accept`, { token: guest.token })).status, 200);
  p = await call('GET', `/projects/${pid}`, { token: owner.token });
  assert.ok(p.data.members.some((m) => m.id === guest.id && m.role === 'member'));
});

test('M2: thành viên không được mời người khác', async () => {
  const owner = await newUser();
  const mem = await newUser();
  const pid = await newProject(owner);
  await joinVia(pid, owner, mem);
  assert.equal((await invite(pid, mem, 'nguoi-la@test.local')).status, 403);
});

test('M3: chỉ chủ sở hữu mới trao được vai trò Chủ dự án', async () => {
  const owner = await newUser();
  const mgr = await newUser();
  const mem = await newUser();
  const pid = await newProject(owner);
  await joinVia(pid, owner, mgr);
  await joinVia(pid, owner, mem);
  const up = await call('PUT', `/projects/${pid}/members/${mgr.id}`, { token: owner.token, body: { role: 'manager' } });
  assert.equal(up.status, 200);
  const deny = await call('PUT', `/projects/${pid}/members/${mem.id}`, { token: mgr.token, body: { role: 'manager' } });
  assert.equal(deny.status, 403);
  const demoteOwner = await call('PUT', `/projects/${pid}/members/${owner.id}`, { token: mgr.token, body: { role: 'member' } });
  assert.equal(demoteOwner.status, 400);
});

test('M4: không ai xóa được chủ sở hữu, kể cả chủ sở hữu tự rời', async () => {
  const owner = await newUser();
  const mgr = await newUser();
  const pid = await newProject(owner);
  await joinVia(pid, owner, mgr, 'manager');
  assert.equal((await call('DELETE', `/projects/${pid}/members/${owner.id}`, { token: mgr.token })).status, 400);
  assert.equal((await call('DELETE', `/projects/${pid}/members/${owner.id}`, { token: owner.token })).status, 400);
});

test('M5: thành viên tự rời dự án được và mất quyền truy cập', async () => {
  const owner = await newUser();
  const mem = await newUser();
  const pid = await newProject(owner);
  await joinVia(pid, owner, mem);
  assert.equal((await call('DELETE', `/projects/${pid}/members/${mem.id}`, { token: mem.token })).status, 200);
  assert.equal((await call('GET', `/projects/${pid}`, { token: mem.token })).status, 403);
});

test('M6: chỉ chủ sở hữu mới xóa được dự án', async () => {
  const owner = await newUser();
  const mgr = await newUser();
  const pid = await newProject(owner);
  await joinVia(pid, owner, mgr, 'manager');
  assert.equal((await call('DELETE', `/projects/${pid}`, { token: mgr.token })).status, 403);
  assert.equal((await call('DELETE', `/projects/${pid}`, { token: owner.token })).status, 200);
});

test('M7: xem danh sách công việc của từng thành viên', async () => {
  const owner = await newUser();
  const mem = await newUser();
  const pid = await newProject(owner);
  await joinVia(pid, owner, mem);
  await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: 'Việc của A', assignee_id: mem.id } });
  await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: 'Việc của chủ', assignee_id: owner.id } });
  const r = await call('GET', `/projects/${pid}/members/${mem.id}/tasks`, { token: owner.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.tasks.map((t) => t.title), ['Việc của A']);
});

test('M8: khối lượng công việc và cờ quá tải theo ngưỡng', async () => {
  const owner = await newUser();
  const mem = await newUser();
  const pid = await newProject(owner);
  await joinVia(pid, owner, mem);
  for (let i = 0; i < 3; i++) {
    await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body: { title: `Việc ${i}`, assignee_id: mem.id } });
  }
  const r = await call('GET', `/projects/${pid}/workload`, { token: owner.token });
  assert.equal(r.status, 200);
  const m = r.data.members.find((x) => x.id === mem.id);
  assert.equal(m.open, 3);
  assert.equal(m.overloaded, true);
  assert.equal(m.share, 100);
  assert.equal(r.data.total_open, 3);
});

test('M9: lời mời chỉ dành cho đúng email, không gửi trùng, từ chối rồi không chấp nhận lại', async () => {
  const owner = await newUser();
  const guest = await newUser();
  const other = await newUser();
  const pid = await newProject(owner);
  const inv = await invite(pid, owner, guest.email);
  assert.equal((await call('POST', `/invitations/${inv.data.id}/accept`, { token: other.token })).status, 403);
  assert.equal((await invite(pid, owner, guest.email)).status, 409);
  assert.equal((await call('POST', `/invitations/${inv.data.id}/decline`, { token: guest.token })).status, 200);
  assert.equal((await call('POST', `/invitations/${inv.data.id}/accept`, { token: guest.token })).status, 400);
});

test('M10: hủy lời mời, và không mời người đã là thành viên', async () => {
  const owner = await newUser();
  const mem = await newUser();
  const guest = await newUser();
  const pid = await newProject(owner);
  await joinVia(pid, owner, mem);
  assert.equal((await invite(pid, owner, mem.email)).status, 409);
  const inv = await invite(pid, owner, guest.email);
  assert.equal((await call('DELETE', `/projects/${pid}/invitations/${inv.data.id}`, { token: owner.token })).status, 200);
  assert.equal((await call('POST', `/invitations/${inv.data.id}/accept`, { token: guest.token })).status, 400);
}); 