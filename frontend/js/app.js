const STATUS_LABEL = { todo: 'Chưa làm', doing: 'Đang làm', done: 'Hoàn thành' };
const PRIORITY_LABEL = { low: 'Thấp', medium: 'Trung bình', high: 'Cao' };
const ROLE_LABEL = { manager: 'Chủ dự án', member: 'Thành viên' };

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

async function api(path, { method = 'GET', body, timeout = 25000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && state.token) logout(true);
      const err = new Error(data.error || 'Có lỗi xảy ra');
      err.status = res.status;
      err.code = data.code;
      err.retry_after = data.retry_after;
      err.data = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e.name === 'AbortError') {
      const err = new Error('Yêu cầu tới AI đã quá thời gian chờ (Timeout). Máy chủ đang phản hồi chậm hoặc bị quá tải.');
      err.status = 504;
      err.code = 'AI_TIMEOUT';
      throw err;
    }
    throw e;
  }
}

// ---------- Điều hướng giao diện ----------
function showView(id) {
  ['auth-view', 'projects-view', 'project-view'].forEach((v) => ($('#' + v).hidden = v !== id));
  // Trang dự án dùng toàn bộ chiều rộng để thanh tab nằm sát bên trái
  document.querySelector('.container').classList.toggle('wide', id === 'project-view');
}
function applyRoleVisibility() {
  document.querySelectorAll('.mgr').forEach((el) => (el.hidden = !state.isManager));
  document.querySelectorAll('.owner').forEach((el) => (el.hidden = !state.isOwner));
}

// ---------- Đăng nhập / đăng ký ----------
let authMode = 'login';

function renderAuth() {
  const reg = authMode === 'register';
  $('#auth-title').textContent = reg ? 'Tạo tài khoản' : 'Đăng nhập';
  $('#auth-subtitle').textContent = reg ? 'Tạo tài khoản mới để bắt đầu quản lý dự án' : 'Chào mừng bạn quay lại';
  $('#auth-name-row').hidden = !reg;
  $('#auth-name').required = reg;
  if ($('#auth-role-row')) $('#auth-role-row').hidden = !reg;
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
  if (authMode === 'register') {
    payload.name = form.name;
    payload.role = form.role || 'member';
  }

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
  const roleBadge = $('#user-role-badge');
  if (roleBadge) {
    const isMember = state.user.role === 'member';
    roleBadge.textContent = isMember ? 'Thành viên' : 'Trưởng nhóm';
    roleBadge.className = 'badge ' + (isMember ? 'warning' : 'ok');
    roleBadge.hidden = false;
  }
  $('#user-box').hidden = false;
  if ($('#ai-chat-fab')) $('#ai-chat-fab').hidden = false;
  updateChatContext();
  initChat();
  await loadProjects();
  await loadInvBanner().catch(() => {});
  startNotifPolling();
  showView('projects-view');
}

function logout(silent = false) {
  state.token = null;
  state.user = null;
  state.project = null;
  clearInterval(notifTimer);
  notifTimer = null;
  $('#notif-count').textContent = '';
  $('#notif-panel').hidden = true;
  if ($('#ai-chat-fab')) $('#ai-chat-fab').hidden = true;
  if ($('#ai-chatbox-window')) $('#ai-chatbox-window').hidden = true;
  chatHistory = [];
  localStorage.removeItem('token');
  $('#user-box').hidden = true;
  showView('auth-view');
  if (silent) toast('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại', true);
}
$('#logout-btn').onclick = () => logout();

// ---------- Dashboard (Trang tổng quan) ----------
async function loadDashboard(fallbackProjects = null) {
  try {
    const data = await api('/dashboard');
    const { overview, task_stats, projects, upcoming_tasks } = data;

    // 1. Thống kê tổng quan: Dự án, Công việc, Thành viên, Việc của bạn
    $('#dash-total-projects').textContent = overview.total_projects;
    $('#dash-total-tasks').textContent = overview.total_tasks;
    $('#dash-total-members').textContent = overview.total_members;
    $('#dash-my-tasks').textContent = overview.my_tasks;

    // 2. Thống kê trạng thái công việc
    const total = task_stats.total || 0;
    const done = task_stats.done || 0;
    const doing = task_stats.doing || 0;
    const todo = task_stats.todo || 0;
    const overdue = task_stats.overdue || 0;

    $('#dash-stat-done').textContent = done;
    $('#dash-stat-doing').textContent = doing;
    $('#dash-stat-todo').textContent = todo;
    $('#dash-stat-overdue').textContent = overdue;
    $('#dash-overall-progress').textContent = `${task_stats.progress}% Hoàn thành`;

    if (total > 0) {
      const donePct = ((done / total) * 100).toFixed(1);
      const doingPct = ((doing / total) * 100).toFixed(1);
      const overduePct = ((overdue / total) * 100).toFixed(1);
      $('#dash-bar-done').style.width = `${donePct}%`;
      $('#dash-bar-doing').style.width = `${doingPct}%`;
      $('#dash-bar-overdue').style.width = `${overduePct}%`;
    } else {
      $('#dash-bar-done').style.width = '0%';
      $('#dash-bar-doing').style.width = '0%';
      $('#dash-bar-overdue').style.width = '0%';
    }

    // 3. Biểu đồ tiến độ dự án
    const progList = $('#dash-project-progress-list');
    if (!projects || !projects.length) {
      progList.innerHTML = '<p class="muted small">Bạn chưa tham gia dự án nào.</p>';
    } else {
      progList.innerHTML = projects
        .map((p) => {
          const pct = p.progress || 0;
          const overdueBadge =
            p.overdue_count > 0
              ? `<span class="badge danger" style="font-size:11px; margin-left: 6px;">⚠️ ${p.overdue_count} quá hạn</span>`
              : '';
          return `
            <div class="dash-project-row" data-id="${p.id}" title="Nhấn để mở dự án">
              <div class="dash-project-header">
                <div>
                  <strong>${esc(p.name)}</strong>
                  ${overdueBadge}
                </div>
                <span class="muted small"><strong>${pct}%</strong> (${p.done_count}/${p.task_count})</span>
              </div>
              <div class="progress" style="margin: 4px 0 0;"><div style="width:${pct}%"></div></div>
            </div>`;
        })
        .join('');

      progList.querySelectorAll('.dash-project-row').forEach((el) => {
        el.onclick = () => openProject(el.dataset.id).catch((err) => toast(err.message, true));
      });
    }

    // 4. Danh sách công việc sắp đến hạn
    const upList = $('#dash-upcoming-list');
    if (!upcoming_tasks || !upcoming_tasks.length) {
      upList.innerHTML = '<p class="muted small" style="padding: 12px 0;">🎉 Không có công việc nào sắp đến hạn hoặc quá hạn.</p>';
    } else {
      upList.innerHTML = upcoming_tasks
        .map((t) => {
          let badgeClass = 'badge';
          let statusText = t.deadline || '';
          if (t.deadline_status === 'overdue') {
            badgeClass = 'badge danger';
            statusText = `Quá hạn (${t.deadline})`;
          } else if (t.deadline_status === 'today') {
            badgeClass = 'badge warning';
            statusText = 'Hôm nay';
          } else {
            statusText = `Hạn: ${t.deadline}`;
          }

          const assignee = t.assignee_name ? `👤 ${esc(t.assignee_name)}` : '<span class="muted">Chưa giao</span>';

          return `
            <div class="upcoming-item" data-project-id="${t.project_id}" title="Mở dự án chứa công việc này">
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${esc(t.title)}
                </div>
                <div class="small muted" style="margin-top: 2px;">
                  📁 ${esc(t.project_name)} · ${assignee}
                </div>
              </div>
              <div style="text-align: right; flex-shrink: 0;">
                <span class="${badgeClass}">${statusText}</span>
              </div>
            </div>`;
        })
        .join('');

      upList.querySelectorAll('.upcoming-item').forEach((el) => {
        el.onclick = () => openProject(el.dataset.projectId).catch((err) => toast(err.message, true));
      });
    }
  } catch (err) {
    console.error('Lỗi khi tải Dashboard:', err);
    // Dự phòng an toàn từ fallbackProjects nếu có
    if (fallbackProjects && Array.isArray(fallbackProjects) && fallbackProjects.length) {
      const totalProjects = fallbackProjects.length;
      const totalTasks = fallbackProjects.reduce((s, p) => s + (p.task_count || 0), 0);
      const doneTasks = fallbackProjects.reduce((s, p) => s + (p.done_count || 0), 0);
      const pct = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;
      $('#dash-total-projects').textContent = totalProjects;
      $('#dash-total-tasks').textContent = totalTasks;
      $('#dash-stat-done').textContent = doneTasks;
      $('#dash-overall-progress').textContent = `${pct}% Hoàn thành`;
      if (totalTasks > 0) {
        $('#dash-bar-done').style.width = `${pct}%`;
      }
      const progList = $('#dash-project-progress-list');
      progList.innerHTML = fallbackProjects
        .map((p) => {
          const pPct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
          return `
            <div class="dash-project-row" data-id="${p.id}" title="Nhấn để mở dự án">
              <div class="dash-project-header">
                <strong>${esc(p.name)}</strong>
                <span class="muted small"><strong>${pPct}%</strong> (${p.done_count}/${p.task_count})</span>
              </div>
              <div class="progress" style="margin: 4px 0 0;"><div style="width:${pPct}%"></div></div>
            </div>`;
        })
        .join('');
      progList.querySelectorAll('.dash-project-row').forEach((el) => {
        el.onclick = () => openProject(el.dataset.id).catch((e) => toast(e.message, true));
      });
    }
  }
}

if ($('#refresh-dash-btn')) {
  $('#refresh-dash-btn').onclick = async () => {
    try {
      await loadProjects();
      toast('Đã cập nhật dữ liệu tổng quan');
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- Danh sách dự án ----------
async function loadProjects() {
  const isMember = state.user && state.user.role === 'member' && state.user.email !== 'manager@demo.com';
  if ($('#new-project-form')) $('#new-project-form').hidden = isMember;
  if ($('#member-account-notice')) $('#member-account-notice').hidden = !isMember;

  const projects = await api('/projects');
  await loadDashboard(projects);
  const list = $('#project-list');
  if (!projects.length) {
    list.innerHTML = `<p class="muted">${isMember ? 'Bạn chưa được phân công vào dự án nào.' : 'Bạn chưa tham gia dự án nào. Hãy tạo dự án mới.'}</p>`;
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
  if (state.user && state.user.role === 'member' && state.user.email !== 'manager@demo.com') {
    toast('Tài khoản thành viên không có quyền tạo dự án. Chỉ trưởng nhóm mới có thể tạo dự án mới.', true);
    return;
  }
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
  state.project = null;
  updateChatContext();
  showView('projects-view');
  loadProjects().catch((err) => toast(err.message, true));
};

// ---------- Chi tiết dự án ----------
async function openProject(id) {
  state.project = { id: Number(id) };
  await refreshProject();
  updateChatContext();
  showView('project-view');
  setTab('tasks');
}

function setTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
  const loaders = {
    tasks: loadTasks,
    stats: loadStats,
    ai: () => { initChat(); updateChatContext(); },
    activity: () => loadActivity(true),
    lab: loadLab,
    members: renderMembersTab,
  };
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
        <td class="actions">
          <button class="btn small" data-comments="${t.id}" type="button">Bình luận</button>
          <span class="mgr">
            <button class="btn small" data-edit="${t.id}" type="button">Sửa</button>
            <button class="btn small danger" data-del="${t.id}" type="button">Xóa</button>
          </span>
        </td>
      </tr>`
    )
    .join('');

  body.querySelectorAll('[data-status]').forEach((sel) => {
    sel.onchange = () => updateTask(sel.dataset.status, { status: sel.value });
  });
  body.querySelectorAll('[data-comments]').forEach((b) => {
    b.onclick = () => {
      const t = state.tasks.find((x) => String(x.id) === b.dataset.comments);
      openComments(t.id, t.title).catch((err) => toast(err.message, true));
    };
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
  if (!state.isManager) {
    toast('Chỉ chủ dự án mới có quyền xóa nhiệm vụ', true);
    return;
  }
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
  if (!state.isManager) {
    toast('Chỉ chủ dự án mới có quyền thêm hoặc sửa nhiệm vụ', true);
    return;
  }
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
  if (!state.isManager) {
    toast('Chỉ chủ dự án mới có quyền thêm hoặc sửa nhiệm vụ', true);
    return;
  }
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

// ---------- Báo cáo và Thống kê ----------
let currentStatsData = null;

async function loadStats() {
  const s = await api(`/projects/${state.project.id}/stats`);
  currentStatsData = s;

  // 1. Số công việc hoàn thành và quá hạn & Thẻ tổng quan
  const cards = [
    ['Tổng nhiệm vụ', s.total],
    ['Hoàn thành', s.done],
    ['Đang thực hiện', (s.byStatus && s.byStatus.doing) || 0],
    ['Quá hạn', s.overdue],
  ];
  $('#stat-cards').innerHTML = cards
    .map(([label, value]) => `<div class="card stat"><span class="muted small">${label}</span><strong style="${label === 'Quá hạn' && value > 0 ? 'color:var(--danger)' : ''}">${value}</strong></div>`)
    .join('');

  // 2. Tỷ lệ hoàn thành dự án
  $('#stat-progress-badge').textContent = s.progress + '%';
  $('#stat-progress-fill').style.width = s.progress + '%';
  $('#stat-progress-sub').textContent = `Đã hoàn thành ${s.done} trong tổng số ${s.total} nhiệm vụ`;
  $('#stat-summary-tags').innerHTML = `
    <span class="badge" style="background:#dcfce7;color:#166534">✓ ${s.done} Hoàn thành</span>
    <span class="badge" style="background:#fef3c7;color:#92400e">⚡ ${(s.byStatus && s.byStatus.doing) || 0} Đang làm</span>
    <span class="badge" style="background:#f3f4f6;color:#4b5563">📋 ${(s.byStatus && s.byStatus.todo) || 0} Chưa làm</span>
    ${s.overdue > 0 ? `<span class="badge danger">⚠ ${s.overdue} Quá hạn</span>` : '<span class="badge" style="background:#e0f2fe;color:#0369a1">✓ Đúng hạn</span>'}
  `;

  // Phân bổ trạng thái công việc
  $('#status-bars').innerHTML = Object.keys(STATUS_LABEL)
    .map((k) => {
      const n = (s.byStatus && s.byStatus[k]) || 0;
      const pct = s.total ? Math.round((n / s.total) * 100) : 0;
      return `<div class="bar-row"><span>${STATUS_LABEL[k]} (${n})</span><div class="bar"><div style="width:${pct}%"></div></div></div>`;
    })
    .join('');

  // 3. Biểu đồ hiệu suất theo thành viên
  const gradeBadge = (grade) => {
    if (grade === 'Xuất sắc') return '<span class="badge" style="background:#dcfce7;color:#166534">Xuất sắc</span>';
    if (grade === 'Tốt') return '<span class="badge" style="background:#e0f2fe;color:#0369a1">Tốt</span>';
    if (grade === 'Cần chú ý') return '<span class="badge danger">Cần chú ý</span>';
    return '<span class="badge" style="background:#f3f4f6;color:#4b5563">Đang làm</span>';
  };

  const members = s.byMember || [];
  $('#member-perf-chart').innerHTML = members.length
    ? members
        .map((m) => {
          const donePct = m.total ? Math.round((m.done / m.total) * 100) : 0;
          const openPct = m.total ? Math.round(((m.open - m.overdue) / m.total) * 100) : 0;
          const overduePct = m.total ? Math.round((m.overdue / m.total) * 100) : 0;
          return `
          <div class="chart-row">
            <div><strong>${esc(m.name)}</strong></div>
            <div class="perf-bar" title="Xong: ${m.done}, Đang mở: ${m.open - m.overdue}, Quá hạn: ${m.overdue}">
              <div class="perf-bar-done" style="width:${donePct}%"></div>
              <div class="perf-bar-open" style="width:${openPct}%"></div>
              <div class="perf-bar-overdue" style="width:${overduePct}%"></div>
            </div>
            <div style="font-weight:600;font-size:13px;text-align:right;">${donePct}%</div>
          </div>`;
        })
        .join('')
    : '<p class="muted">Chưa có thành viên nào.</p>';

  $('#member-stats').innerHTML = members.length
    ? members
        .map(
          (m) => `<tr>
            <td><strong>${esc(m.name)}</strong></td>
            <td>${m.total}</td>
            <td>${m.done}</td>
            <td>${m.open}</td>
            <td>${m.overdue ? `<span class="badge danger">${m.overdue}</span>` : '0'}</td>
            <td>
              <div style="display:flex;align-items:center;gap:6px;">
                <div class="progress" style="width:60px;margin:0;"><div style="width:${m.completion_rate || 0}%"></div></div>
                <span class="small">${m.completion_rate || 0}%</span>
              </div>
            </td>
            <td>${gradeBadge(m.performance_grade)}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="muted">Chưa có thành viên.</td></tr>';

  // 4. Báo cáo tiến độ theo tuần hoặc tháng
  renderTimelineReport();
}

function renderTimelineReport() {
  if (!currentStatsData || !currentStatsData.byPeriod) return;
  const periodType = $('#stat-period-select') ? $('#stat-period-select').value : 'month';
  const list = currentStatsData.byPeriod[periodType] || [];
  $('#timeline-title').textContent = `Báo cáo tiến độ ${periodType === 'week' ? 'theo tuần' : 'theo tháng'}`;
  $('#timeline-subtitle').textContent = `Khối lượng nhiệm vụ và mức độ hoàn thành ${periodType === 'week' ? 'từng tuần' : 'từng tháng'}`;

  // Biểu đồ timeline
  $('#timeline-chart').innerHTML = list.length
    ? list
        .map((p) => `
        <div class="chart-row">
          <div><strong class="small">${esc(p.label)}</strong></div>
          <div class="bar" style="height:14px;border-radius:7px;">
            <div style="width:${p.progress}%;background:var(--ok);"></div>
          </div>
          <div style="font-weight:600;font-size:13px;text-align:right;">${p.progress}%</div>
        </div>`)
        .join('')
    : '<p class="muted">Chưa có dữ liệu theo mốc thời gian.</p>';

  // Bảng timeline
  $('#timeline-rows').innerHTML = list.length
    ? list
        .map(
          (p) => `<tr>
            <td><strong>${esc(p.label)}</strong></td>
            <td>${p.total}</td>
            <td>${p.done}</td>
            <td>${p.doing}</td>
            <td>${p.todo}</td>
            <td>${p.overdue ? `<span class="badge danger">${p.overdue}</span>` : '0'}</td>
            <td>
              <div style="display:flex;align-items:center;gap:6px;">
                <div class="progress" style="width:60px;margin:0;"><div style="width:${p.progress}%"></div></div>
                <span class="small">${p.progress}%</span>
              </div>
            </td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="muted">Chưa có dữ liệu.</td></tr>';
}

// Bắt sự kiện chọn kỳ báo cáo
$('#stat-period-select').onchange = () => renderTimelineReport();

// 5. Xuất báo cáo Excel (CSV) và In / Xuất PDF
$('#btn-export-excel').onclick = async () => {
  try {
    const res = await fetch(`/api/projects/${state.project.id}/export/csv`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error('Không thể xuất file CSV');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bao-cao-${state.project.name.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Đã xuất báo cáo Excel (CSV) thành công');
  } catch (err) {
    toast(err.message, true);
  }
};

$('#btn-export-pdf').onclick = () => {
  $('#print-meta').textContent = `Dự án: ${state.project.name} | Người lập: ${state.user ? state.user.name : ''} | Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}`;
  window.print();
};

// ---------- Thành viên, lời mời và phân quyền ----------
async function refreshProject() {
  const p = await api(`/projects/${state.project.id}`);
  state.project = p;
  state.members = p.members;
  state.isManager = p.my_role === 'manager' || state.user?.email === 'manager@demo.com';
  state.isOwner = p.owner_id === state.user?.id || state.user?.email === 'manager@demo.com';
  $('#project-title').textContent = p.name;
  $('#project-desc').textContent = p.description || 'Chưa có mô tả';
  $('#project-dates').textContent =
    `Thời gian: ${p.start_date || '?'} → ${p.end_date || '?'} · Vai trò của bạn: ${ROLE_LABEL[p.my_role] || 'Thành viên'}` +
    (state.isOwner ? ' (chủ sở hữu)' : '');
  fillMemberSelects();
  $('#invite-role option[value="manager"]').disabled = !state.isOwner;
  applyRoleVisibility();
  await renderMembersTab();
}

async function renderMembersTab() {
  const [wl, invites] = await Promise.all([
    api(`/projects/${state.project.id}/workload`),
    state.isManager ? api(`/projects/${state.project.id}/invitations`) : Promise.resolve([]),
  ]);
  const byId = Object.fromEntries(wl.members.map((m) => [m.id, m]));
  const ownerId = state.project.owner_id;

  $('#member-rows').innerHTML = state.members
    .map((m) => {
      const w = byId[m.id] || { open: 0, overloaded: false };
      const isOwner = m.id === ownerId;
      const roleCell =
        state.isOwner && !isOwner
          ? `<select data-role="${m.id}">
               <option value="member" ${m.role === 'member' ? 'selected' : ''}>Thành viên</option>
               <option value="manager" ${m.role === 'manager' ? 'selected' : ''}>Chủ dự án</option>
             </select>`
          : `<span class="badge">${isOwner ? 'Chủ sở hữu' : ROLE_LABEL[m.role]}</span>`;
      const canRemove = state.isManager && m.id !== state.user.id && !isOwner && (m.role === 'member' || state.isOwner);
      const canLeave = m.id === state.user.id && !isOwner;
      return `<tr>
        <td><strong>${esc(m.name)}</strong><div class="muted small">${esc(m.email)}</div></td>
        <td>${roleCell}</td>
        <td>${w.open}${w.overloaded ? ' <span class="badge danger">Quá tải</span>' : ''}</td>
        <td class="actions">
          <button class="btn small" data-view="${m.id}" data-name="${esc(m.name)}" type="button">Xem việc</button>
          ${canRemove ? `<button class="btn small danger" data-remove="${m.id}" type="button">Xóa</button>` : ''}
          ${canLeave ? `<button class="btn small danger" data-leave="${m.id}" type="button">Rời dự án</button>` : ''}
        </td>
      </tr>`;
    })
    .join('');

  $('#member-rows').querySelectorAll('[data-role]').forEach((sel) => {
    sel.onchange = () => changeRole(sel.dataset.role, sel.value);
  });
  $('#member-rows').querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => showMemberTasks(b.dataset.view, b.dataset.name).catch((err) => toast(err.message, true));
  });
  $('#member-rows').querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = () => removeMember(b.dataset.remove, false);
  });
  $('#member-rows').querySelectorAll('[data-leave]').forEach((b) => {
    b.onclick = () => removeMember(b.dataset.leave, true);
  });

  $('#invite-list').innerHTML = invites.length
    ? invites
        .map(
          (i) => `<li class="row-between"><span>${esc(i.email)}
              <span class="muted small">· ${ROLE_LABEL[i.role]} · hết hạn ${esc(String(i.expires_at).slice(0, 10))}</span></span>
            <button class="btn small" data-cancel="${i.id}" type="button">Hủy lời mời</button></li>`
        )
        .join('')
    : '<li class="muted">Không có lời mời đang chờ.</li>';
  $('#invite-list').querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/projects/${state.project.id}/invitations/${b.dataset.cancel}`, { method: 'DELETE' });
        toast('Đã hủy lời mời');
        await renderMembersTab();
      } catch (err) {
        toast(err.message, true);
      }
    };
  });

  renderWorkload(wl);
}

function renderWorkload(wl) {
  $('#wl-note').textContent = `Ngưỡng quá tải: từ ${wl.threshold} việc đang mở. Tổng việc đang mở: ${wl.total_open}.`;
  $('#wl-bars').innerHTML = wl.members
    .map(
      (m) => `<div class="bar-row">
        <span>${esc(m.name)}${m.overloaded ? ' ⚠' : ''}</span>
        <div class="bar"><div style="width:${m.share}%"></div></div>
        <span class="muted small">${m.open} đang mở · ${m.share}%</span>
      </div>`
    )
    .join('');
}

async function changeRole(userId, role) {
  try {
    await api(`/projects/${state.project.id}/members/${userId}`, { method: 'PUT', body: { role } });
    toast('Đã đổi vai trò');
  } catch (err) {
    toast(err.message, true);
  }
  await refreshProject();
}

async function removeMember(userId, self) {
  if (!confirm(self ? 'Bạn chắc chắn muốn rời dự án?' : 'Xóa thành viên này khỏi dự án?')) return;
  try {
    await api(`/projects/${state.project.id}/members/${userId}`, { method: 'DELETE' });
  } catch (err) {
    return toast(err.message, true);
  }
  if (self) {
    toast('Bạn đã rời dự án');
    showView('projects-view');
    await loadProjects();
    return;
  }
  toast('Đã xóa thành viên');
  await refreshProject();
}

async function showMemberTasks(userId, name) {
  const d = await api(`/projects/${state.project.id}/members/${userId}/tasks`);
  $('#member-detail').hidden = false;
  $('#md-title').textContent = `Việc của ${name} (${d.tasks.length})`;
  $('#md-tasks').innerHTML = d.tasks.length
    ? d.tasks
        .map(
          (t) => `<li class="row-between"><span><strong>${esc(t.title)}</strong>
              <span class="muted small">${STATUS_LABEL[t.status]} · hạn ${esc(t.deadline || '—')}</span></span>
              ${t.overdue ? '<span class="badge danger">Quá hạn</span>' : ''}</li>`
        )
        .join('')
    : '<li class="muted">Chưa có việc nào được giao.</li>';
}
$('#md-close').onclick = () => ($('#member-detail').hidden = true);

$('#invite-form').onsubmit = async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  try {
    await api(`/projects/${state.project.id}/invitations`, { method: 'POST', body: d });
    e.target.reset();
    toast('Đã gửi lời mời');
    await renderMembersTab();
  } catch (err) {
    toast(err.message, true);
  }
};

$('#project-delete').onclick = async () => {
  if (!state.isOwner) {
    toast('Tài khoản thành viên không có quyền xóa dự án', true);
    return;
  }
  if (!confirm('Xóa dự án này? Toàn bộ nhiệm vụ và nhật ký sẽ bị xóa, không khôi phục được.')) return;
  try {
    await api(`/projects/${state.project.id}`, { method: 'DELETE' });
    toast('Đã xóa dự án');
    showView('projects-view');
    await loadProjects();
  } catch (err) {
    toast(err.message, true);
  }
};

// Lời mời đang chờ hiển thị ở đầu trang danh sách dự án
async function loadInvBanner() {
  const list = await api('/invitations/mine');
  const box = $('#inv-banner');
  if (!list.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<div class="notice">
    <strong>Bạn có ${list.length} lời mời tham gia dự án</strong>
    ${list
      .map(
        (i) => `<div class="row-between" style="margin-top:8px">
          <span>${esc(i.project_name)} · ${ROLE_LABEL[i.role]} · mời bởi ${esc(i.invited_by_name || 'chủ dự án')}</span>
          <span>
            <button class="btn small primary" data-acc="${i.id}" type="button">Chấp nhận</button>
            <button class="btn small" data-dec="${i.id}" type="button">Từ chối</button>
          </span>
        </div>`
      )
      .join('')}
  </div>`;
  box.querySelectorAll('[data-acc]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/invitations/${b.dataset.acc}/accept`, { method: 'POST' });
        toast('Đã tham gia dự án');
      } catch (err) {
        toast(err.message, true);
      }
      await loadInvBanner();
      await loadProjects();
    };
  });
  box.querySelectorAll('[data-dec]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/invitations/${b.dataset.dec}/decline`, { method: 'POST' });
      } catch (err) {
        toast(err.message, true);
      }
      await loadInvBanner();
    };
  });
}

// ---------- Trợ lý AI: Chatbox hội thoại hai chiều ----------
let chatHistory = [];

function updateChatContext() {
  const ctxEl = $('#ai-chat-context-name');
  if (ctxEl) {
    if (state.project && state.project.name) {
      ctxEl.textContent = `Dự án: ${state.project.name}`;
    } else {
      ctxEl.textContent = 'Toàn bộ các dự án';
    }
  }
}

function initChat() {
  if (!chatHistory.length) {
    chatHistory = [
      {
        role: 'ai',
        text: '👋 Xin chào! Tôi là Trợ lý AI quản lý dự án. Tôi có thể hỗ trợ bạn kiểm tra tiến độ, rà soát nhiệm vụ quá hạn, theo dõi khối lượng công việc của thành viên hoặc đề xuất các nhiệm vụ cần ưu tiên tiếp theo.\n\nBạn có thể chọn câu hỏi gợi ý bên dưới hoặc nhập câu hỏi trực tiếp!',
        time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      },
    ];
  }
  renderChatMessages();
}

function formatChatText(text) {
  if (!text) return '';
  let s = esc(text);

  // Tiêu đề dạng ### hoặc ##
  s = s.replace(/#{2,3}\s*(.+)/g, '<div class="chat-section-title">$1</div>');

  // In đậm **text**
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Khối từ chối theo nguyên tắc Grounding & Chống bịa đặt (Anti-hallucination)
  s = s.replace(
    /(?:<div class="chat-gap"><\/div>)?\s*🚫\s*<strong>TỪ CHỐI CUNG CẤP THÔNG TIN[^<]*<\/strong>/g,
    '<div class="chat-refusal-card"><span style="color:#ef4444;font-weight:700;">🚫 TỪ CHỐI CUNG CẤP THÔNG TIN (TUÂN THỦ NGUYÊN TẮC GROUNDING & CHỐNG BỊA ĐẶT)</span></div>'
  );

  // In nghiêng *text*
  s = s.replace(/\*(.*?)\*/g, '<em>$1</em>');

  // Mã inline `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Dòng gạch đầu dòng bullet
  s = s.replace(/(?:^|\n)[•\-]\s*(.+)/g, '<div class="chat-bullet">• $1</div>');

  // Khoảng cách giữa các đoạn
  s = s.replace(/\n\n+/g, '<div class="chat-gap"></div>');
  s = s.replace(/\n/g, '<br>');

  return s;
}

function renderChatMessages() {
  const containers = [$('#ai-chat-messages'), $('#tab-chat-messages')].filter(Boolean);
  const html = chatHistory
    .map((msg) => {
      const isAi = msg.role === 'ai';
      if (msg.isOverload) {
        return `
          <div class="chat-bubble-row ai">
            <div class="ai-chat-avatar" style="width:28px;height:28px;font-size:14px;flex-shrink:0;">${msg.isSlow ? '⏳' : '🤖💤'}</div>
            <div>
              <div class="chat-bubble" style="background:transparent;padding:0;border:none;">
                <div class="chat-overload-card">
                  <div class="chat-overload-title">
                    <span>${msg.isSlow ? '⏳' : '🤖💤'}</span>
                    <span>${msg.isSlow ? 'Trợ lý AI đang phản hồi chậm' : 'Trợ lý AI đang quá tải yêu cầu (429)'}</span>
                  </div>
                  <div class="chat-overload-body">
                    ${msg.isSlow
                      ? 'Hệ thống đã nhận yêu cầu nhưng máy chủ AI mất nhiều thời gian hơn bình thường để xử lý do tập dữ liệu lớn hoặc nghẽn mạng. Bạn có thể nhấn <strong>"Thử lại"</strong> hoặc xem nhanh báo cáo có sẵn.'
                      : 'Hiện tại có nhiều yêu cầu gửi tới AI cùng lúc. Để bảo vệ dữ liệu và chất lượng phân tích, hệ thống tạm thời giới hạn tần suất. Bạn vui lòng chờ ít giây rồi thử lại.'}
                  </div>
                  <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                    <button type="button" class="chat-overload-btn" data-retry="${esc(msg.retryMsg)}">🔄 Thử lại tin nhắn này</button>
                    <button type="button" class="btn small" onclick="setTab('stats')">📊 Xem thống kê dự án</button>
                  </div>
                </div>
              </div>
              <div class="chat-bubble-time">${esc(msg.time || '')}</div>
            </div>
          </div>
        `;
      }
      const formatted = isAi ? formatChatText(msg.text) : esc(msg.text).replace(/\n/g, '<br>');
      return `
        <div class="chat-bubble-row ${isAi ? 'ai' : 'user'}">
          ${isAi ? '<div class="ai-chat-avatar" style="width:28px;height:28px;font-size:14px;flex-shrink:0;">🤖</div>' : ''}
          <div>
            <div class="chat-bubble">${formatted}</div>
            <div class="chat-bubble-time">${esc(msg.time || '')}</div>
          </div>
        </div>
      `;
    })
    .join('');

  containers.forEach((c) => {
    c.innerHTML = html;
    c.querySelectorAll('[data-retry]').forEach((btn) => {
      btn.onclick = () => sendChatMessage(btn.dataset.retry);
    });
    c.scrollTop = c.scrollHeight;
  });
}

async function sendChatMessage(text) {
  if (!text || !text.trim()) return;
  const q = text.trim();
  const time = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

  // 1. Thêm tin nhắn của User
  chatHistory.push({ role: 'user', text: q, time });
  renderChatMessages();

  // 2. Thêm hiệu ứng AI đang soạn câu trả lời
  const containers = [$('#ai-chat-messages'), $('#tab-chat-messages')].filter(Boolean);
  containers.forEach((c) => {
    const typingRow = document.createElement('div');
    typingRow.className = 'chat-bubble-row ai chat-typing-temp';
    typingRow.innerHTML = `
      <div class="ai-chat-avatar" style="width:28px;height:28px;font-size:14px;flex-shrink:0;">🤖</div>
      <div class="chat-bubble">
        <div class="chat-typing">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    c.appendChild(typingRow);
    c.scrollTop = c.scrollHeight;
  });

  // Hiển thị gợi ý nếu AI phản hồi chậm hơn 3.5s
  const slowTimer = setTimeout(() => {
    containers.forEach((c) => {
      const bubble = c.querySelector('.chat-typing-temp .chat-bubble');
      if (bubble && !bubble.querySelector('.chat-typing-status')) {
        const statusSpan = document.createElement('div');
        statusSpan.className = 'chat-typing-status';
        statusSpan.textContent = '⏳ AI đang xử lý dữ liệu phức tạp, vui lòng đợi thêm giây lát...';
        bubble.appendChild(statusSpan);
      }
    });
  }, 3500);

  try {
    const res = await api('/ai/chat', {
      method: 'POST',
      body: {
        message: q,
        projectId: state.project ? state.project.id : null,
      },
    });

    clearTimeout(slowTimer);

    // Xóa typing indicator
    containers.forEach((c) => {
      c.querySelectorAll('.chat-typing-temp').forEach((el) => el.remove());
    });

    const aiTime = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    chatHistory.push({
      role: 'ai',
      text: res.answer || res.result?.summary || 'Đã ghi nhận yêu cầu của bạn.',
      time: aiTime,
    });
    renderChatMessages();
  } catch (err) {
    clearTimeout(slowTimer);

    containers.forEach((c) => {
      c.querySelectorAll('.chat-typing-temp').forEach((el) => el.remove());
    });

    const isOverload = err.status === 429 || err.code === 'AI_OVERLOADED' || /quá nhiều|quá tải|giới hạn/i.test(err.message);
    const isSlow = err.status === 504 || err.code === 'AI_TIMEOUT' || /chậm|timeout|quá thời gian/i.test(err.message);
    const aiTime = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

    if (isOverload || isSlow) {
      chatHistory.push({
        role: 'ai',
        isOverload: true,
        isSlow,
        retryMsg: q,
        time: aiTime,
      });
    } else {
      chatHistory.push({
        role: 'ai',
        text: `⚠️ ${err.message}`,
        time: aiTime,
      });
    }
    renderChatMessages();
  }
}

// Bắt sự kiện chatbox floating
if ($('#ai-chat-fab')) {
  $('#ai-chat-fab').onclick = () => {
    const win = $('#ai-chatbox-window');
    const isHidden = win.hidden;
    win.hidden = !isHidden;
    if (!win.hidden) {
      updateChatContext();
      if (!chatHistory.length) initChat();
      $('#ai-chat-input')?.focus();
    }
  };
}

if ($('#ai-chat-close')) {
  $('#ai-chat-close').onclick = () => {
    $('#ai-chatbox-window').hidden = true;
  };
}

if ($('#ai-chat-clear')) {
  $('#ai-chat-clear').onclick = () => {
    chatHistory = [];
    initChat();
    toast('Đã làm mới cuộc trò chuyện');
  };
}

if ($('#ai-chat-form')) {
  $('#ai-chat-form').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('#ai-chat-input');
    const msg = inp.value;
    inp.value = '';
    sendChatMessage(msg);
  };
}

// Bắt sự kiện chatbox trong tab AI
if ($('#tab-chat-form')) {
  $('#tab-chat-form').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('#tab-chat-input');
    const msg = inp.value;
    inp.value = '';
    sendChatMessage(msg);
  };
}

// Gán sự kiện click chip cho cả 2 khung
document.querySelectorAll('.ai-chip').forEach((btn) => {
  btn.onclick = () => {
    const q = btn.dataset.q;
    if (q) sendChatMessage(q);
  };
});

// ---------- Trợ lý AI: Phân tích tiến độ ----------
const SEV_LABEL = { high: 'Cao', medium: 'Trung bình', low: 'Thấp' };
const FIELD_LABEL = { priority: 'ưu tiên', status: 'trạng thái', deadline: 'hạn', assignee: 'người phụ trách' };

// Hai khung dùng chung cách hiển thị: Trợ lý AI và Phòng Thử prompt (so sánh dùng hàm riêng)
const PANELS = {
  ai: { variant: null, meta: '#ai-meta', notice: '#ai-notice', result: '#ai-result' },
};

if ($('#ai-analyze')) $('#ai-analyze').onclick = () => runAI('analyze');
if ($('#ai-simulate-overload')) $('#ai-simulate-overload').onclick = () => runAI('analyze', '', 'ai', true);
if ($('#ai-ask-form')) {
  $('#ai-ask-form').onsubmit = (e) => {
    e.preventDefault();
    const { question } = Object.fromEntries(new FormData(e.target));
    runAI('ask', question);
  };
}
document.querySelectorAll('.chip').forEach((c) => (c.onclick = () => runAI('ask', c.dataset.q)));

async function runAI(kind, question = '', panel = 'ai', simulateOverload = false) {
  const p = PANELS[panel];
  const box = $(p.result);
  box.innerHTML = '<p class="muted">AI đang phân tích dữ liệu dự án...</p>';
  $(p.notice).hidden = true;

  const payload = kind === 'ask' ? { question } : {};
  if (simulateOverload) payload.simulate = 'overload';
  if (p.variant) payload.variant = $(p.variant).value;
  const chosen = localStorage.getItem(`lab-variant-${state.project.id}`);
  if (chosen) payload.variant = chosen;

  try {
    const [data, tasks] = await Promise.all([
      api(`/projects/${state.project.id}/ai/${kind}`, { method: 'POST', body: payload }),
      api(`/projects/${state.project.id}/tasks`),
    ]);
    state.tasks = tasks;
    renderAiResult(data, p);
  } catch (err) {
    const isOverload = err.status === 429 || err.code === 'AI_OVERLOADED' || /quá nhiều|quá tải|giới hạn/i.test(err.message);
    const isSlow = err.status === 504 || err.code === 'AI_TIMEOUT' || /chậm|timeout|quá thời gian/i.test(err.message);

    if (isOverload || isSlow) {
      box.innerHTML = `
        <div class="ai-overload-screen">
          <div class="ai-overload-icon-wrap">${isSlow ? '⏳' : '🤖💤'}</div>
          <h3 class="ai-overload-title">
            ${isSlow ? 'Trợ lý AI đang phản hồi chậm hơn thường lệ' : 'Trợ lý AI hiện đang quá tải lượt yêu cầu (429)'}
          </h3>
          <p class="ai-overload-desc">
            ${isSlow
              ? 'Yêu cầu phân tích dự án đang mất nhiều thời gian hơn bình thường. Máy chủ AI có thể đang xử lý các phép tính phức tạp hoặc đường truyền mạng tạm thời bị nghẽn.'
              : 'Hệ thống vừa nhận được nhiều lượt gọi AI dồn dập. Để đảm bảo tính toàn vẹn và độ tin cậy của phân tích, yêu cầu được tạm hoãn trong giây lát.'}
          </p>
          <div class="ai-overload-tips">
            <div style="font-weight:600;margin-bottom:6px;">💡 Đừng lo lắng, dữ liệu của bạn hoàn toàn an toàn:</div>
            <div>• Toàn bộ nhiệm vụ, thành viên và tiến độ đã lưu trữ nguyên vẹn trên cơ sở dữ liệu.</div>
            <div>• Bạn có thể xem ngay tỷ lệ hoàn thành & biểu đồ phân bổ tại tab <strong>"Báo cáo & Thống kê"</strong>.</div>
            <div>• Vui lòng chờ 5-10 giây rồi nhấn nút <strong>"Thử lại phân tích"</strong> bên dưới.</div>
          </div>
          <div class="ai-overload-actions">
            <button type="button" class="btn primary" id="btn-retry-ai">🔄 Thử lại phân tích</button>
            <button type="button" class="btn" onclick="setTab('stats')">📊 Xem Báo cáo & Thống kê</button>
          </div>
        </div>
      `;
      const retryBtn = box.querySelector('#btn-retry-ai');
      if (retryBtn) {
        retryBtn.onclick = () => runAI(kind, question, panel);
      }
    } else {
      box.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    }
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

// ---------- Phòng thử prompt ----------
const LAB_USE_CASES = [
  { id: 'ask', label: 'Hỏi đáp dữ liệu dự án', enabled: true },
  { id: 'analyze', label: 'Phân tích nguy cơ trễ hạn', enabled: true },
  { id: 'report', label: 'Sinh báo cáo Sprint', enabled: false, why: 'Hệ thống chưa có dữ liệu Sprint' },
  { id: 'balance', label: 'Gợi ý cân đối phân công', enabled: false, why: 'Chưa có chức năng này' },
  { id: 'review', label: 'Review mã nguồn bằng AI', enabled: false, why: 'Dùng script npm run ai-review, không nằm trong giao diện' },
];
const LAB_VARIANT = {
  v1_basic: 'v1 — hỏi chung chung',
  v2_schema: 'v2 — có schema JSON',
  v3_final: 'v3 — hoàn chỉnh (quy tắc + JSON)',
};
// Ghi chú lấy từ số đo thật trong docs/ket-qua-lan*.md (3 lần × 5 trường hợp)
const LAB_NOTE = {
  v1_basic: 'Đúng schema 3/15 lần; thường thiếu trường summary.',
  v2_schema: 'Đúng schema 15/15 lần; không bịa task_id trong bộ thử.',
  v3_final: 'Đúng schema 15/15 lần; trên bộ thử kết quả giống v2.',
};
const labState = { useCase: 'analyze', templates: {}, results: {}, projectId: null };
const labChosenKey = () => `lab-variant-${state.project.id}`;

function renderLabChips() {
  $('#lab-chips').innerHTML = LAB_USE_CASES.map(
    (u) => `<button class="lab-chip ${u.id === labState.useCase ? 'on' : ''}" type="button" data-uc="${u.id}"
      ${u.enabled ? '' : `disabled title="${esc(u.why)}"`}>${esc(u.label)}</button>`
  ).join('');
  $('#lab-chips').querySelectorAll('[data-uc]').forEach((b) => {
    b.onclick = () => {
      labState.useCase = b.dataset.uc;
      labState.results = {};
      loadLab().catch((err) => toast(err.message, true));
    };
  });
}

async function loadLab() {
  if (labState.projectId !== state.project.id) {
    labState.projectId = state.project.id;
    labState.results = {};
  }
  renderLabChips();
  const kind = labState.useCase === 'ask' ? 'ask' : 'analyze';
  const list = await api(`/lab/variants?kind=${kind}`);
  labState.templates = Object.fromEntries(list.map((v) => [v.id, v.template]));
  $('#lab-schema').textContent =
    'Ràng buộc đầu ra: {"summary": chuỗi, "insufficient_data": true/false, "risks": [{task_id, task_title, severity, reason}], "priorities": [...], "workload_warnings": [...], "suggested_actions": [...]}';
  renderLabCols();
  await loadLabLogs();
}

function renderLabCols() {
  const chosen = localStorage.getItem(labChosenKey()) || 'v3_final';
  $('#lab-cols').innerHTML = Object.keys(LAB_VARIANT)
    .map((id) => {
      const r = labState.results[id];
      return `<div class="lab-col">
        <div class="row-between">
          <strong>${esc(LAB_VARIANT[id])}</strong>
          <span>${chosen === id ? '<span class="lab-using">● đang dùng</span>' : ''}
            <button class="btn small" type="button" data-choose="${id}">Chọn dùng</button></span>
        </div>
        <pre class="lab-prompt">${esc(labState.templates[id] || '')}</pre>
        <p class="muted small">${esc(LAB_NOTE[id])}</p>
        ${r ? renderLabResult(r) : '<p class="muted small">Chưa chạy.</p>'}
      </div>`;
    })
    .join('');
  $('#lab-cols').querySelectorAll('[data-choose]').forEach((b) => {
    b.onclick = () => {
      localStorage.setItem(labChosenKey(), b.dataset.choose);
      renderLabCols();
      toast(`Đã chọn ${LAB_VARIANT[b.dataset.choose]} cho Trợ lý AI`);
    };
  });
}

function renderLabResult(r) {
  const m = r.metrics;
  const hits = m.overdue_total ? `${m.overdue_hits}/${m.overdue_total}` : '—';
  const summary = r.result && r.result.summary ? r.result.summary.slice(0, 200) : '';
  return `<div class="lab-res ${m.json_ok ? 'ok' : 'bad'}">
    <div><strong>${m.json_ok ? 'Hợp lệ' : 'Sai định dạng, dùng kết quả dự phòng'}</strong>
      · ${r.mode === 'live' ? esc(r.provider) : 'dự phòng'}${r.retried ? ' · đã thử lại' : ''}</div>
    <div class="small">Nêu quá hạn: ${hits} · Mục bị loại: ${m.dropped ?? '—'} · Rủi ro: ${m.risks ?? '—'}</div>
    ${summary ? `<div class="small muted">${esc(summary)}</div>` : ''}
  </div>`;
}

async function runLabAll() {
  const btn = $('#lab-run-all');
  const kind = labState.useCase === 'ask' ? 'ask' : 'analyze';
  let question = '';
  if (kind === 'ask') {
    question = (window.prompt('Câu hỏi để thử:', 'Nhiệm vụ nào đang quá hạn?') || '').trim();
    if (!question) return;
  }
  btn.disabled = true;
  btn.textContent = 'Đang chạy...';
  try {
    const { runs } = await api(`/projects/${state.project.id}/ai/compare`, {
      method: 'POST',
      body: { kind, question },
    });
    labState.results = Object.fromEntries(runs.map((r) => [r.variant, r]));
    renderLabCols();
    await loadLabLogs();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '✦ Chạy tất cả phiên bản';
  }
}
$('#lab-run-all').onclick = runLabAll;

async function loadLabLogs() {
  const rows = await api(`/projects/${state.project.id}/ai/logs`);
  $('#lab-log-title').textContent = `Nhật ký thử nghiệm đã ghi nhận (${rows.length})`;
  $('#lab-log').innerHTML = rows.length
    ? rows
        .map(
          (r) => `<li><strong>${r.kind === 'ask' ? 'Hỏi đáp' : 'Phân tích'}</strong> — ${esc(r.prompt.slice(0, 80))}
            <span class="muted small">${esc(r.mode)} · ${esc(r.user_name || '')} · ${esc(r.created_at)}</span></li>`
        )
        .join('')
    : '<li class="muted">Chưa có lần chạy nào. Bấm "Chạy tất cả phiên bản" để tạo nhật ký.</li>';
}

// ---------- Lịch sử hoạt động ----------
let actBefore = null;
async function loadActivity(reset = true) {
  if (reset) {
    actBefore = null;
    $('#activity-list').innerHTML = '';
  }
  const qs = new URLSearchParams({ limit: '30' });
  if (actBefore) qs.set('before', actBefore);
  const rows = await api(`/projects/${state.project.id}/activity?${qs}`);
  const html = rows
    .map(
      (r) => `<li><strong>${esc(r.user_name || 'Hệ thống')}</strong> ${esc(r.action)}
        ${r.task_id ? `<button class="btn small" data-hist="${r.task_id}" type="button">Xem việc</button>` : ''}
        <span class="muted small">${esc(r.created_at)}</span></li>`
    )
    .join('');
  const empty = reset && !rows.length ? '<li class="muted">Chưa có hoạt động.</li>' : '';
  $('#activity-list').insertAdjacentHTML('beforeend', html || empty);
  if (rows.length) actBefore = rows[rows.length - 1].id;
  $('#act-more').hidden = rows.length < 30;
}
$('#act-more').onclick = () => loadActivity(false).catch((err) => toast(err.message, true));
$('#activity-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hist]');
  if (!b) return;
  openComments(b.dataset.hist, `Việc #${b.dataset.hist}`).catch((err) => toast(err.message, true));
});

// ---------- Bình luận trên từng công việc ----------
let cmTaskId = null;
async function openComments(taskId, title) {
  cmTaskId = taskId;
  const [comments, history] = await Promise.all([
    api(`/tasks/${taskId}/comments`),
    api(`/projects/${state.project.id}/activity?task_id=${taskId}&limit=100`),
  ]);
  $('#cm-title').textContent = title;
  $('#cm-list').innerHTML = comments.length
    ? comments
        .map(
          (c) => `<li>
            <div class="row-between">
              <span><strong>${esc(c.user_name || '(đã xóa)')}</strong>
                <span class="muted small">${esc(c.created_at)}</span></span>
              ${c.user_id === state.user.id || state.isManager
                ? `<button class="btn small danger" data-delc="${c.id}" type="button">Xóa</button>`
                : ''}
            </div>
            <div>${esc(c.body)}</div>
          </li>`
        )
        .join('')
    : '<li class="muted">Chưa có bình luận.</li>';
  $('#cm-list').querySelectorAll('[data-delc]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/comments/${b.dataset.delc}`, { method: 'DELETE' });
        await openComments(taskId, title);
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
  $('#cm-history').innerHTML = history.length
    ? history
        .map(
          (h) => `<li><strong>${esc(h.user_name || 'Hệ thống')}</strong> — ${esc(h.action)}
            <span class="muted small">${esc(h.created_at)}</span></li>`
        )
        .join('')
    : '<li class="muted">Chưa có lịch sử.</li>';
  $('#comment-dialog').showModal();
}

$('#cm-close').onclick = () => $('#comment-dialog').close();
$('#cm-form').onsubmit = async (e) => {
  e.preventDefault();
  const { body: text } = Object.fromEntries(new FormData(e.target));
  try {
    await api(`/tasks/${cmTaskId}/comments`, { method: 'POST', body: { body: text } });
    e.target.reset();
    await openComments(cmTaskId, $('#cm-title').textContent);
  } catch (err) {
    toast(err.message, true);
  }
};

// ---------- Thông báo ----------
let notifTimer = null;

async function loadNotifCount() {
  const r = await api('/notifications?limit=1');
  $('#notif-count').textContent = r.unread_count ? `${r.unread_count}` : '';
}

async function renderNotifPanel() {
  const r = await api('/notifications?limit=30');
  const panel = $('#notif-panel');
  panel.innerHTML = `
    <div class="row-between">
      <strong>Thông báo</strong>
      <button class="btn small" id="notif-readall" type="button">Đánh dấu đã đọc tất cả</button>
    </div>
    <ul class="list">
      ${r.items.length
        ? r.items
            .map(
              (n) => `<li class="${n.read_at ? 'muted' : ''}" data-nid="${n.id}" data-pid="${n.project_id || ''}"
                style="cursor:pointer">
                <strong>${esc(n.message)}</strong>
                <div class="small muted">${esc(n.project_name || '')} · ${esc(n.created_at)}</div>
              </li>`
            )
            .join('')
        : '<li class="muted">Không có thông báo.</li>'}
    </ul>`;
  panel.querySelectorAll('[data-nid]').forEach((li) => {
    li.onclick = async () => {
      await api(`/notifications/${li.dataset.nid}/read`, { method: 'POST' });
      panel.hidden = true;
      await loadNotifCount();
      if (li.dataset.pid) {
        openProject(li.dataset.pid).catch((err) => toast(err.message, true));
      }
    };
  });
  $('#notif-readall').onclick = async () => {
    await api('/notifications/read-all', { method: 'POST' });
    await renderNotifPanel();
    await loadNotifCount();
  };
}

$('#notif-btn').onclick = async () => {
  const panel = $('#notif-panel');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  await renderNotifPanel().catch((err) => toast(err.message, true));
  panel.hidden = false;
};

function startNotifPolling() {
  clearInterval(notifTimer);
  loadNotifCount().catch(() => {});
  notifTimer = setInterval(() => loadNotifCount().catch(() => {}), 60000);
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
