const STATUS_LABEL = { todo: 'Chưa làm', doing: 'Đang làm', done: 'Hoàn thành' };
const PRIORITY_LABEL = { low: 'Thấp', medium: 'Trung bình', high: 'Cao' };
const ROLE_LABEL = { manager: 'Quản lý', member: 'Thành viên' };

const state = {
  token: localStorage.getItem('token'),
  user: null,
  project: null,
  members: [],
  tasks: [],
  isManager: false,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = 'toast'), 3000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) logout(true);
    throw new Error(data.error || 'Có lỗi xảy ra');
  }
  return data;
}

// ---------- Điều hướng giao diện ----------
function showView(id) {
  ['auth-view', 'projects-view', 'project-view'].forEach((v) => ($('#' + v).hidden = v !== id));
  // Trang dự án dùng toàn bộ chiều rộng để thanh tab nằm sát bên trái
  document.querySelector('.container').classList.toggle('wide', id === 'project-view');
}
function applyRoleVisibility() {
  document.querySelectorAll('.mgr').forEach((el) => (el.hidden = !state.isManager));
}

// ---------- Đăng nhập / đăng ký ----------
let authMode = 'login';

function renderAuth() {
  const reg = authMode === 'register';
  $('#auth-title').textContent = reg ? 'Tạo tài khoản' : 'Đăng nhập';
  $('#auth-subtitle').textContent = reg ? 'Tạo tài khoản mới để bắt đầu quản lý dự án' : 'Chào mừng bạn quay lại';
  $('#auth-name-row').hidden = !reg;
  $('#auth-name').required = reg;
  $('#auth-password').autocomplete = reg ? 'new-password' : 'current-password';
  $('#auth-switch-text').textContent = reg ? 'Đã có tài khoản?' : 'Chưa có tài khoản?';
  $('#auth-switch').textContent = reg ? 'Đăng nhập' : 'Đăng ký ngay';
  setAuthLoading(false);
  showAuthError('');
}

function showAuthError(msg) {
  const el = $('#auth-error');
  el.textContent = msg;
  el.hidden = !msg;
}

function setAuthLoading(loading) {
  const btn = $('#auth-submit');
  btn.disabled = loading;
  btn.textContent = loading ? 'Đang xử lý...' : authMode === 'register' ? 'Đăng ký' : 'Đăng nhập';
}

$('#auth-switch').onclick = () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  renderAuth();
};

$('#pw-toggle').onclick = () => {
  const input = $('#auth-password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('#pw-toggle').textContent = show ? 'Ẩn' : 'Hiện';
};

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  const payload = { email: form.email, password: form.password };
  if (authMode === 'register') payload.name = form.name;

  showAuthError('');
  setAuthLoading(true);
  try {
    const data = await api(authMode === 'register' ? '/auth/register' : '/auth/login', {
      method: 'POST',
      body: payload,
    });
    state.token = data.token;
    localStorage.setItem('token', data.token);
    state.user = data.user;
    await enterApp();
  } catch (err) {
    showAuthError(err.message);
  } finally {
    setAuthLoading(false);
  }
};

async function enterApp() {
  $('#user-name').textContent = state.user.name;
  $('#user-box').hidden = false;
  await loadProjects();
  showView('projects-view');
}

function logout(silent = false) {
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  $('#user-box').hidden = true;
  showView('auth-view');
  if (silent) toast('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại', true);
}
$('#logout-btn').onclick = () => logout();

// ---------- Danh sách dự án ----------
async function loadProjects() {
  const projects = await api('/projects');
  const list = $('#project-list');
  if (!projects.length) {
    list.innerHTML = '<p class="muted">Bạn chưa tham gia dự án nào. Hãy tạo dự án mới.</p>';
    return;
  }
  list.innerHTML = projects
    .map((p) => {
      const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
      return `
        <div class="card project-card" data-id="${p.id}">
          <div class="row-between">
            <h3>${esc(p.name)}</h3>
            <span class="badge">${ROLE_LABEL[p.my_role]}</span>
          </div>
          <p class="muted">${esc(p.description || 'Chưa có mô tả')}</p>
          <div class="progress"><div style="width:${pct}%"></div></div>
          <small class="muted">${p.done_count}/${p.task_count} nhiệm vụ · ${p.start_date || '?'} → ${p.end_date || '?'}</small>
        </div>`;
    })
    .join('');
  list.querySelectorAll('.project-card').forEach((el) => {
    el.onclick = () => openProject(el.dataset.id).catch((err) => toast(err.message, true));
  });
}

$('#new-project-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const p = await api('/projects', {
      method: 'POST',
      body: {
        name: f.name,
        description: f.description,
        start_date: f.start_date || null,
        end_date: f.end_date || null,
      },
    });
    e.target.reset();
    toast('Đã tạo dự án');
    await loadProjects();
    await openProject(p.id);
  } catch (err) {
    toast(err.message, true);
  }
};

$('#back-btn').onclick = () => {
  showView('projects-view');
  loadProjects().catch((err) => toast(err.message, true));
};

// ---------- Chi tiết dự án ----------
async function refreshProject() {
  const p = await api(`/projects/${state.project.id}`);
  state.project = p;
  state.members = p.members;
  state.isManager = p.my_role === 'manager';
  $('#project-title').textContent = p.name;
  $('#project-desc').textContent = p.description || 'Chưa có mô tả';
  $('#project-dates').textContent =
    `Thời gian: ${p.start_date || '?'} → ${p.end_date || '?'} · Vai trò của bạn: ${ROLE_LABEL[p.my_role]}`;
  fillMemberSelects();
  renderMembers();
  applyRoleVisibility();
}

async function openProject(id) {
  state.project = { id: Number(id) };
  await refreshProject();
  showView('project-view');
  setTab('tasks');
}

function setTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
  const loaders = { tasks: loadTasks, stats: loadStats, activity: loadActivity };
  if (loaders[tab]) loaders[tab]().catch((err) => toast(err.message, true));
}
document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

function fillMemberSelects() {
  const opts = state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('#f-assignee').innerHTML = '<option value="">Mọi người</option><option value="none">Chưa phân công</option>' + opts;
  $('#task-assignee').innerHTML = '<option value="">— Chưa phân công —</option>' + opts;
}

// ---------- Nhiệm vụ: tìm kiếm, lọc, CRUD ----------
async function loadTasks() {
  const params = new URLSearchParams();
  const q = $('#f-q').value.trim();
  if (q) params.set('q', q);
  for (const key of ['status', 'priority', 'assignee', 'sort']) {
    const v = $('#f-' + key).value;
    if (v) params.set(key, v);
  }
  state.tasks = await api(`/projects/${state.project.id}/tasks?${params}`);
  renderTasks();
}

['#f-q', '#f-status', '#f-priority', '#f-assignee', '#f-sort'].forEach((sel) =>
  $(sel).addEventListener('input', debounce(() => loadTasks().catch((err) => toast(err.message, true)), 250))
);

function renderTasks() {
  const body = $('#task-rows');
  if (!state.tasks.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted center">Không có nhiệm vụ phù hợp.</td></tr>';
    applyRoleVisibility();
    return;
  }
  body.innerHTML = state.tasks
    .map(
      (t) => `
      <tr class="${t.overdue ? 'overdue' : ''}">
        <td><strong>${esc(t.title)}</strong><div class="muted small">${esc(t.description || '')}</div></td>
        <td>${esc(t.assignee_name || 'Chưa phân công')}</td>
        <td><span class="badge p-${t.priority}">${PRIORITY_LABEL[t.priority]}</span></td>
        <td>${t.deadline || '—'} ${t.overdue ? '<span class="badge danger">Quá hạn</span>' : ''}</td>
        <td>
          <select data-status="${t.id}" ${state.isManager || t.assignee_id === state.user.id ? '' : 'disabled'}>
            ${Object.entries(STATUS_LABEL)
              .map(([k, v]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${v}</option>`)
              .join('')}
          </select>
        </td>
        <td class="actions mgr">
          <button class="btn small" data-edit="${t.id}" type="button">Sửa</button>
          <button class="btn small danger" data-del="${t.id}" type="button">Xóa</button>
        </td>
      </tr>`
    )
    .join('');

  body.querySelectorAll('[data-status]').forEach((sel) => {
    sel.onchange = () => updateTask(sel.dataset.status, { status: sel.value });
  });
  body.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openTaskDialog(state.tasks.find((t) => String(t.id) === b.dataset.edit));
  });
  body.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => deleteTask(b.dataset.del);
  });
  applyRoleVisibility();
}

async function updateTask(id, payload) {
  try {
    await api(`/tasks/${id}`, { method: 'PUT', body: payload });
    toast('Đã cập nhật nhiệm vụ');
  } catch (err) {
    toast(err.message, true);
  }
  loadTasks().catch((err) => toast(err.message, true));
}

async function deleteTask(id) {
  if (!confirm('Xóa nhiệm vụ này?')) return;
  try {
    await api(`/tasks/${id}`, { method: 'DELETE' });
    toast('Đã xóa nhiệm vụ');
    await loadTasks();
  } catch (err) {
    toast(err.message, true);
  }
}

$('#add-task-btn').onclick = () => openTaskDialog(null);
$('#task-cancel').onclick = () => $('#task-dialog').close();

function openTaskDialog(task) {
  const f = $('#task-form');
  f.reset();
  const set = (name, v) => (f.elements[name].value = v ?? '');
  $('#task-dialog-title').textContent = task ? 'Sửa nhiệm vụ' : 'Thêm nhiệm vụ';
  set('task_id', task ? task.id : '');
  set('title', task ? task.title : '');
  set('description', task ? task.description : '');
  set('assignee_id', task ? task.assignee_id : '');
  set('priority', task ? task.priority : 'medium');
  set('status', task ? task.status : 'todo');
  set('deadline', task ? task.deadline : '');
  $('#task-dialog').showModal();
}

$('#task-form').onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  const payload = {
    title: d.title,
    description: d.description,
    assignee_id: d.assignee_id ? Number(d.assignee_id) : null,
    priority: d.priority,
    status: d.status,
    deadline: d.deadline || null,
  };
  try {
    if (d.task_id) await api(`/tasks/${d.task_id}`, { method: 'PUT', body: payload });
    else await api(`/projects/${state.project.id}/tasks`, { method: 'POST', body: payload });
    $('#task-dialog').close();
    toast('Đã lưu nhiệm vụ');
    await loadTasks();
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- Thống kê ----------
async function loadStats() {
  const s = await api(`/projects/${state.project.id}/stats`);
  const cards = [
    ['Tổng nhiệm vụ', s.total],
    ['Hoàn thành', s.done],
    ['Tiến độ', s.progress + '%'],
    ['Quá hạn', s.overdue],
  ];
  $('#stat-cards').innerHTML = cards
    .map(([label, value]) => `<div class="card stat"><span class="muted small">${label}</span><strong>${value}</strong></div>`)
    .join('');

  $('#status-bars').innerHTML = Object.keys(STATUS_LABEL)
    .map((k) => {
      const n = s.byStatus[k] || 0;
      const pct = s.total ? Math.round((n / s.total) * 100) : 0;
      return `<div class="bar-row"><span>${STATUS_LABEL[k]} (${n})</span><div class="bar"><div style="width:${pct}%"></div></div></div>`;
    })
    .join('');

  $('#member-stats').innerHTML =
    s.byMember
      .map(
        (m) => `<tr><td>${esc(m.name)}</td><td>${m.total}</td><td>${m.done}</td><td>${m.open}</td><td>${m.overdue}</td></tr>`
      )
      .join('') || '<tr><td colspan="5" class="muted">Chưa có thành viên.</td></tr>';
}

// ---------- Thành viên ----------
function renderMembers() {
  const list = $('#member-list');
  list.innerHTML = state.members
    .map(
      (m) => `
      <li class="row-between">
        <span><strong>${esc(m.name)}</strong> <span class="muted small">${esc(m.email)}</span></span>
        <span>
          <span class="badge">${ROLE_LABEL[m.role]}</span>
          ${state.isManager && m.id !== state.user.id ? `<button class="btn small danger" data-remove="${m.id}" type="button">Xóa</button>` : ''}
        </span>
      </li>`
    )
    .join('');
  list.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Xóa thành viên này khỏi dự án?')) return;
      try {
        await api(`/projects/${state.project.id}/members/${b.dataset.remove}`, { method: 'DELETE' });
        toast('Đã xóa thành viên');
        await refreshProject();
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
}

$('#member-form').onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    await api(`/projects/${state.project.id}/members`, { method: 'POST', body: d });
    e.target.reset();
    toast('Đã thêm thành viên');
    await refreshProject();
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- Trợ lý AI ----------
const SEV_LABEL = { high: 'Cao', medium: 'Trung bình', low: 'Thấp' };
const FIELD_LABEL = { priority: 'ưu tiên', status: 'trạng thái', deadline: 'hạn', assignee: 'người phụ trách' };

// Hai khung dùng chung cách hiển thị: Trợ lý AI và Phòng Thử prompt (so sánh dùng hàm riêng)
const PANELS = {
  ai: { variant: null, meta: '#ai-meta', notice: '#ai-notice', result: '#ai-result' },
};

$('#ai-analyze').onclick = () => runAI('analyze');
$('#ai-ask-form').onsubmit = (e) => {
  e.preventDefault();
  const { question } = Object.fromEntries(new FormData(e.target));
  runAI('ask', question);
};
document.querySelectorAll('.chip').forEach((c) => (c.onclick = () => runAI('ask', c.dataset.q)));

async function runAI(kind, question = '', panel = 'ai') {
  const p = PANELS[panel];
  const box = $(p.result);
  box.innerHTML = '<p class="muted">AI đang phân tích dữ liệu dự án...</p>';
  $(p.notice).hidden = true;

  const payload = kind === 'ask' ? { question } : {};
  if (p.variant) payload.variant = $(p.variant).value;

  try {
    const [data, tasks] = await Promise.all([
      api(`/projects/${state.project.id}/ai/${kind}`, { method: 'POST', body: payload }),
      api(`/projects/${state.project.id}/tasks`),
    ]);
    state.tasks = tasks;
    renderAiResult(data, p);
  } catch (err) {
    box.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
  }
}

function renderAiResult(data, p) {
  const r = data.result;
  const box = $(p.result);
  const taskTitle = (id) => (state.tasks.find((t) => t.id === id) || {}).title || `Nhiệm vụ #${id}`;

  $(p.meta).textContent = data.mode === 'live' ? `AI · ${data.provider} · ${data.prompt_version}` : 'Chế độ dự phòng';

  const notes = [];
  if (data.notice) notes.push(data.notice);
  if (data.truncated) notes.push('Dự án có nhiều nhiệm vụ, AI chỉ phân tích một phần.');
  $(p.notice).textContent = notes.join(' ');
  $(p.notice).hidden = notes.length === 0;

  const section = (title, items) =>
    items.length ? `<div class="ai-sec"><h4>${title}</h4><ul class="ai-list">${items.join('')}</ul></div>` : '';

  const risks = r.risks.map(
    (x) => `<li><span class="sev sev-${x.severity}">${SEV_LABEL[x.severity]}</span>
      <strong>${esc(x.task_title || taskTitle(x.task_id))}</strong> — ${esc(x.reason)}</li>`
  );
  const priorities = r.priorities.map(
    (x, i) => `<li><strong>${i + 1}. ${esc(x.task_title || taskTitle(x.task_id))}</strong> — ${esc(x.reason)}</li>`
  );
  const workload = r.workload_warnings.map(
    (w) => `<li><strong>${esc(w.member)}</strong>: ${w.open_tasks} việc đang mở. ${esc(w.note)}</li>`
  );
  const actions = r.suggested_actions.map(
    (a) => `<li class="action-row">
      <span>${esc(taskTitle(a.task_id))}: đề xuất đổi ${FIELD_LABEL[a.field]} thành
        <strong>${esc(a.value)}</strong>. <span class="muted">${esc(a.reason)}</span></span>
      ${state.isManager
        ? `<button class="btn small" type="button" data-apply="${a.task_id}" data-field="${a.field}" data-value="${esc(a.value)}">Mở để xác nhận</button>`
        : ''}
    </li>`
  );

  box.innerHTML = [
    `<div class="ai-summary">${esc(r.summary)}</div>`,
    r.insufficient_data ? '<div class="notice">AI cho rằng dữ liệu chưa đủ để kết luận chắc chắn.</div>' : '',
    section('Nguy cơ trễ hạn', risks),
    section('Thứ tự nên làm', priorities),
    section('Cảnh báo khối lượng', workload),
    section('Đề xuất chỉnh sửa (cần người quản lý xác nhận)', actions),
  ].join('');

  box.querySelectorAll('[data-apply]').forEach((b) => {
    b.onclick = () => applySuggestion(b.dataset);
  });
}

// Chỉ mở form nhiệm vụ với giá trị đề xuất sẵn; người quản lý phải bấm Lưu mới có hiệu lực
function applySuggestion({ apply, field, value }) {
  const task = state.tasks.find((t) => String(t.id) === apply);
  if (!task) return toast('Không tìm thấy nhiệm vụ', true);

  const patched = { ...task };
  if (field === 'assignee') {
    const m = state.members.find((x) => x.name === value);
    if (!m) return toast('Không tìm thấy thành viên này trong dự án', true);
    patched.assignee_id = m.id;
  } else if (field === 'priority' && PRIORITY_LABEL[value]) {
    patched.priority = value;
  } else if (field === 'status' && STATUS_LABEL[value]) {
    patched.status = value;
  } else if (field === 'deadline' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    patched.deadline = value;
  } else {
    return toast('Giá trị đề xuất không hợp lệ', true);
  }

  setTab('tasks');
  openTaskDialog(patched);
}

// ---------- Phòng Thử prompt: chạy từng biến thể và so sánh ----------
const VARIANT_NAME = {
  v1_basic: 'Biến thể 1: cơ bản',
  v2_schema: 'Biến thể 2: có schema',
  v3_final: 'Biến thể 3: hoàn chỉnh',
};
const VARIANT_ORDER = ['v1_basic', 'v2_schema', 'v3_final'];
const labRuns = {}; // kết quả đã chạy, lưu theo tên biến thể để cộng dồn vào bảng

$('#lab-run-one').onclick = runOne;
$('#lab-run').onclick = runCompare;
$('#lab-clear').onclick = () => {
  for (const v of VARIANT_ORDER) delete labRuns[v];
  renderLab();
};

function setLabBusy(busy) {
  ['#lab-run-one', '#lab-run', '#lab-clear'].forEach((s) => ($(s).disabled = busy));
}

async function runOne() {
  const variant = $('#lab-variant').value;
  setLabBusy(true);
  $('#lab-run-one').textContent = 'Đang chạy...';
  $('#lab-notice').hidden = true;
  try {
    const [run, tasks] = await Promise.all([
      api(`/projects/${state.project.id}/ai/run`, { method: 'POST', body: { variant } }),
      api(`/projects/${state.project.id}/tasks`),
    ]);
    state.tasks = tasks;
    labRuns[variant] = run;
    renderLab();
  } catch (err) {
    $('#lab-result').innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
  } finally {
    setLabBusy(false);
    $('#lab-run-one').textContent = 'Chạy biến thể này';
  }
}

async function runCompare() {
  setLabBusy(true);
  $('#lab-run').textContent = 'Đang chạy 3 biến thể...';
  $('#lab-notice').hidden = true;
  try {
    const [{ runs }, tasks] = await Promise.all([
      api(`/projects/${state.project.id}/ai/compare`, { method: 'POST', body: {} }),
      api(`/projects/${state.project.id}/tasks`),
    ]);
    state.tasks = tasks;
    runs.forEach((run) => (labRuns[run.variant] = run));
    renderLab();
  } catch (err) {
    $('#lab-result').innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
  } finally {
    setLabBusy(false);
    $('#lab-run').textContent = 'So sánh 3 biến thể';
  }
}

function renderLab() {
  const yn = (b) => (b ? '✔ Có' : '✘ Không');
  const dash = (v) => (v === null || v === undefined ? '—' : v);
  const ran = VARIANT_ORDER.filter((v) => labRuns[v]);

  const rows = VARIANT_ORDER.map((v) => {
    const run = labRuns[v];
    if (!run) {
      return `<tr><td><strong>${VARIANT_NAME[v]}</strong></td><td colspan="7" class="muted">Chưa chạy</td></tr>`;
    }
    const m = run.metrics;
    const hits = m.overdue_total === 0 || m.overdue_hits === null ? '—' : `${m.overdue_hits}/${m.overdue_total}`;
    return `<tr>
      <td><strong>${VARIANT_NAME[v]}</strong></td>
      <td>${run.mode === 'live' ? `AI · ${esc(run.provider)}` : 'Dự phòng'}</td>
      <td>${yn(m.json_ok)}</td>
      <td>${m.retried ? '✔ Có' : 'Không'}</td>
      <td>${hits}</td>
      <td>${dash(m.dropped)}</td>
      <td>${dash(m.risks)}</td>
      <td>${dash(m.actions)}</td>
    </tr>`;
  }).join('');

  const details = ran
    .map((v) => {
      const r = labRuns[v];
      const risks = r.result.risks.length
        ? `<ul class="ai-list">${r.result.risks
            .map((x) => `<li>${esc(x.task_title)} (${SEV_LABEL[x.severity]}): ${esc(x.reason)}</li>`)
            .join('')}</ul>`
        : '';
      return `<details class="cmp-detail" open>
        <summary>${VARIANT_NAME[v]}</summary>
        ${r.notice ? `<div class="notice">${esc(r.notice)}</div>` : ''}
        <div class="ai-summary">${esc(r.result.summary)}</div>
        ${risks}
      </details>`;
    })
    .join('');

  const liveCount = ran.filter((v) => labRuns[v].mode === 'live').length;
  $('#lab-meta').textContent = ran.length ? `${liveCount}/${ran.length} biến thể dùng AI thật` : '';

  $('#lab-result').innerHTML = `
    <div class="table-wrap">
      <table class="cmp-table">
        <thead>
          <tr>
            <th>Biến thể</th><th>Nguồn</th><th>JSON hợp lệ</th><th>Phải thử lại</th>
            <th>Quá hạn được nêu</th><th>Mục bị loại</th><th>Số rủi ro</th><th>Số đề xuất</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${ran.length
      ? `<h4 class="ai-h4">Nội dung trả lời</h4>${details}`
      : '<p class="muted">Chưa có kết quả. Chọn biến thể rồi bấm "Chạy biến thể này".</p>'}`;
}

// ---------- Hoạt động ----------
async function loadActivity() {
  const rows = await api(`/projects/${state.project.id}/activity`);
  $('#activity-list').innerHTML = rows.length
    ? rows
        .map((r) => `<li><strong>${esc(r.user_name || 'Hệ thống')}</strong> ${esc(r.action)} <span class="muted small">${esc(r.created_at)}</span></li>`)
        .join('')
    : '<li class="muted">Chưa có hoạt động.</li>';
}

// ---------- Khởi động ----------
// ---------- Chế độ sáng / tối ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').textContent = theme === 'dark' ? '☀️ Sáng' : '🌙 Tối';
  localStorage.setItem('theme', theme);
}

$('#theme-toggle').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
};
(async function init() {
  renderAuth();
    const saved = localStorage.getItem('theme');
  applyTheme(saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  if (state.token) {
    try {
      state.user = await api('/auth/me');
      await enterApp();
      return;
    } catch {
      // api() đã xử lý đăng xuất nếu token hết hạn
    }
  }
  showView('auth-view');
})();
