const prompts = require('./prompts');

const PROVIDER = (process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'offline')).toLowerCase();
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);
const RETRY_DELAY_MS = Number(process.env.AI_RETRY_DELAY_MS ?? 1500);
const ANONYMIZE = process.env.AI_ANONYMIZE === 'true';
const MAX_TASKS = 100; // Giới hạn dữ liệu gửi lên AI
const SEVERITIES = ['high', 'medium', 'low'];
const FIELDS = ['priority', 'status', 'deadline', 'assignee'];

class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byDeadline = (a, b) => (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31');

// ---------- Gọi dịch vụ AI, có timeout và phân loại lỗi ----------
async function postJson(url, headers, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new AiError('RATE_LIMIT', 'Dịch vụ AI đang giới hạn số lượt gọi');
    if (!res.ok) throw new AiError('MODEL_ERROR', `Dịch vụ AI trả về lỗi ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err.name === 'AbortError') throw new AiError('TIMEOUT', 'AI phản hồi quá lâu');
    throw new AiError('NETWORK', 'Không kết nối được tới dịch vụ AI');
  } finally {
    clearTimeout(timer);
  }
}

function need(name) {
  if (!process.env[name]) throw new AiError('CONFIG', `Thiếu biến môi trường ${name}`);
  return process.env[name];
}

// API key chỉ được đọc ở server, không bao giờ trả về trình duyệt
const providers = {
  anthropic: async (system, user) => {
    const data = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': need('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
      { model: process.env.AI_MODEL || 'claude-haiku-5-5', max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }
    );
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  },
  openai: async (system, user) => {
    const data = await postJson(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${need('OPENAI_API_KEY')}` },
      {
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }
    );
    return data.choices?.[0]?.message?.content || '';
  },
  gemini: async (system, user) => {
    const model = process.env.AI_MODEL || 'gemini-2.0-flash';
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { 'x-goog-api-key': need('GEMINI_API_KEY') },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }
    );
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('');
  },
  ollama: async (system, user) => {
    const data = await postJson(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {}, {
      model: process.env.AI_MODEL || 'llama3.1',
      stream: false,
      format: 'json',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    return data.message?.content || '';
  },
};

async function callProvider(system, user) {
  const fn = providers[PROVIDER];
  if (!fn) throw new AiError('CONFIG', 'AI chưa được bật (AI_PROVIDER)');
  return fn(system, user);
}

// ---------- Chuẩn bị dữ liệu: tối thiểu hóa, giới hạn, tùy chọn ẩn danh ----------
function prepareData(ctx, opts = {}) {
  const tasks = ctx.tasks.slice(0, MAX_TASKS);
  const anonymize = !!opts.anonymize;

  // Ẩn danh: thay tên thật bằng "Thành viên 1", "Thành viên 2", ...
  const aliasOf = new Map();
  ctx.members.forEach((m, i) => aliasOf.set(m.name, `Thành viên ${i + 1}`));
  const alias = (name) => {
    if (!name) return null;
    if (!anonymize) return name;
    return aliasOf.get(name) || 'Thành viên khác';
  };
  const hideNames = (text) => {
    if (!anonymize || !text) return text;
    let out = text;
    for (const [name, al] of aliasOf) out = out.split(name).join(al);
    return out;
  };

  // Bảng đảo để trả tên thật về cho người dùng sau khi AI trả lời
  const restoreMap = {};
  for (const [name, al] of aliasOf) restoreMap[al] = name;

  return {
    validIds: new Set(tasks.map((t) => t.id)),
    truncated: ctx.tasks.length > tasks.length,
    restoreMap: anonymize ? restoreMap : {},
    data: {
      project: {
        name: ctx.project.name,
        description: ctx.project.description,
        start_date: ctx.project.start_date,
        end_date: ctx.project.end_date,
        status: ctx.project.status,
      },
      members: ctx.members.map((m) => ({ name: alias(m.name), role: m.role })),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        deadline: t.deadline,
        assignee: alias(t.assignee),
        overdue: t.overdue,
      })),
      recent_activity: (ctx.activity || []).slice(0, 10).map((a) => ({
        who: alias(a.user_name),
        action: hideNames(a.action),
        at: a.created_at,
      })),
      total_tasks: ctx.tasks.length,
      shown_tasks: tasks.length,
    },
  };
}

// Đổi lại tên thật trong kết quả AI (chỉ có tác dụng khi bật AI_ANONYMIZE)
function restoreNames(result, restoreMap) {
  if (!restoreMap || Object.keys(restoreMap).length === 0) return result;
  const back = (s) => (typeof s === 'string' && Object.hasOwn(restoreMap, s) ? restoreMap[s] : s);
  result.workload_warnings = result.workload_warnings.map((w) => ({ ...w, member: back(w.member) }));
  result.suggested_actions = result.suggested_actions.map((a) =>
    a.field === 'assignee' ? { ...a, value: back(a.value) } : a
  );
  return result;
}

// ---------- Kiểm tra và làm sạch đầu ra của AI ----------
function stripFences(raw) {
  return String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function sanitize(obj, validIds) {
  const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  let dropped = 0;
  // Lấy tối đa max mục, giữ mục hợp lệ và đếm số mục bị loại
  const pick = (arr, max, keep) => {
    const items = Array.isArray(arr) ? arr.slice(0, max) : [];
    const ok = items.filter(keep);
    dropped += items.length - ok.length;
    return ok;
  };
  // Chỉ chấp nhận nhiệm vụ thật sự có trong dữ liệu gửi đi (chống bịa task_id)
  const known = (item) => item && typeof item === 'object' && validIds.has(Number(item.task_id));

  const result = {
    summary: str(obj.summary, 1000),
    insufficient_data: obj.insufficient_data === true,
    risks: pick(obj.risks, 10, known).map((r) => ({
      task_id: Number(r.task_id),
      task_title: str(r.task_title, 200),
      severity: SEVERITIES.includes(r.severity) ? r.severity : 'medium',
      reason: str(r.reason),
    })),
    priorities: pick(obj.priorities, 5, known).map((p) => ({
      task_id: Number(p.task_id),
      task_title: str(p.task_title, 200),
      reason: str(p.reason),
    })),
    workload_warnings: pick(obj.workload_warnings, 10, (w) => w && typeof w.member === 'string').map((w) => ({
      member: str(w.member, 100),
      open_tasks: Number(w.open_tasks) || 0,
      note: str(w.note),
    })),
    suggested_actions: pick(obj.suggested_actions, 10, (a) => known(a) && FIELDS.includes(a.field)).map((a) => ({
      task_id: Number(a.task_id),
      field: a.field,
      value: str(a.value, 100),
      reason: str(a.reason),
    })),
    _dropped: dropped,
  };
  if (!result.summary) throw new AiError('BAD_FORMAT', 'AI không có phần tóm tắt');
  return result;
}

function parseAnalysis(raw, validIds) {
  if (typeof raw !== 'string' || !raw.trim()) throw new AiError('EMPTY', 'AI trả về nội dung rỗng');
  let obj;
  try {
    obj = JSON.parse(stripFences(raw));
  } catch {
    throw new AiError('BAD_FORMAT', 'AI trả về sai định dạng JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new AiError('BAD_FORMAT', 'AI không trả về một đối tượng JSON');
  }
  return sanitize(obj, validIds);
}

// ---------- Kết quả dự phòng (không cần AI), cùng cấu trúc với kết quả AI ----------
function emptyResult(summary = '') {
  return { summary, insufficient_data: false, risks: [], priorities: [], workload_warnings: [], suggested_actions: [] };
}

function fallbackAnalysis(ctx) {
  const tasks = ctx.tasks;
  const open = tasks.filter((x) => x.status !== 'done').sort(byDeadline);
  const overdue = open.filter((x) => x.overdue);
  const highOpen = open.filter((x) => x.priority === 'high');
  const doneCount = tasks.length - open.length;
  const pct = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
  const load = {};
  for (const x of open) {
    const k = x.assignee || 'Chưa phân công';
    load[k] = (load[k] || 0) + 1;
  }
  return {
    summary: tasks.length
      ? `Đã hoàn thành ${doneCount}/${tasks.length} nhiệm vụ (${pct}%). Có ${overdue.length} nhiệm vụ quá hạn và ${highOpen.length} nhiệm vụ ưu tiên cao đang mở.`
      : 'Dự án chưa có nhiệm vụ nào.',
    insufficient_data: tasks.length === 0,
    risks: overdue.map((x) => ({
      task_id: x.id,
      task_title: x.title,
      severity: 'high',
      reason: `Hạn ${x.deadline} đã qua nhưng chưa hoàn thành`,
    })),
    priorities: highOpen.slice(0, 5).map((x) => ({ task_id: x.id, task_title: x.title, reason: 'Ưu tiên cao, chưa hoàn thành' })),
    workload_warnings: Object.entries(load)
      .filter(([, n]) => n >= 3)
      .map(([m, n]) => ({ member: m, open_tasks: n, note: 'Đang có từ 3 nhiệm vụ mở trở lên' })),
    suggested_actions: overdue
      .filter((x) => x.priority !== 'high')
      .map((x) => ({ task_id: x.id, field: 'priority', value: 'high', reason: 'Đã quá hạn, nên nâng ưu tiên' })),
  };
}

function offlineAnswer(ctx, question) {
  const q = String(question || '').toLowerCase();
  const tasks = ctx.tasks || [];
  const projectName = ctx.project?.name || 'dự án';

  if (/chào|hello|hi|xin chào|hey/.test(q)) {
    return `Xin chào! Tôi là Trợ lý AI của ${projectName}. Tôi có thể giúp bạn theo dõi tiến độ, kiểm tra các việc quá hạn, phân tích khối lượng công việc của từng thành viên hoặc gợi ý các việc cần ưu tiên làm ngay. Hãy hỏi tôi bất cứ điều gì!`;
  }
  if (/trễ|quá hạn|deadline|hạn/.test(q)) {
    const overdue = tasks.filter((x) => x.overdue);
    return overdue.length
      ? `Có ${overdue.length} nhiệm vụ quá hạn: ${overdue.map((x) => x.title).join(', ')}.`
      : `Tuyệt vời! Hiện tại trong ${projectName} không có công việc nào bị quá hạn.`;
  }
  if (/tiến độ|hoàn thành|bao nhiêu|tổng quan|tóm tắt|báo cáo/.test(q)) {
    const total = tasks.length;
    const done = tasks.filter((x) => x.status === 'done').length;
    const doing = tasks.filter((x) => x.status === 'doing').length;
    const overdue = tasks.filter((x) => x.overdue).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `Tiến độ ${projectName}: Đã hoàn thành ${done}/${total} nhiệm vụ (${pct}%). Hiện có ${doing} việc đang làm và ${overdue} việc quá hạn.`;
  }
  if (/ưu tiên|làm gì tiếp|cần làm|gợi ý|tiếp theo/.test(q)) {
    const highOpen = tasks.filter((x) => x.status !== 'done' && x.priority === 'high');
    const doing = tasks.filter((x) => x.status === 'doing');
    if (highOpen.length) {
      return `Các công việc ưu tiên cao cần tập trung: ${highOpen.map((x) => x.title).join(', ')}.`;
    }
    if (doing.length) {
      return `Nên tập trung hoàn thành các việc đang làm: ${doing.map((x) => x.title).join(', ')}.`;
    }
    return 'Hiện các công việc quan trọng đã được xử lý ổn thỏa. Bạn có thể giao thêm nhiệm vụ mới.';
  }
  if (/ai|thành viên|quá tải|khối lượng|nhiều việc/.test(q)) {
    const load = {};
    for (const t of tasks.filter((x) => x.status !== 'done')) {
      const a = t.assignee || 'Chưa phân công';
      load[a] = (load[a] || 0) + 1;
    }
    const entries = Object.entries(load).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return 'Hiện không có công việc mở nào được giao.';
    return 'Khối lượng công việc đang mở: ' + entries.map(([m, n]) => `${m} (${n} việc${n >= 3 ? ' - quá tải' : ''})`).join(', ') + '.';
  }
  return `Tôi đã nhận được câu hỏi về "${question}". Hiện tại trong ${projectName} có ${tasks.length} nhiệm vụ. Bạn có thể hỏi về tiến độ, việc quá hạn, ai đang nhiều việc nhất, hoặc thứ tự ưu tiên tiếp theo!`;
}

function fallback(kind, ctx, question, notice, truncated) {
  const result = kind === 'ask' ? emptyResult(offlineAnswer(ctx, question)) : fallbackAnalysis(ctx);
  return { mode: 'offline', provider: 'offline', prompt_version: '-', truncated, notice, result };
}

// ---------- Hàm chính: gọi AI, kiểm tra, thử lại một lần, dự phòng khi lỗi ----------
async function generate(kind, ctx, question = '', opts = {}) {
  const { data, validIds, truncated, restoreMap } = prepareData(ctx, { anonymize: ANONYMIZE });
  const variant = prompts.VARIANTS[opts.variant] || prompts.ACTIVE;
  const task = kind === 'ask' ? prompts.askTask(question) : prompts.ANALYZE_TASK;
  const user = variant.user(task, { today: ctx.today, data });
  const call = opts.call || providers[PROVIDER] || null;

  if (!call) {
    return fallback(kind, ctx, question, 'Chưa bật AI, hiển thị kết quả dự phòng.', truncated);
  }

  const attempt = async () => restoreNames(parseAnalysis(await call(variant.system, user), validIds), restoreMap);
  let retried = false;
  try {
    let result;
    try {
      result = await attempt();
    } catch (err) {
      // Chỉ thử lại với lỗi có thể khắc phục: bị giới hạn lượt gọi hoặc định dạng sai
      if (!['RATE_LIMIT', 'BAD_FORMAT', 'EMPTY'].includes(err.code)) throw err;
      retried = true;
      await sleep(RETRY_DELAY_MS);
      result = await attempt();
    }
    const dropped = result._dropped || 0;
    delete result._dropped;
    return {
      mode: 'live',
      provider: PROVIDER,
      prompt_version: variant.name,
      truncated,
      notice: '',
      retried,
      dropped,
      result,
    };
  } catch (err) {
    console.error(`[AI] ${err.code || 'ERROR'}: ${err.message}`);
    return {
      ...fallback(kind, ctx, question, '', truncated),
      retried,
    };
  }
}

// ---------- Chấm điểm một lần chạy để so sánh các biến thể prompt ----------
function scoreRun(run, ctx) {
  const live = run.mode === 'live';
  const overdueIds = ctx.tasks.filter((t) => t.overdue).map((t) => t.id);
  const foundIds = live ? run.result.risks.map((r) => r.task_id) : [];
  return {
    json_ok: live,
    retried: !!run.retried,
    dropped: live ? run.dropped || 0 : null,
    overdue_total: overdueIds.length,
    overdue_hits: live ? overdueIds.filter((id) => foundIds.includes(id)).length : null,
    risks: live ? run.result.risks.length : null,
    actions: live ? run.result.suggested_actions.length : null,
  };
}

module.exports = {
  generate,
  callProvider,
  prepareData,
  parseAnalysis,
  sanitize,
  stripFences,
  fallbackAnalysis,
  restoreNames,
  scoreRun,
  AiError,
  MAX_TASKS,
  PROVIDER,
};