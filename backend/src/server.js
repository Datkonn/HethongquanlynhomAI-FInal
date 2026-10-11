require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const ai = require('./ai');
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

app.use(cors());
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
function logActivity(projectId, userId, action) {
  db.prepare('INSERT INTO activity (project_id, user_id, action) VALUES (?, ?, ?)').run(projectId, userId, action);
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

// ---------- Auth ----------
app.post(
  '/api/auth/register',
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
      .prepare('INSERT INTO projects (name, description, start_date, end_date) VALUES (?, ?, ?, ?)')
      .run(name, description, start, end).lastInsertRowid
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
  requireManager(req, id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Members ----------
app.post('/api/projects/:id/members', auth, (req, res) => {
  const id = toId(req.params.id);
  requireManager(req, id);
  const b = body(req);
  const email = requireText(b.email, 'email').toLowerCase();
  const role = b.role ?? 'member';
  if (!MEMBER_ROLES.includes(role)) throw httpError(400, 'Vai trò không hợp lệ');
  const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (!user) throw httpError(404, 'Email này chưa đăng ký tài khoản');

  db.prepare(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`
  ).run(id, user.id, role);
  logActivity(id, req.user.id, `thêm ${user.name} với vai trò ${role === 'manager' ? 'quản lý' : 'thành viên'}`);
  res.status(201).json({ ok: true });
});

app.delete('/api/projects/:id/members/:userId', auth, (req, res) => {
  const id = toId(req.params.id);
  const userId = toId(req.params.userId);
  requireManager(req, id);
  const target = membership(id, userId);
  if (!target) throw httpError(404, 'Thành viên không có trong dự án');
  if (target.role === 'manager') {
    const n = db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'manager'").get(id).n;
    if (n <= 1) throw httpError(400, 'Dự án phải có ít nhất một quản lý');
  }
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, userId);
  db.prepare('UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?').run(id, userId);
  logActivity(id, req.user.id, 'xóa một thành viên khỏi dự án');
  res.json({ ok: true });
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
  logActivity(id, req.user.id, `tạo nhiệm vụ "${v.title}"`);
  res.status(201).json(getTask(Number(info.lastInsertRowid)));
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const id = toId(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw httpError(404, 'Không tìm thấy nhiệm vụ');
  const m = requireMember(req, task.project_id);
  const b = body(req);

  // Thành viên chỉ được đổi trạng thái của nhiệm vụ được giao cho mình
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
  logActivity(task.project_id, req.user.id, `cập nhật "${v.title}" (trạng thái: ${v.status})`);
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

// ---------- Stats & activity ----------
app.get('/api/projects/:id/stats', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const t = today();

  const tasks = db.prepare('SELECT status, deadline FROM tasks WHERE project_id = ?').all(id);
  const byStatus = { todo: 0, doing: 0, done: 0 };
  let overdue = 0;
  for (const x of tasks) {
    byStatus[x.status] += 1;
    if (x.status !== 'done' && x.deadline && x.deadline < t) overdue += 1;
  }
  const total = tasks.length;
  const done = byStatus.done;

  const byMember = db
    .prepare(
      `SELECT u.id, u.name,
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

  res.json({
    total,
    done,
    overdue,
    progress: total ? Math.round((done / total) * 100) : 0,
    byStatus,
    byMember,
  });
});

app.get('/api/projects/:id/activity', auth, (req, res) => {
  const id = toId(req.params.id);
  requireMember(req, id);
  const rows = db
    .prepare(
      `SELECT a.action, a.created_at, u.name AS user_name FROM activity a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.project_id = ? ORDER BY a.id DESC LIMIT 50`
    )
    .all(id);
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
app.post(
  '/api/projects/:id/ai/compare',
  auth,
  aiLimiter,
  wrap(async (req, res) => {
    const id = toId(req.params.id);
    requireMember(req, id);
    const ctx = buildContext(id);
    const runs = [];
    // Chạy lần lượt để không làm quá tải mô hình chạy trên máy
    for (const variant of Object.keys(prompts.VARIANTS)) {
      const run = await ai.generate('analyze', ctx, '', { variant });
      saveAiLog(id, req.user.id, 'compare', `So sánh: ${variant}`, run);
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
    const variant = pickVariant(req);
    if (!variant) throw httpError(400, 'Thiếu biến thể prompt');
    const ctx = buildContext(id);
    const run = await ai.generate('analyze', ctx, '', { variant });
    saveAiLog(id, req.user.id, 'run', `Chạy thử: ${variant}`, run);
    res.json({ variant, ...run, metrics: ai.scoreRun(run, ctx) });
  })
);
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