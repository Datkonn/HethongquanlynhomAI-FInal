process.env.AI_PROVIDER = 'offline';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-notify-${Date.now()}.db`);

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
  const email = `nt${Date.now()}${seq++}@test.local`;
  const r = await call('POST', '/auth/register', { body: { name, email, password: '123456' } });
  return { token: r.data.token, id: r.data.user.id, email, name };
}
async function newProject(owner) {
  const r = await call('POST', '/projects', { token: owner.token, body: { name: 'Dự án thông báo' } });
  return r.data.id;
}
async function joinVia(pid, owner, user) {
  const inv = await call('POST', `/projects/${pid}/invitations`, {
    token: owner.token,
    body: { email: user.email, role: 'member' },
  });
  await call('POST', `/invitations/${inv.data.id}/accept`, { token: user.token });
}
async function setup() {
  const owner = await newUser('Chủ');
  const mem = await newUser('Thành viên');
  const pid = await newProject(owner);
  await joinVia(pid, owner, mem);
  return { owner, mem, pid };
}
async function makeTask(owner, pid, body) {
  const r = await call('POST', `/projects/${pid}/tasks`, { token: owner.token, body });
  return r.data;
}
async function notifs(u) {
  return call('GET', '/notifications?limit=100', { token: u.token });
}
const kinds = (r) => r.data.items.map((n) => n.type);

test('N1: giao việc thì người được giao nhận thông báo, người giao không nhận', async () => {
  const { owner, mem, pid } = await setup();
  await makeTask(owner, pid, { title: 'Việc A', assignee_id: mem.id });
  const m = await notifs(mem);
  assert.ok(m.data.items.some((n) => n.type === 'assigned' && n.message.includes('Việc A')));
  assert.ok(!kinds(await notifs(owner)).includes('assigned'));
});

test('N2: đổi trạng thái thì chủ dự án được báo, người tự đổi không nhận', async () => {
  const { owner, mem, pid } = await setup();
  const t = await makeTask(owner, pid, { title: 'Việc B', assignee_id: mem.id });
  await call('PUT', `/tasks/${t.id}`, { token: mem.token, body: { status: 'doing' } });
  const o = await notifs(owner);
  assert.ok(o.data.items.some((n) => n.type === 'status' && n.message.includes('Đang thực hiện')));
  assert.ok(!kinds(await notifs(mem)).includes('status'));
});

test('N3: bình luận thông báo cho người liên quan, tác giả không nhận, thứ tự đúng', async () => {
  const { owner, mem, pid } = await setup();
  const t = await makeTask(owner, pid, { title: 'Việc C', assignee_id: mem.id });
  await call('POST', `/tasks/${t.id}/comments`, { token: owner.token, body: { body: 'Xem giúp deadline nhé' } });
  await call('POST', `/tasks/${t.id}/comments`, { token: mem.token, body: { body: 'Đã xem' } });
  assert.ok(kinds(await notifs(mem)).includes('comment'));
  assert.ok(kinds(await notifs(owner)).includes('comment'));
  const list = await call('GET', `/tasks/${t.id}/comments`, { token: owner.token });
  assert.deepEqual(list.data.map((c) => c.body), ['Xem giúp deadline nhé', 'Đã xem']);
});

test('N4: người ngoài dự án không xem và không bình luận được', async () => {
  const { owner, pid } = await setup();
  const t = await makeTask(owner, pid, { title: 'Việc D' });
  const out = await newUser();
  assert.equal((await call('GET', `/tasks/${t.id}/comments`, { token: out.token })).status, 403);
  assert.equal((await call('POST', `/tasks/${t.id}/comments`, { token: out.token, body: { body: 'x' } })).status, 403);
});

test('N5: nhắc hạn sắp đến cho người được giao, mỗi việc mỗi ngày chỉ nhắc một lần', async () => {
  const { owner, mem, pid } = await setup();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await makeTask(owner, pid, { title: 'Việc sắp hết hạn', assignee_id: mem.id, deadline: tomorrow });
  const r1 = await notifs(mem);
  assert.ok(r1.data.items.some((n) => n.type === 'deadline' && n.message.includes('Sắp đến hạn')));
  const r2 = await notifs(mem);
  assert.equal(r2.data.items.filter((n) => n.type === 'deadline').length, 1);
});

test('N6: việc đã quá hạn được nhắc với nội dung quá hạn', async () => {
  const { owner, mem, pid } = await setup();
  await makeTask(owner, pid, { title: 'Việc trễ', assignee_id: mem.id, deadline: '2020-01-01' });
  const m = await notifs(mem);
  assert.ok(m.data.items.some((n) => n.type === 'deadline' && n.message.includes('Đã quá hạn')));
});

test('N7: đánh dấu đã đọc; người khác không đánh dấu được thông báo của mình', async () => {
  const { owner, mem, pid } = await setup();
  const other = await newUser();
  await makeTask(owner, pid, { title: 'Việc đọc', assignee_id: mem.id });
  const first = await notifs(mem);
  assert.ok(first.data.unread_count >= 1);
  const id = first.data.items[0].id;
  const stolen = await call('POST', `/notifications/${id}/read`, { token: other.token });
  assert.equal(stolen.data.changed, 0);
  const own = await call('POST', `/notifications/${id}/read`, { token: mem.token });
  assert.equal(own.data.changed, 1);
  await call('POST', '/notifications/read-all', { token: mem.token });
  assert.equal((await notifs(mem)).data.unread_count, 0);
});

test('N8: lịch sử theo từng công việc chỉ liệt kê hoạt động của công việc đó', async () => {
  const { owner, mem, pid } = await setup();
  const a = await makeTask(owner, pid, { title: 'Việc lịch sử A' });
  await makeTask(owner, pid, { title: 'Việc lịch sử B' });
  await call('POST', `/tasks/${a.id}/comments`, { token: mem.token, body: { body: 'Đang làm' } });
  const h = await call('GET', `/projects/${pid}/activity?task_id=${a.id}&limit=100`, { token: owner.token });
  assert.equal(h.status, 200);
  assert.ok(h.data.length >= 2);
  assert.ok(h.data.every((x) => x.task_id === a.id));
});

test('N9: xóa bình luận đúng quyền: tác giả xóa được của mình, thành viên khác không, quản lý xóa được', async () => {
  const { owner, mem, pid } = await setup();
  const t = await makeTask(owner, pid, { title: 'Việc xóa bình luận', assignee_id: mem.id });
  const c1 = await call('POST', `/tasks/${t.id}/comments`, { token: owner.token, body: { body: 'Của chủ' } });
  const c2 = await call('POST', `/tasks/${t.id}/comments`, { token: mem.token, body: { body: 'Của thành viên' } });
  assert.equal((await call('DELETE', `/comments/${c1.data.id}`, { token: mem.token })).status, 403);
  assert.equal((await call('DELETE', `/comments/${c2.data.id}`, { token: mem.token })).status, 200);
  assert.equal((await call('DELETE', `/comments/${c1.data.id}`, { token: owner.token })).status, 200);
});

test('N10: lịch sử dự án phân trang bằng before', async () => {
  const { owner, pid } = await setup();
  for (let i = 0; i < 4; i++) await makeTask(owner, pid, { title: `Việc phân trang ${i}` });
  const p1 = await call('GET', `/projects/${pid}/activity?limit=2`, { token: owner.token });
  assert.equal(p1.data.length, 2);
  const last = p1.data[p1.data.length - 1].id;
  const p2 = await call('GET', `/projects/${pid}/activity?limit=2&before=${last}`, { token: owner.token });
  assert.equal(p2.data.length, 2);
  assert.ok(p2.data.every((x) => x.id < last));
});