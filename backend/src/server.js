require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const ai = require('./ai');
const { securityHeaders } = require('./security'); 
const prompts = require('./prompts');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PRIORITIES = ['low', 'medium', 'high'];
const STATUSES = ['todo', 'doing', 'done'];
const PROJECT_STATUSES = ['active', 'closed'];
const MEMBER_ROLES = ['manager', 'member'];
const SORTS = {
  deadline: 'CASE WHEN t.deadline IS NULL THEN 1 ELSE 0 END, t.deadline ASC',
  priority: "CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.deadline ASC",
  newest: 't.id DESC',
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('Thiếu JWT_SECRET khi chạy ở chế độ production');
}

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(cors({ origin: false })); // đóng CORS: giao diện và API cùng một nguồn nên không cần
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

// ---------- Helpers ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const body = (req) => req.body || {};
// Đọc biến thể prompt từ yêu cầu, không hợp lệ thì báo lỗi 400
function pickVariant(req) {
  const v = body(req).variant;
  if (v === undefined || v === '') return undefined;
  if (!Object.hasOwn(prompts.VARIANTS, v)) throw httpError(400, 'Biến thể prompt không hợp lệ');
  return v;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function toId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'ID không hợp lệ');
  return n;
}
function requireText(v, name, max = 200) {
  if (typeof v !== 'string' || !v.trim()) throw httpError(400, `Thiếu ${name}`);
  if (v.trim().length > max) throw httpError(400, `${name} quá dài`);
  return v.trim();
}
function checkDate(v, name) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw httpError(400, `${name} phải có dạng YYYY-MM-DD`);
  }
  return v;
}
function signToken(user) {
  return jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return next(httpError(401, 'Chưa đăng nhập'));
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    next(httpError(401, 'Phiên đăng nhập đã hết hạn'));
  }
}
function membership(projectId, userId) {
  return db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);
}
function requireMember(req, projectId) {
  const m = membership(projectId, req.user.id);
  if (!m) throw httpError(403, 'Bạn không thuộc dự án này');
  return m;
}
function requireManager(req, projectId) {
  const m = requireMember(req, projectId);
  if (m.role !== 'manager') throw httpError(403, 'Chỉ quản lý dự án mới được thực hiện thao tác này');
  return m;
}
function getProject(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) throw httpError(404, 'Không tìm thấy dự án');
  return p;
}
function logActivity(projectId, userId, action, taskId = null) {
  db.prepare('INSERT INTO activity (project_id, user_id, action, task_id) VALUES (?, ?, ?, ?)').run(
    projectId,
    userId,
    action,
    taskId
  );
}
function withOverdue(task, t = today()) {
  return { ...task, overdue: !!(task.deadline && task.deadline < t && task.status !== 'done') };
}
function getTask(id) {
  const row = db
    .prepare('SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?')
    .get(id);
  return row ? withOverdue(row) : null;
}
function validateTask(b, projectId, current = {}) {
  const title = requireText(b.title !== undefined ? b.title : current.title, 'tên nhiệm vụ');
  const description = b.description !== undefined ? String(b.description || '').slice(0, 2000) : current.description || '';
  const priority = b.priority ?? current.priority ?? 'medium';
  const status = b.status ?? current.status ?? 'todo';
  if (!PRIORITIES.includes(priority)) throw httpError(400, 'Mức độ ưu tiên không hợp lệ');
  if (!STATUSES.includes(status)) throw httpError(400, 'Trạng thái không hợp lệ');
  const deadline = b.deadline !== undefined ? checkDate(b.deadline, 'Hạn hoàn thành') : current.deadline ?? null;

  let assignee_id = current.assignee_id ?? null;
  if (b.assignee_id !== undefined) {
    assignee_id = b.assignee_id === null || b.assignee_id === '' ? null : toId(b.assignee_id);
    if (assignee_id !== null && !membership(projectId, assignee_id)) {
      throw httpError(400, 'Người phụ trách không thuộc dự án');
    }
  }
  return { title, description, priority, status, deadline, assignee_id };
}

function buildContext(projectId) {
  const project = db
    .prepare('SELECT name, description, start_date, end_date, status FROM projects WHERE id = ?')
    .get(projectId);
  const members = db
    .prepare('SELECT u.id, u.name, pm.role FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ?')
    .all(projectId);
  const t = today();
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority, t.deadline, u.name AS assignee
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = ? ORDER BY ${SORTS.deadline}`
    )
    .all(projectId)
    .map((x) => withOverdue(x, t));
  const activity = db
    .prepare(
      `SELECT a.action, a.created_at, u.name AS user_name FROM activity a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.project_id = ? ORDER BY a.id DESC LIMIT 10`
    )
    .all(projectId);
  return { today: t, project, members, tasks, activity };
}

function buildUserContext(userId) {
  const t = today();
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.status, p.start_date, p.end_date
       FROM projects p JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?`
    )
    .all(userId);
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority, t.deadline, u.name AS assignee, p.name AS project_name
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)
       ORDER BY ${SORTS.deadline}`
    )
    .all(userId)
    .map((x) => withOverdue(x, t));
  const members = db
    .prepare(
      `SELECT DISTINCT u.id, u.name, 'member' as role
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`
    )
    .all(userId);
  return {
    today: t,
    project: {
      name: 'Toàn bộ các dự án của bạn',
      description: projects.length ? `Gồm ${projects.length} dự án: ` + projects.map((p) => p.name).join(', ') : 'Chưa có dự án nào',
      status: 'active',
    },
    members,
    tasks,
    activity: [],
  };
}

function saveAiLog(projectId, userId, kind, prompt, result) {
  const mode = `${result.mode}/${result.provider || '-'}/${result.prompt_version || '-'}`;
  db.prepare('INSERT INTO ai_logs (project_id, user_id, kind, prompt, response, mode) VALUES (?, ?, ?, ?, ?, ?)').run(
    projectId,
    userId,
    kind,
    prompt,
    JSON.stringify(result.result),
    mode
  );
}

// Giới hạn số lượt gọi trong một khoảng thời gian (lưu trong bộ nhớ)
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.user ? `u${req.user.id}` : `ip${req.ip}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return next(httpError(429, message));
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Bạn gửi quá nhiều yêu cầu AI, thử lại sau ít phút' });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Đăng nhập sai quá nhiều lần, thử lại sau 15 phút' });
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: 'Đăng ký quá nhiều tài khoản từ địa chỉ này, thử lại sau',
});
// ---------- Auth ----------
app.post(
  '/api/auth/register',
  registerLimiter,
  wrap(async (req, res) => {
    const b = body(req);
    const name = requireText(b.name, 'họ tên', 100);
    const email = requireText(b.email, 'email').toLowerCase();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Email không hợp lệ');
    if (typeof b.password !== 'string' || b.password.length < 6) throw httpError(400, 'Mật khẩu tối thiểu 6 ký tự');
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw httpError(409, 'Email đã được sử dụng');

    const hash = await bcrypt.hash(b.password, 10);
    const id = Number(
      db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, hash).lastInsertRowid
    );
    const user = { id, name, email };
    res.status(201).json({ token: signToken(user), user });
  })
);

app.post(
  '/api/auth/login',
  loginLimiter,
  wrap(async (req, res) => {
    const b = body(req);
    const email = requireText(b.email, 'email').toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = row && (await bcrypt.compare(String(b.password || ''), row.password_hash));
    if (!ok) throw httpError(401, 'Sai email hoặc mật khẩu');
    const user = { id: row.id, name: row.name, email: row.email };
    res.json({ token: signToken(user), user });
  })
);

app.get('/api/auth/me', auth, (req, res) => {
  const row = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.user.id);
  if (!row) throw httpError(401, 'Tài khoản không tồn tại');
  res.json(row);
});

// ---------- Dashboard – Trang tổng quan ----------
app.get('/api/dashboard', auth, (req, res) => {
  const t = today();
  const userId = req.user.id;

  // 1. Danh sách dự án kèm tiến độ và trạng thái công việc
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.status, p.start_date, p.end_date, pm.role AS my_role,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'doing') AS doing_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'todo') AS todo_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done' AND t.deadline < ?) AS overdue_count
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       ORDER BY p.id DESC`
    )
    .all(t, userId)
    .map((p) => ({
      ...p,
      progress: p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0,
    }));

  // 2. Tổng số thành viên tham gia các dự án của người dùng
  const memberCount = db
    .prepare(
      `SELECT COUNT(DISTINCT pm.user_id) AS total_members
       FROM project_members pm
       WHERE pm.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`
    )
    .get(userId).total_members;

  // 3. Thống kê công việc: hoàn thành, đang làm, quá hạn, và công việc cá nhân
  const taskStats = db
    .prepare(
      `SELECT
        COUNT(*) AS total_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'doing' THEN 1 ELSE 0 END), 0) AS doing_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END), 0) AS todo_tasks,
        COALESCE(SUM(CASE WHEN t.status != 'done' AND t.deadline < ? THEN 1 ELSE 0 END), 0) AS overdue_tasks,
        COALESCE(SUM(CASE WHEN t.assignee_id = ? THEN 1 ELSE 0 END), 0) AS my_tasks
       FROM tasks t
       WHERE t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`
    )
    .get(t, userId, userId);

  const totalTasks = taskStats.total_tasks || 0;
  const doneTasks = taskStats.done_tasks || 0;
  const overallProgress = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;

  // 4. Danh sách công việc sắp đến hạn (trong 7 ngày tới hoặc đã quá hạn)
  const upcomingTasks = db
    .prepare(
      `SELECT t.id, t.title, t.priority, t.status, t.deadline, t.project_id,
        p.name AS project_name, u.name AS assignee_name,
        CASE
          WHEN t.deadline < ? THEN 'overdue'
          WHEN t.deadline = ? THEN 'today'
          ELSE 'upcoming'
        END AS deadline_status
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)
         AND t.status != 'done'
         AND t.deadline IS NOT NULL
         AND t.deadline <= date(?, '+7 days')
       ORDER BY t.deadline ASC, t.id ASC
       LIMIT 15`
    )
    .all(t, t, userId, t);

  res.json({
    today: t,
    overview: {
      total_projects: projects.length,
      total_tasks: totalTasks,
      total_members: memberCount,
      my_tasks: taskStats.my_tasks || 0,
    },
    task_stats: {
      total: totalTasks,
      done: doneTasks,
      doing: taskStats.doing_tasks || 0,
      todo: taskStats.todo_tasks || 0,
      overdue: taskStats.overdue_tasks || 0,
      progress: overallProgress,
    },
    projects,
    upcoming_tasks: upcomingTasks,
  });
});

// ---------- Projects ----------
app.get('/api/projects', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, pm.role AS my_role,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       ORDER BY p.id DESC`
    )
    .all(req.user.id);
  res.json(rows);
});

app.post('/api/projects', auth, (req, res) => {
  const b = body(req);
  const name = requireText(b.name, 'tên dự án');
  const description = String(b.description || '').slice(0, 2000);
  const start = checkDate(b.start_date, 'Ngày bắt đầu');
  const end = checkDate(b.end_date, 'Ngày kết thúc');
  if (start && end && end < start) throw httpError(400, 'Ngày kết thúc phải sau ngày bắt đầu');

  const id = Number(
    db
      .prepare('INSERT INTO projects (name, description, start_date, end_date, owner_id) VALUES (?, ?, ?, ?, ?)')
      .run(name, description, start, end, req.user.id).lastInsertRowid
  );
  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'manager')").run(id, req.user.id);
  logActivity(id, req.user.id, `tạo dự án "${name}"`);
  res.status(201).json(getProject(id));
});
app.get('/api/projects/:id', auth, (req, res) => {
  const id = toId(req.params.id);
  const m = requireMember(req, id);
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, pm.role FROM project_members pm
       JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY pm.role, u.name`
    )
    .all(id);
  res.json({ ...getProject(id), my_role: m.role, members });
});

app.put('/api/projects/:id', auth, (req, res) => {
  const id = toId(req.params.id);
  requireManager(req, id);
  const cur = getProject(id);
  const b = body(req);
  const name = b.name !== undefined ? requireText(b.name, 'tên dự án') : cur.name;
  const description = b.description !== undefined ? String(b.description || '').slice(0, 2000) : cur.description;
  const start = b.start_date !== undefined ? checkDate(b.start_date, 'Ngày bắt đầu') : cur.start_date;
  const end = b.end_date !== undefined ? checkDate(b.end_date, 'Ngày kết thúc') : cur.end_date;
  const status = b.status ?? cur.status;
  if (!PROJECT_STATUSES.includes(status)) throw httpError(400, 'Trạng thái dự án không hợp lệ');
  if (start && end && end < start) throw httpError(400, 'Ngày kết thúc phải sau ngày bắt đầu');

  db.prepare('UPDATE projects SET name = ?, description = ?, start_date = ?, end_date = ?, status = ? WHERE id = ?').run(
    name,
    description,
    start,
    end,
    status,
    id
  );
  logActivity(id, req.user.id, 'cập nhật thông tin dự án');
  res.json(getProject(id));
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const id = toId(req.params.id);
  requireOwner(req, id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Members, invitations and permissions ----------
const ROLE_NAME = { manager: 'Chủ dự án', member: 'Thành viên' };
const INVITE_DAYS = 7;
const WORKLOAD_THRESHOLD = Number(process.env.WORKLOAD_THRESHOLD || 3);

// Chỉ chủ sở hữu (người tạo dự án) mới được xóa dự án, trao hoặc thu hồi vai trò Chủ dự án
function requireOwner(req, projectId) {
  requireManager(req, projectId);
  const p = getProject(projectId);
  if (p.owner_id !== req.user.id) throw httpError(403, 'Chỉ chủ sở hữu dự án mới được thực hiện thao tác này');
  return p;
}

function nowSql() {
  return db.prepare("SELECT datetime('now') AS now").get().now;
}

// Thêm trực tiếp người đã có tài khoản (giữ lại để tương thích với bộ kiểm thử)
app.post('/api/projects/:id/members', auth, (req, res) => {
  const id = toId(req.params.id);
  requireManager(req, id);
  const b = body(req);
  const email = requireText(b.email, 'email').toLowerCase();
  const role = b.role ?? 'member';
  if (!MEMBER_ROLES.includes(role)) throw httpError(400, 'Vai trò không hợp lệ');
  if (role === 'manager') requireOwner(req, id);
  const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (!user) throw httpError(404, 'Email này chưa đăng ký tài khoản');
  db.prepare(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(id, user.id, role);
  logActivity(id, req.user.id, `thêm ${user.name} với vai trò ${ROLE_NAME[role]}`);
  res.status(201).json({ ok: true });
});

// Mời qua email: người được mời phải tự chấp nhận
app.post('/api/projects/:id/invitations', auth, (req, res) => {
  const id = toId(req.params.id);
  requireManager(req, id);
  const b = body(req);
  const email = requireText(b.email, 'email').toLowerCase();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Email không hợp lệ');
  const role = b.role ?? 'member';
  if (!MEMBER_ROLES.includes(role)) throw httpError(400, 'Vai trò không hợp lệ');
  if (role === 'manager') requireOwner(req, id);
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (user && membership(id, user.id)) throw httpError(409, 'Người này đã là thành viên dự án');
  const pending = db
    .prepare("SELECT id FROM invitations WHERE project_id = ? AND email = ? AND status = 'pending' AND expires_at > ?")
    .get(id, email, nowSql());
  if (pending) throw httpError(409, 'Đã có lời mời đang chờ cho email này');
  const info = db
    .prepare("INSERT INTO invitations (project_id, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))")
    .run(id, email, role, req.user.id, `+${INVITE_DAYS} days`);
  logActivity(id, req.user.id, `mời ${email} với vai trò ${ROLE_NAME[role]}`);
  res.status(201).json({ id: Number(info.lastInsertRowid), email, role });
});

app.get('/api/projects/:id/invitations', auth, (req, res) => {
  const id = toId(req.params.id);
  requireManager(req, id);
  res.json(
    db
      .prepare(
        `SELECT i.id, i.email, i.role, i.expires_at, u.name AS invited_by_name
         FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
         WHERE i.project_id = ? AND i.status = 'pending' AND i.expires_at > ? ORDER BY i.id DESC`
      )
      .all(id, nowSql())
  );
});

app.delete('/api/projects/:id/invitations/:invId', auth, (req, res) => {
  const id = toId(req.params.id);
  const invId = toId(req.params.invId);
  requireManager(req, id);
  const r = db
    .prepare("UPDATE invitations SET status = 'cancelled' WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(invId, id);
  if (!r.changes) throw httpError(404, 'Không tìm thấy lời mời đang chờ');
  logActivity(id, req.user.id, 'hủy một lời mời');
  res.json({ ok: true });
});

app.get('/api/invitations/mine', auth, (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT i.id, i.role, i.expires_at, p.name AS project_name, u.name AS invited_by_name
         FROM invitations i
         JOIN projects p ON p.id = i.project_id
         LEFT JOIN users u ON u.id = i.invited_by
         WHERE i.email = ? AND i.status = 'pending' AND i.expires_at > ? ORDER BY i.id DESC`
      )
      .all(req.user.email, nowSql())
  );
});

function loadMyInvitation(req, invId) {
  const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(invId);
  if (!inv) throw httpError(404, 'Không tìm thấy lời mời');
  if (inv.email !== String(req.user.email).toLowerCase()) throw httpError(403, 'Lời mời này không dành cho bạn');
  if (inv.status !== 'pending' || inv.expires_at <= nowSql()) {
    throw httpError(400, 'Lời mời đã hết hạn hoặc đã được xử lý');
  }
  return inv;
}

app.post('/api/invitations/:id/accept', auth, (req, res) => {
  const inv = loadMyInvitation(req, toId(req.params.id));
  db.transaction(() => {
    db.prepare(
      `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`
    ).run(inv.project_id, req.user.id, inv.role);
    db.prepare("UPDATE invitations SET status = 'accepted' WHERE id = ?").run(inv.id);
  })();
  logActivity(inv.project_id, req.user.id, `tham gia dự án với vai trò ${ROLE_NAME[inv.role]}`);
  res.json({ ok: true, project_id: inv.project_id });
});

app.post('/api/invitations/:id/decline', auth, (req, res) => {
  const inv = loadMyInvitation(req, toId(req.params.id));
  db.prepare("UPDATE invitations SET status = 'declined' WHERE id = ?").run(inv.id);
  res.json({ ok: true });
});

// Đổi vai trò: chỉ chủ sở hữu được trao hoặc thu hồi vai trò Chủ dự án
app.put('/api/projects/:id/members/:userId', auth, (req, res) => {
  const id = toId(req.params.id);
  const userId = toId(req.params.userId);
  requireManager(req, id);
  const role = body(req).role;
  if (!MEMBER_ROLES.includes(role)) throw httpError(400, 'Vai trò không hợp lệ');
  const target = membership(id, userId);
  if (!target) throw httpError(404, 'Thành viên không có trong dự án');
  const p = getProject(id);
  if (userId === p.owner_id && role !== 'manager') throw httpError(400, 'Không thể hạ quyền chủ sở hữu dự án');
  if (target.role === 'manager' || role === 'manager') requireOwner(req, id);
  db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(role, id, userId);
  logActivity(id, req.user.id, `đổi vai trò của một thành viên thành ${ROLE_NAME[role]}`);
  res.json({ ok: true });
});

// Xóa thành viên, hoặc tự rời dự án (không cần quyền quản lý khi tự rời)
app.delete('/api/projects/:id/members/:userId', auth, (req, res) => {
  const id = toId(req.params.id);
  const userId = toId(req.params.userId);
  const self = userId === req.user.id;
  if (self) requireMember(req, id);
  else requireManager(req, id);
  const target = membership(id, userId);
  if (!target) throw httpError(404, 'Thành viên không có trong dự án');
  const p = getProject(id);
  if (userId === p.owner_id) throw httpError(400, 'Chủ sở hữu không thể rời hoặc bị xóa khỏi dự án');
  if (!self && target.role === 'manager') requireOwner(req, id);
  if (target.role === 'manager') {
    const n = db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'manager'").get(id).n;
    if (n <= 1) throw httpError(400, 'Dự án phải có ít nhất một chủ dự án');
  }
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, userId);
  logActivity(id, req.user.id, self ? 'rời khỏi dự án' : 'xóa một thành viên khỏi dự án');
  res.json({ ok: true });
});

// Danh sách công việc của một thành viên
app.get('/api/projects/:id/members/:userId/tasks', auth, (req, res) => {
  const id = toId(req.params.id);
  const userId = toId(req.params.userId);
  requireMember(req, id);
  const m = db
    .prepare(
      `SELECT u.name, pm.role FROM project_members pm
       JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? AND pm.user_id = ?`
    )
    .get(id, userId);
  if (!m) throw httpError(404, 'Thành viên không có trong dự án');
  const t = today();
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority, t.deadline FROM tasks t
       WHERE t.project_id = ? AND t.assignee_id = ? ORDER BY ${SORTS.deadline}`
    )
    .all(id, userId)
    .map((x) => withOverdue(x, t));
  res.json({ name: m.name, role: m.role, tasks });
});

// Khối lượng công việc của từng thành viên, có cờ quá tải theo ngưỡng
app.get('/api/projects/:id/workload', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const rows = db
    .prepare(
      `SELECT u.id, u.name, pm.role,
        COUNT(t.id) AS total,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END), 0) AS open,
        COALESCE(SUM(CASE WHEN t.status != 'done' AND t.deadline < ? THEN 1 ELSE 0 END), 0) AS overdue
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN tasks t ON t.assignee_id = u.id AND t.project_id = pm.project_id
       WHERE pm.project_id = ?
       GROUP BY u.id ORDER BY u.name`
    )
    .all(today(), id);
  const totalOpen = rows.reduce((s, r) => s + r.open, 0);
  res.json({
    threshold: WORKLOAD_THRESHOLD,
    total_open: totalOpen,
    members: rows.map((r) => ({
      ...r,
      share: totalOpen ? Math.round((r.open / totalOpen) * 100) : 0,
      overloaded: r.open >= WORKLOAD_THRESHOLD,
    })),
  });
});

// ---------- Tasks ----------
app.get('/api/projects/:id/tasks', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const q = req.query;
  const where = ['t.project_id = ?'];
  const params = [id];

  const keyword = String(q.q || '').trim();
  if (keyword) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (q.status) {
    if (!STATUSES.includes(q.status)) throw httpError(400, 'Trạng thái lọc không hợp lệ');
    where.push('t.status = ?');
    params.push(q.status);
  }
  if (q.priority) {
    if (!PRIORITIES.includes(q.priority)) throw httpError(400, 'Mức ưu tiên lọc không hợp lệ');
    where.push('t.priority = ?');
    params.push(q.priority);
  }
  if (q.assignee === 'none') {
    where.push('t.assignee_id IS NULL');
  } else if (q.assignee) {
    where.push('t.assignee_id = ?');
    params.push(toId(q.assignee));
  }

  const order = Object.hasOwn(SORTS, q.sort) ? SORTS[q.sort] : SORTS.deadline;
  const rows = db
    .prepare(
      `SELECT t.*, u.name AS assignee_name FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE ${where.join(' AND ')} ORDER BY ${order}`
    )
    .all(...params);
  const t = today();
  res.json(rows.map((r) => withOverdue(r, t)));
});

app.post('/api/projects/:id/tasks', auth, (req, res) => {
  const id = toId(req.params.id);
  requireManager(req, id);
  const v = validateTask(body(req), id);
  const info = db
    .prepare(
      'INSERT INTO tasks (project_id, title, description, assignee_id, priority, status, deadline) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, v.title, v.description, v.assignee_id, v.priority, v.status, v.deadline);
  const taskId = Number(info.lastInsertRowid);
  logActivity(id, req.user.id, `tạo nhiệm vụ "${v.title}"`, taskId);
  if (v.assignee_id) {
    notify([v.assignee_id], {
      projectId: id,
      taskId,
      type: 'assigned',
      message: `Bạn được giao nhiệm vụ "${v.title}"`,
      actorId: req.user.id,
    });
  }
  res.status(201).json(getTask(taskId));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const id = toId(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw httpError(404, 'Không tìm thấy nhiệm vụ');
  const m = requireMember(req, task.project_id);
  const b = body(req);

  if (m.role !== 'manager') {
    const onlyStatus = Object.keys(b).every((k) => k === 'status');
    if (!(onlyStatus && task.assignee_id === req.user.id)) {
      throw httpError(403, 'Bạn chỉ có thể cập nhật trạng thái nhiệm vụ được giao cho mình');
    }
  }

  const v = validateTask(b, task.project_id, task);
  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, priority = ?, status = ?, deadline = ?, assignee_id = ?,
     updated_at = datetime('now') WHERE id = ?`
  ).run(v.title, v.description, v.priority, v.status, v.deadline, v.assignee_id, id);

  const newAssignee = v.assignee_id && v.assignee_id !== task.assignee_id ? v.assignee_id : null;
  if (newAssignee) {
    notify([newAssignee], {
      projectId: task.project_id,
      taskId: id,
      type: 'assigned',
      message: `Bạn được giao nhiệm vụ "${v.title}"`,
      actorId: req.user.id,
    });
  }
  if (v.status !== task.status) {
    const owner = getProject(task.project_id).owner_id;
    notify([v.assignee_id, owner].filter((u) => u !== newAssignee), {
      projectId: task.project_id,
      taskId: id,
      type: 'status',
      message: `"${v.title}" chuyển sang ${STATUS_TEXT[v.status]}`,
      actorId: req.user.id,
    });
  }
  logActivity(task.project_id, req.user.id, `cập nhật "${v.title}" (trạng thái: ${v.status})`, id);
  res.json(getTask(id));
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const id = toId(req.params.id);
  const task = db.prepare('SELECT project_id, title FROM tasks WHERE id = ?').get(id);
  if (!task) throw httpError(404, 'Không tìm thấy nhiệm vụ');
  requireManager(req, task.project_id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  logActivity(task.project_id, req.user.id, `xóa nhiệm vụ "${task.title}"`);
  res.json({ ok: true });
});

// ---------- Stats, reports & activity ----------
function computeTimeline(tasks, t) {
  const monthMap = new Map();
  const weekMap = new Map();

  for (const task of tasks) {
    const dateStr = task.deadline || (task.created_at ? task.created_at.slice(0, 10) : t);
    // Nhóm theo tháng YYYY-MM
    const ym = dateStr.slice(0, 7);
    if (!monthMap.has(ym)) {
      const parts = ym.split('-');
      const label = parts.length === 2 ? `Tháng ${parts[1]}/${parts[0]}` : ym;
      monthMap.set(ym, {
        key: ym,
        label,
        total: 0,
        done: 0,
        doing: 0,
        todo: 0,
        overdue: 0,
      });
    }
    const mItem = monthMap.get(ym);
    mItem.total++;
    mItem[task.status] = (mItem[task.status] || 0) + 1;
    if (task.status !== 'done' && task.deadline && task.deadline < t) mItem.overdue++;

    // Nhóm theo tuần
    const d = new Date(dateStr + 'T00:00:00Z');
    if (!isNaN(d.getTime())) {
      const day = d.getUTCDay();
      const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
      const sun = new Date(Date.UTC(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate() + 6));
      const pad = (n) => String(n).padStart(2, '0');
      const wk = `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}`;
      const label = `Tuần (${pad(mon.getUTCDate())}/${pad(mon.getUTCMonth() + 1)} - ${pad(sun.getUTCDate())}/${pad(sun.getUTCMonth() + 1)})`;
      if (!weekMap.has(wk)) {
        weekMap.set(wk, {
          key: wk,
          label,
          total: 0,
          done: 0,
          doing: 0,
          todo: 0,
          overdue: 0,
        });
      }
      const wItem = weekMap.get(wk);
      wItem.total++;
      wItem[task.status] = (wItem[task.status] || 0) + 1;
      if (task.status !== 'done' && task.deadline && task.deadline < t) wItem.overdue++;
    }
  }

  const finalize = (map) =>
    Array.from(map.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((item) => ({
        ...item,
        open: item.total - item.done,
        progress: item.total ? Math.round((item.done / item.total) * 100) : 0,
      }));

  return {
    month: finalize(monthMap),
    week: finalize(weekMap),
  };
}

app.get('/api/projects/:id/stats', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const t = today();

  const tasks = db.prepare('SELECT id, status, deadline, created_at FROM tasks WHERE project_id = ?').all(id);
  const byStatus = { todo: 0, doing: 0, done: 0 };
  let overdue = 0;
  for (const x of tasks) {
    byStatus[x.status] += 1;
    if (x.status !== 'done' && x.deadline && x.deadline < t) overdue += 1;
  }
  const total = tasks.length;
  const done = byStatus.done;
  const byPeriod = computeTimeline(tasks, t);

  const byMember = db
    .prepare(
      `SELECT u.id, u.name,
        COUNT(t.id) AS total,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN t.status = 'doing' THEN 1 ELSE 0 END), 0) AS doing,
        COALESCE(SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END), 0) AS todo,
        COALESCE(SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END), 0) AS open,
        COALESCE(SUM(CASE WHEN t.status != 'done' AND t.deadline < ? THEN 1 ELSE 0 END), 0) AS overdue
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN tasks t ON t.assignee_id = u.id AND t.project_id = pm.project_id
       WHERE pm.project_id = ?
       GROUP BY u.id ORDER BY u.name`
    )
    .all(t, id)
    .map((m) => {
      const rate = m.total ? Math.round((m.done / m.total) * 100) : 0;
      let grade = 'Đang tiến hành';
      if (m.total === 0) grade = 'Chưa phân công';
      else if (m.overdue > 0) grade = 'Cần chú ý';
      else if (rate === 100) grade = 'Xuất sắc';
      else if (rate >= 60) grade = 'Tốt';
      return { ...m, completion_rate: rate, performance_grade: grade };
    });

  res.json({
    total,
    done,
    overdue,
    progress: total ? Math.round((done / total) * 100) : 0,
    byStatus,
    byMember,
    byPeriod,
  });
});

// Báo cáo chi tiết tổng hợp theo tuần / tháng
app.get('/api/projects/:id/report', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const p = getProject(id);
  const t = today();
  const allTasks = db
    .prepare(
      `SELECT t.*, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = ? ORDER BY t.deadline ASC, t.id ASC`
    )
    .all(id)
    .map((r) => withOverdue(r, t));

  const byPeriod = computeTimeline(allTasks, t);
  const byStatus = { todo: 0, doing: 0, done: 0 };
  let overdue = 0;
  for (const x of allTasks) {
    byStatus[x.status] += 1;
    if (x.status !== 'done' && x.deadline && x.deadline < t) overdue += 1;
  }
  const total = allTasks.length;
  const done = byStatus.done;
  const progress = total ? Math.round((done / total) * 100) : 0;

  const byMember = db
    .prepare(
      `SELECT u.id, u.name, pm.role,
        COUNT(t.id) AS total,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN t.status = 'doing' THEN 1 ELSE 0 END), 0) AS doing,
        COALESCE(SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END), 0) AS todo,
        COALESCE(SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END), 0) AS open,
        COALESCE(SUM(CASE WHEN t.status != 'done' AND t.deadline < ? THEN 1 ELSE 0 END), 0) AS overdue
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN tasks t ON t.assignee_id = u.id AND t.project_id = pm.project_id
       WHERE pm.project_id = ?
       GROUP BY u.id ORDER BY u.name`
    )
    .all(t, id)
    .map((m) => {
      const rate = m.total ? Math.round((m.done / m.total) * 100) : 0;
      let grade = 'Đang tiến hành';
      if (m.total === 0) grade = 'Chưa phân công';
      else if (m.overdue > 0) grade = 'Cần chú ý';
      else if (rate === 100) grade = 'Xuất sắc';
      else if (rate >= 60) grade = 'Tốt';
      return { ...m, completion_rate: rate, performance_grade: grade };
    });

  res.json({
    project: p,
    generated_at: t,
    summary: { total, done, doing: byStatus.doing, todo: byStatus.todo, overdue, progress },
    byStatus,
    byMember,
    byPeriod,
    tasks: allTasks,
  });
});

// Xuất báo cáo dự án dưới dạng CSV (UTF-8 BOM tương thích hoàn toàn với Microsoft Excel)
app.get('/api/projects/:id/export/csv', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const p = getProject(id);
  const t = today();
  const tasks = db
    .prepare(
      `SELECT t.*, u.name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = ? ORDER BY t.deadline ASC, t.id ASC`
    )
    .all(id)
    .map((r) => withOverdue(r, t));

  const total = tasks.length;
  const done = tasks.filter((x) => x.status === 'done').length;
  const overdue = tasks.filter((x) => x.status !== 'done' && x.deadline && x.deadline < t).length;
  const progress = total ? Math.round((done / total) * 100) : 0;

  const members = db
    .prepare(
      `SELECT u.name, pm.role,
        COUNT(t.id) AS total,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END), 0) AS open,
        COALESCE(SUM(CASE WHEN t.status != 'done' AND t.deadline < ? THEN 1 ELSE 0 END), 0) AS overdue
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN tasks t ON t.assignee_id = u.id AND t.project_id = pm.project_id
       WHERE pm.project_id = ?
       GROUP BY u.id ORDER BY u.name`
    )
    .all(t, id);

  const esc = (val) => {
    const s = String(val ?? '').replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };

  const lines = [];
  lines.push('BÁO CÁO TIẾN ĐỘ VÀ THỐNG KÊ DỰ ÁN');
  lines.push(`Tên dự án:,${esc(p.name)}`);
  lines.push(`Mô tả:,${esc(p.description || 'Chưa có mô tả')}`);
  lines.push(`Thời gian:,${esc(p.start_date || '—')} đến ${esc(p.end_date || '—')}`);
  lines.push(`Ngày xuất báo cáo:,${t}`);
  lines.push(`Tỷ lệ hoàn thành dự án:,${progress}%`);
  lines.push(`Tổng số công việc:,${total}`);
  lines.push(`Công việc hoàn thành:,${done}`);
  lines.push(`Công việc quá hạn:,${overdue}`);
  lines.push('');

  lines.push('HIỆU SUẤT VÀ KHỐI LƯỢNG THEO THÀNH VIÊN');
  lines.push('Thành viên,Vai trò,Tổng việc,Hoàn thành,Đang mở,Quá hạn,Tỷ lệ hoàn thành (%)');
  for (const m of members) {
    const rate = m.total ? Math.round((m.done / m.total) * 100) : 0;
    lines.push([esc(m.name), esc(ROLE_NAME[m.role] || m.role), m.total, m.done, m.open, m.overdue, `${rate}%`].join(','));
  }
  lines.push('');

  lines.push('DANH SÁCH CHI TIẾT CÔNG VIỆC');
  lines.push('Mã,Tiêu đề,Người phụ trách,Ưu tiên,Trạng thái,Hạn chót,Tình trạng');
  for (const task of tasks) {
    const statusText = STATUS_TEXT[task.status] || task.status;
    const prioText = task.priority === 'high' ? 'Cao' : task.priority === 'low' ? 'Thấp' : 'Trung bình';
    const condition = task.status === 'done' ? 'Đã hoàn thành' : task.overdue ? 'Quá hạn' : 'Đúng hạn';
    lines.push(
      [
        task.id,
        esc(task.title),
        esc(task.assignee_name || 'Chưa phân công'),
        esc(prioText),
        esc(statusText),
        esc(task.deadline || 'Không có'),
        esc(condition),
      ].join(',')
    );
  }

  const csvContent = '\uFEFF' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bao-cao-du-an-${id}.csv"`);
  res.send(csvContent);
});

app.get('/api/projects/:id/activity', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const where = ['a.project_id = ?'];
  const params = [id];
  if (req.query.task_id) {
    where.push('a.task_id = ?');
    params.push(toId(req.query.task_id));
  }
  if (req.query.before) {
    where.push('a.id < ?');
    params.push(toId(req.query.before));
  }
  const rows = db
    .prepare(
      `SELECT a.id, a.action, a.created_at, a.task_id, u.name AS user_name
       FROM activity a LEFT JOIN users u ON u.id = a.user_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`
    )
    .all(...params, limit);
  res.json(rows);
});

// ---------- AI assistant (chỉ đọc dữ liệu, không ghi) ----------
app.post(
  '/api/projects/:id/ai/analyze',
  auth,
  aiLimiter,
  wrap(async (req, res) => {
    const id = toId(req.params.id);
    requireMember(req, id);
    const variant = pickVariant(req);
    const result = await ai.generate('analyze', buildContext(id), '', { variant });
    saveAiLog(id, req.user.id, 'analyze', 'Phân tích tiến độ dự án', result);
    res.json(result);
  })
);

app.post(
  '/api/projects/:id/ai/ask',
  auth,
  aiLimiter,
  wrap(async (req, res) => {
    const id = toId(req.params.id);
    requireMember(req, id);
    const question = requireText(body(req).question, 'câu hỏi', 500);
    const variant = pickVariant(req);
    const result = await ai.generate('ask', buildContext(id), question, { variant });
    saveAiLog(id, req.user.id, 'ask', question, result);
    res.json(result);
  })
);

// ---------- AI Chatbox endpoint (hỗ trợ cả trong dự án lẫn ngoài trang tổng quan) ----------
app.post(
  '/api/ai/chat',
  auth,
  aiLimiter,
  wrap(async (req, res) => {
    const b = body(req);
    const message = requireText(b.message || b.question, 'tin nhắn', 1000);
    const projectId = b.projectId ? toId(b.projectId) : null;
    let ctx;
    if (projectId) {
      requireMember(req, projectId);
      ctx = buildContext(projectId);
    } else {
      ctx = buildUserContext(req.user.id);
    }
    const variant = pickVariant(req);
    const result = await ai.generate('ask', ctx, message, { variant });
    if (projectId) {
      saveAiLog(projectId, req.user.id, 'chat', message, result);
    }
    res.json({
      answer: result.result?.summary || 'Tôi đã tiếp nhận tin nhắn nhưng chưa có câu trả lời cụ thể.',
      result: result.result,
      mode: result.mode,
      provider: result.provider,
      prompt_version: result.prompt_version,
      notice: result.notice,
    });
  })
);
app.post(
  '/api/projects/:id/ai/compare',
  auth,
  aiLimiter,
  wrap(async (req, res) => {
    const id = toId(req.params.id);
    requireMember(req, id);
    const b = body(req);
    const kind = b.kind === 'ask' ? 'ask' : 'analyze';
    const question = kind === 'ask' ? requireText(b.question, 'câu hỏi', 500) : '';
    const ctx = buildContext(id);
    const runs = [];
    for (const variant of Object.keys(prompts.VARIANTS)) {
      const run = await ai.generate(kind, ctx, question, { variant });
      saveAiLog(id, req.user.id, kind, question || 'Phân tích tiến độ dự án (so sánh)', run);
      runs.push({ variant, ...run, metrics: ai.scoreRun(run, ctx) });
    }
    res.json({ runs });
  })
);

app.post(
  '/api/projects/:id/ai/run',
  auth,
  aiLimiter,
  wrap(async (req, res) => {
    const id = toId(req.params.id);
    requireMember(req, id);
    const b = body(req);
    const variant = b.variant;
    if (!variant || !Object.hasOwn(prompts.VARIANTS, variant)) {
      throw httpError(400, 'Biến thể prompt không hợp lệ');
    }
    const kind = b.kind === 'ask' ? 'ask' : 'analyze';
    const question = kind === 'ask' ? requireText(b.question, 'câu hỏi', 500) : '';
    const ctx = buildContext(id);
    const run = await ai.generate(kind, ctx, question, { variant });
    saveAiLog(id, req.user.id, kind, question || `Phân tích tiến độ dự án (${variant})`, run);
    res.json({ variant, ...run, metrics: ai.scoreRun(run, ctx) });
  })
);

// Danh sách phiên bản prompt kèm mẫu đầy đủ, để hiển thị trên giao diện
app.get('/api/lab/variants', auth, (req, res) => {
  const kind = req.query.kind === 'ask' ? 'ask' : 'analyze';
  const task = kind === 'ask' ? prompts.askTask('<câu hỏi>') : prompts.ANALYZE_TASK;
  res.json(
    Object.values(prompts.VARIANTS).map((v) => ({
      id: v.name,
      template: `[SYSTEM]\n${v.system}\n\n[USER]\n${v.user(task, { today: '<ngày hôm nay>', data: '<DỮ LIỆU DỰ ÁN>' })}`
        .replace('"<DỮ LIỆU DỰ ÁN>"', '<DỮ LIỆU DỰ ÁN>')
        .replace('"<ngày hôm nay>"', '<ngày hôm nay>'),
    }))
  );
});

// Nhật ký gọi AI gần đây của dự án
app.get('/api/projects/:id/ai/logs', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const rows = db
    .prepare(
      `SELECT l.kind, l.prompt, l.mode, l.created_at, u.name AS user_name
       FROM ai_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.project_id = ? ORDER BY l.id DESC LIMIT 20`
    )
    .all(id);
  res.json(rows);
});
// ---------- Thông báo, bình luận, nhắc hạn ----------
const STATUS_TEXT = { todo: 'Chưa thực hiện', doing: 'Đang thực hiện', done: 'Hoàn thành' };
const commentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Bạn bình luận quá nhanh, thử lại sau ít phút',
});

// Gửi thông báo cho các người nhận là thành viên dự án, bỏ qua người thực hiện hành động
function notify(userIds, { projectId, taskId = null, type, message, actorId }) {
  const targets = [...new Set(userIds)].filter((u) => u && u !== actorId && membership(projectId, u));
  const ins = db.prepare('INSERT INTO notifications (user_id, project_id, task_id, type, message) VALUES (?, ?, ?, ?, ?)');
  for (const u of targets) ins.run(u, projectId, taskId, type, message);
  return targets.length;
}

// Nhắc hạn: việc được giao, chưa xong, hạn trong 2 ngày tới hoặc đã qua. Mỗi việc mỗi ngày nhắc một lần
function scanDeadlines(userId) {
  const rows = db
    .prepare(
      `SELECT t.id, t.project_id, t.title, t.deadline
       FROM tasks t
       WHERE t.assignee_id = ? AND t.status != 'done' AND t.deadline IS NOT NULL
         AND t.deadline <= date('now', '+2 days')
         AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = t.assignee_id)
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.user_id = ? AND n.task_id = t.id AND n.type = 'deadline' AND date(n.created_at) = date('now'))`
    )
    .all(userId, userId);
  const ins = db.prepare(
    "INSERT INTO notifications (user_id, project_id, task_id, type, message) VALUES (?, ?, ?, 'deadline', ?)"
  );
  const now = today();
  for (const r of rows) {
    const msg = r.deadline < now
      ? `Đã quá hạn: "${r.title}" (hạn ${r.deadline})`
      : `Sắp đến hạn: "${r.title}" (hạn ${r.deadline})`;
    ins.run(userId, r.project_id, r.id, msg);
  }
  return rows.length;
}

function taskRow(taskId) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!t) throw httpError(404, 'Không tìm thấy nhiệm vụ');
  return t;
}

// Bình luận trên một công việc
app.get('/api/tasks/:id/comments', auth, (req, res) => {
  const taskId = toId(req.params.id);
  const task = taskRow(taskId);
  requireMember(req, task.project_id);
  res.json(
    db
      .prepare(
        `SELECT c.id, c.body, c.user_id, c.created_at, u.name AS user_name
         FROM task_comments c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.task_id = ? ORDER BY c.id ASC LIMIT 200`
      )
      .all(taskId)
  );
});

app.post('/api/tasks/:id/comments', auth, commentLimiter, (req, res) => {
  const taskId = toId(req.params.id);
  const task = taskRow(taskId);
  requireMember(req, task.project_id);
  const text = requireText(body(req).body, 'nội dung bình luận', 2000);
  const info = db
    .prepare('INSERT INTO task_comments (task_id, user_id, body) VALUES (?, ?, ?)')
    .run(taskId, req.user.id, text);
  logActivity(task.project_id, req.user.id, `bình luận về "${task.title}"`, taskId);
  notify([task.assignee_id, getProject(task.project_id).owner_id], {
    projectId: task.project_id,
    taskId,
    type: 'comment',
    message: `${req.user.name} đã bình luận về "${task.title}"`,
    actorId: req.user.id,
  });
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// Tác giả xóa được bình luận của mình, quản lý xóa được bất kỳ bình luận nào
app.delete('/api/comments/:id', auth, (req, res) => {
  const c = db
    .prepare(
      `SELECT c.id, c.user_id, t.project_id FROM task_comments c
       JOIN tasks t ON t.id = c.task_id WHERE c.id = ?`
    )
    .get(toId(req.params.id));
  if (!c) throw httpError(404, 'Không tìm thấy bình luận');
  requireMember(req, c.project_id);
  if (c.user_id !== req.user.id) requireManager(req, c.project_id);
  db.prepare('DELETE FROM task_comments WHERE id = ?').run(c.id);
  logActivity(c.project_id, req.user.id, 'xóa một bình luận');
  res.json({ ok: true });
});

// Thông báo của người dùng hiện tại. Khi gọi, quét nhắc hạn trước khi trả về
app.get('/api/notifications', auth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  scanDeadlines(req.user.id);
  const items = db
    .prepare(
      `SELECT n.id, n.type, n.message, n.read_at, n.created_at, n.project_id, n.task_id, p.name AS project_name
       FROM notifications n LEFT JOIN projects p ON p.id = n.project_id
       WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`
    )
    .all(req.user.id, limit);
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(req.user.id).n;
  res.json({ items, unread_count: unread });
});

// Chỉ đánh dấu được thông báo của chính mình (người khác nhận changed = 0)
app.post('/api/notifications/:id/read', auth, (req, res) => {
  const r = db
    .prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL")
    .run(toId(req.params.id), req.user.id);
  res.json({ ok: true, changed: r.changes });
});

app.post('/api/notifications/read-all', auth, (req, res) => {
  const r = db
    .prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
    .run(req.user.id);
  res.json({ ok: true, changed: r.changes });
});

// ---------- Error handling ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy API' }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Dữ liệu JSON không hợp lệ' });
  }
  let status = err.status;
  if (!status && String(err.code || '').startsWith('SQLITE_CONSTRAINT')) status = 400;
  status = status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Lỗi máy chủ, vui lòng thử lại' : err.message });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server đang chạy tại http://localhost:${PORT}`));
}

module.exports = app;