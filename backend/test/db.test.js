process.env.AI_PROVIDER = 'offline';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-db-${Date.now()}.db`);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');

const run = (sql, ...args) => db.prepare(sql).run(...args);
let seq = 0;
const newUser = () =>
  Number(run('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
    'Người dùng thử', `db${Date.now()}${seq++}@test.local`, 'hash').lastInsertRowid);

test('D1: dữ liệu mẫu được tạo và đúng ràng buộc tham chiếu', () => {
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(db.pragma('foreign_key_check').length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 7);
});

test('D2: từ chối tiêu đề rỗng', () => {
  assert.throws(() => run("INSERT INTO tasks (project_id, title) VALUES (1, '   ')"), /CHECK/);
});

test('D3: từ chối độ ưu tiên và trạng thái không hợp lệ', () => {
  assert.throws(() => run("INSERT INTO tasks (project_id, title, priority) VALUES (1, 'x', 'khẩn')"), /CHECK/);
  assert.throws(() => run("INSERT INTO tasks (project_id, title, status) VALUES (1, 'x', 'xong')"), /CHECK/);
});

test('D4: từ chối hạn sai định dạng', () => {
  assert.throws(() => run("INSERT INTO tasks (project_id, title, deadline) VALUES (1, 'x', '2026/01/01')"), /CHECK/);
});

test('D5: từ chối dự án có ngày kết thúc trước ngày bắt đầu', () => {
  assert.throws(
    () => run("INSERT INTO projects (name, start_date, end_date) VALUES ('x', '2026-05-01', '2026-01-01')"),
    /CHECK/
  );
});

test('D6: từ chối nhiệm vụ thuộc dự án không tồn tại', () => {
  assert.throws(() => run("INSERT INTO tasks (project_id, title) VALUES (999, 'x')"), /FOREIGN KEY/);
});

test('D7: trigger từ chối người phụ trách không thuộc dự án', () => {
  const outsider = newUser();
  assert.throws(
    () => run('INSERT INTO tasks (project_id, title, assignee_id) VALUES (1, ?, ?)', 'x', outsider),
    /không thuộc dự án/
  );
  assert.throws(
    () => run('UPDATE tasks SET assignee_id = ? WHERE id = 1', outsider),
    /không thuộc dự án/
  );
});

test('D8: xóa thành viên thì nhiệm vụ của họ được bỏ gán', () => {
  const u = newUser();
  run("INSERT INTO project_members (project_id, user_id, role) VALUES (1, ?, 'member')", u);
  const t = Number(run("INSERT INTO tasks (project_id, title, assignee_id) VALUES (1, 'Việc của u', ?)", u).lastInsertRowid);
  run('DELETE FROM project_members WHERE project_id = 1 AND user_id = ?', u);
  assert.equal(db.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get(t).assignee_id, null);
});

test('D9: xóa dự án thì xóa theo thành viên và nhiệm vụ', () => {
  const pid = Number(run("INSERT INTO projects (name) VALUES ('Dự án xóa')").lastInsertRowid);
  run("INSERT INTO tasks (project_id, title) VALUES (?, 'x')", pid);
  run('DELETE FROM projects WHERE id = ?', pid);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(pid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').get(pid).n, 0);
});

test('D10: sao lưu tạo ra file có thể đọc và đúng nội dung', async () => {
  const dest = require('path').join(require('os').tmpdir(), `pm-backup-${Date.now()}.db`);
  await db.backup(dest);
  const copy = new (require('better-sqlite3'))(dest, { fileMustExist: true });
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n);
  copy.close();
});