const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND instr(email, '@') > 1),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  start_date TEXT CHECK (start_date IS NULL OR start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date TEXT CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('manager', 'member')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  deadline TEXT CHECK (deadline IS NULL OR deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chỉ mục cho các truy vấn thường dùng
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, id);
CREATE INDEX IF NOT EXISTS idx_ai_logs_project ON ai_logs(project_id);

-- Trigger giữ tính nhất quán: người phụ trách phải là thành viên của dự án
CREATE TRIGGER IF NOT EXISTS trg_tasks_assignee_insert BEFORE INSERT ON tasks
WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_members WHERE project_id = NEW.project_id AND user_id = NEW.assignee_id)
BEGIN
  SELECT RAISE(ABORT, 'Người phụ trách không thuộc dự án');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_assignee_update BEFORE UPDATE OF assignee_id, project_id ON tasks
WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_members WHERE project_id = NEW.project_id AND user_id = NEW.assignee_id)
BEGIN
  SELECT RAISE(ABORT, 'Người phụ trách không thuộc dự án');
END;

-- Khi xóa thành viên khỏi dự án, bỏ gán họ khỏi các nhiệm vụ của dự án đó
CREATE TRIGGER IF NOT EXISTS trg_members_unassign AFTER DELETE ON project_members
BEGIN
  UPDATE tasks SET assignee_id = NULL WHERE project_id = OLD.project_id AND assignee_id = OLD.user_id;
END;
`);

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function seed() {
  const hash = bcrypt.hashSync('123456', 10);
  const addUser = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)');
  const addMember = db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
  const addTask = db.prepare(
    'INSERT INTO tasks (project_id, title, description, assignee_id, priority, status, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const addProject = db.prepare('INSERT INTO projects (name, description, start_date, end_date) VALUES (?, ?, ?, ?)');

  db.transaction(() => {
    const manager = Number(addUser.run('Trưởng nhóm (demo)', 'manager@demo.com', hash).lastInsertRowid);
    const alice = Number(addUser.run('Thành viên A', 'a@demo.com', hash).lastInsertRowid);
    const bob = Number(addUser.run('Thành viên B', 'b@demo.com', hash).lastInsertRowid);

    const projectId = Number(
      addProject.run('Đồ án môn học - Hệ thống quản lý dự án', 'Dự án mẫu dùng để demo tính năng.', day(-20), day(40))
        .lastInsertRowid
    );
    addMember.run(projectId, manager, 'manager');
    addMember.run(projectId, alice, 'member');
    addMember.run(projectId, bob, 'member');

    const tasks = [
      ['Phân tích yêu cầu', 'Xác định chức năng và phi chức năng', manager, 'high', 'done', day(-10)],
      ['Thiết kế cơ sở dữ liệu', 'Vẽ ERD và định nghĩa bảng', alice, 'high', 'done', day(-5)],
      ['Thiết kế giao diện', 'Wireframe các màn hình chính', bob, 'medium', 'doing', day(2)],
      ['Xây dựng API xác thực', 'Đăng ký, đăng nhập, phân quyền bằng JWT', alice, 'high', 'doing', day(-1)],
      ['Tích hợp trợ lý AI', 'Gọi API AI với dữ liệu dự án', manager, 'high', 'todo', day(7)],
      ['Viết báo cáo', 'Hoàn thiện báo cáo chương 1 đến 4', null, 'medium', 'todo', day(14)],
      ['Kiểm thử chức năng', 'Kiểm thử các luồng chính và xử lý lỗi', bob, 'low', 'todo', day(20)],
    ];
    for (const t of tasks) addTask.run(projectId, t[0], t[1], t[2], t[3], t[4], t[5]);
  })();

  console.log('Đã tạo dữ liệu mẫu. Tài khoản demo: manager@demo.com / 123456');
}

if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) === 0) seed();

module.exports = db;