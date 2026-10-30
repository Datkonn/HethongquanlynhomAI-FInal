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
  const q = String(question || '').toLowerCase().trim();
  const tasks = ctx.tasks || [];
  const projectName = ctx.project?.name || 'dự án';
  const total = tasks.length;
  const done = tasks.filter((x) => x.status === 'done').length;
  const doing = tasks.filter((x) => x.status === 'doing').length;
  const todo = tasks.filter((x) => x.status === 'todo').length;
  const overdue = tasks.filter((x) => x.overdue);
  const pct = total ? Math.round((done / total) * 100) : 0;

  const prioText = { high: 'Cao', medium: 'Trung bình', low: 'Thấp' };
  const statusText = { todo: 'Chưa làm', doing: 'Đang làm', done: 'Hoàn thành' };

  // 1. Chào hỏi / Giới thiệu năng lực (nếu không hỏi cụ thể nhiệm vụ)
  const isGreeting = /(^|\s)(chào|hello|hi|hey)($|[\s!?,.])|xin chào|bạn là ai|giúp gì/i.test(q);

  // 2. Kiểm tra câu hỏi về một nhiệm vụ cụ thể hoặc câu hỏi kiểm thử nhiệm vụ không có trong CSDL
  let queriedTaskName = '';
  const quoteMatch = question.match(/["'“‘]([^"'”’]+)["'”’]/);
  if (quoteMatch) {
    queriedTaskName = quoteMatch[1].trim();
  } else {
    const taskPhraseMatch = question.match(/(?:nhiệm vụ|công việc|task|đầu việc|tính năng|module)\s+([^?.!,;:\n]+)/i);
    if (taskPhraseMatch) {
      const candidate = taskPhraseMatch[1].trim();
      const nonTaskWords = /^(nào|gì|ai|đang|bị|chưa|sắp|mới|quá hạn|ưu tiên|tiến độ|dự án|tổng quan)(\s|$)/i;
      if (!nonTaskWords.test(candidate)) {
        queriedTaskName = candidate;
      }
    }
  }

  // Kiểm tra nếu câu hỏi cố ý hỏi về nhiệm vụ không có trong CSDL hoặc test từ chối
  const isExplicitNonExistentTest = /không có trong (?:csdl|cơ sở dữ liệu|hệ thống)|không tồn tại|test việc không có|nhiệm vụ ảo|nhiệm vụ giả/i.test(q);

  if (queriedTaskName || isExplicitNonExistentTest) {
    // Tìm kiếm nhiệm vụ trong danh sách tasks
    const matchedTask = tasks.find((t) => {
      const tTitle = t.title.toLowerCase();
      if (queriedTaskName) {
        const qLower = queriedTaskName.toLowerCase();
        return tTitle.includes(qLower) || qLower.includes(tTitle);
      }
      return q.includes(tTitle) || (t.description && q.includes(t.description.toLowerCase()));
    });

    if (matchedTask) {
      return `📋 **THÔNG TIN CHI TIẾT NHIỆM VỤ**

• Tên nhiệm vụ: **${matchedTask.title}**
• Trạng thái: **${statusText[matchedTask.status] || matchedTask.status}**
• Mức ưu tiên: **${prioText[matchedTask.priority] || matchedTask.priority}**
• Hạn chót: **${matchedTask.deadline || 'Chưa đặt'}** ${matchedTask.overdue ? '⚠️ *(Đã quá hạn)*' : '✅ *(Đúng hạn)*'}
• Người phụ trách: **${matchedTask.assignee || 'Chưa phân công'}**
• Mô tả: ${matchedTask.description || 'Chưa có mô tả chi tiết.'}

💡 **Gợi ý xử lý:**
${matchedTask.overdue ? 'Nhiệm vụ này đã quá hạn, người phụ trách cần tập trung hoàn thành ngay.' : matchedTask.status === 'done' ? 'Nhiệm vụ đã hoàn thành tốt đẹp.' : 'Tiếp tục thực hiện và cập nhật trạng thái khi hoàn tất.'}`;
    }

    // NẾU HỎI VỀ NHIỆM VỤ KHÔNG CÓ TRONG CSDL -> TỪ CHỐI ĐÚNG QUY TẮC CHỐNG BỊA ĐẶT (GROUNDING)
    const stopWords = ['nào', 'gì', 'ai', 'sắp', 'quá hạn', 'trễ', 'ưu tiên', 'tiến độ', 'dự án', 'mới'];
    if (isExplicitNonExistentTest || (queriedTaskName && !stopWords.includes(queriedTaskName.toLowerCase()))) {
      const targetDisplay = queriedTaskName ? `"${queriedTaskName}"` : 'được yêu cầu';
      const sampleTasks = tasks
        .slice(0, 4)
        .map((t, idx) => `  ${idx + 1}. *${t.title}* (${statusText[t.status] || t.status})`)
        .join('\n');

      return `🚫 **TỪ CHỐI CUNG CẤP THÔNG TIN (TUÂN THỦ NGUYÊN TẮC GROUNDING & CHỐNG BỊA ĐẶT)**

Hệ thống đã tra cứu toàn bộ cơ sở dữ liệu của dự án **"${projectName}"** nhưng **KHÔNG TÌM THẤY** nhiệm vụ hoặc công việc:
👉 **${targetDisplay}**

⚖️ **Quy tắc an toàn của Trợ lý AI (Anti-hallucination):**
1. **Chống bịa đặt dữ liệu (No Hallucination)**: AI chỉ được phép tra cứu và phân tích trên các nhiệm vụ có thật đã lưu trong CSDL của hệ thống.
2. **Tuyệt đối không suy diễn**: Khi nhiệm vụ không tồn tại, AI bắt buộc phải từ chối thay vì tự ý tạo số liệu giả mạo về trạng thái, tiến độ, hạn chót hay người phụ trách.

💡 **Gợi ý dành cho bạn:**
• Kiểm tra lại tên nhiệm vụ hoặc từ khóa tìm kiếm.
• Danh sách một số nhiệm vụ thực tế đang có trong dự án:
${sampleTasks || '  *(Dự án hiện chưa có nhiệm vụ nào)*'}
• Nếu đây là một công việc mới cần triển khai, người quản lý có thể nhấn nút **"+ Nhiệm vụ"** trong tab Nhiệm vụ để thêm vào hệ thống.`;
    }
  }

  // 1. Chào hỏi / Giới thiệu năng lực
  if (isGreeting) {
    return `👋 **Xin chào! Tôi là Trợ lý AI Quản lý Dự án.**

Tôi đồng hành cùng bạn để theo dõi tiến độ và tối ưu hiệu suất cho **"${projectName}"**.

📊 **Tóm tắt nhanh trạng thái dự án:**
• Tổng số công việc: **${total} nhiệm vụ** (${done} đã xong - **${pct}%**)
• Đang thực hiện: **${doing}** việc | Chưa bắt đầu: **${todo}** việc
• Đáng lưu ý: **${overdue.length} nhiệm vụ quá hạn** ${overdue.length > 0 ? '⚠️' : '✅'}

🎯 **Tôi có thể hỗ trợ bạn:**
1. Rà soát chi tiết các **nhiệm vụ trễ hạn & điểm nghẽn**.
2. Phân tích **khối lượng công việc & cảnh báo quá tải** từng thành viên.
3. Đề xuất **thứ tự ưu tiên** công việc cần làm tiếp theo.
4. Báo cáo **tổng quan tiến độ** dự án và đưa ra lời khuyên quản lý.

*Hãy chọn gợi ý nhanh bên dưới hoặc đặt câu hỏi trực tiếp cho tôi!*`;
  }

  // 2. Nhiệm vụ quá hạn / trễ hạn / deadline
  if (/trễ|quá hạn|deadline|hạn chót|chậm tiến độ/i.test(q)) {
    if (!overdue.length) {
      return `✅ **TÌNH TRẠNG TIẾN ĐỘ: TỐT**

Hiện tại trong **"${projectName}"** không có công việc nào bị quá hạn. Toàn bộ các nhiệm vụ đang được thực hiện theo đúng kế hoạch.

💡 **Khuyến nghị:**
• Tiếp tục duy trì nhịp độ làm việc hiện tại.
• Rà soát các nhiệm vụ có hạn trong 3-5 ngày tới để đảm bảo không phát sinh trễ hạn mới.`;
    }

    const highOverdue = overdue.filter((t) => t.priority === 'high');
    const listStr = overdue
      .map(
        (t, idx) =>
          `• **${idx + 1}. ${t.title}**\n   - ⏰ Hạn chót: **${t.deadline || 'Không rõ'}** (đã quá hạn)\n   - 👤 Người phụ trách: **${t.assignee || 'Chưa giao'}**\n   - ⚡ Ưu tiên: **${prioText[t.priority] || t.priority}** | Trạng thái: **${statusText[t.status] || t.status}**`
      )
      .join('\n\n');

    return `⚠️ **BÁO CÁO CÔNG VIỆC QUÁ HẠN & ĐIỂM NGHẼN**

1. **Thực trạng:**
Có **${overdue.length} nhiệm vụ đã trễ hạn** cần can thiệp khẩn cấp:

${listStr}

2. **Đánh giá rủi ro & Tác động:**
• ${highOverdue.length ? `Có **${highOverdue.length} việc quá hạn mức ưu tiên CAO**, trực tiếp đe dọa đến tiến độ bàn giao của dự án.` : 'Các việc quá hạn ở mức độ trung bình/thấp, tuy nhiên cần xử lý ngay để tránh dồn ứ.'}
• Rủi ro phát sinh hiệu ứng domino làm chậm các công việc phụ thuộc tiếp theo.

3. **Khuyến nghị hành động:**
• **Bước 1**: Tập trung dứt điểm ngay các công việc trễ hạn có mức ưu tiên Cao.
• **Bước 2**: Trao đổi trực tiếp với người phụ trách để tháo gỡ vướng mắc kỹ thuật.
• **Bước 3**: Cập nhật lại mốc thời gian thực tế nếu kế hoạch cũ không còn khả thi.`;
  }

  // 3. Tiến độ / Hoàn thành / Báo cáo / Tổng quan
  if (/tiến độ|hoàn thành|tổng quan|tóm tắt|báo cáo|thống kê|tình hình/i.test(q)) {
    const statusAssess =
      pct >= 75
        ? 'Dự án đang ở giai đoạn nước rút với tỷ lệ hoàn thành rất tích cực.'
        : pct >= 40
        ? 'Dự án đang triển khai ổn định ở giai đoạn giữa.'
        : 'Dự án đang ở giai đoạn khởi động hoặc cần đẩy mạnh tiến độ hơn.';

    return `📊 **BÁO CÁO TIẾN ĐỘ DỰ ÁN "${projectName.toUpperCase()}"**

1. **Các chỉ số cốt lõi:**
• Tỷ lệ hoàn thành: **${pct}%** (${done}/${total} nhiệm vụ)
• Đang thực hiện: **${doing}** nhiệm vụ
• Chưa bắt đầu: **${todo}** nhiệm vụ
• Bị quá hạn: **${overdue.length}** nhiệm vụ ${overdue.length > 0 ? '⚠️' : '✅'}

2. **Nhận định & Đánh giá logic:**
• ${statusAssess}
• ${overdue.length ? `Hiện có **${overdue.length} điểm nghẽn trễ hạn** cần ưu tiên gỡ bỏ để đảm bảo mốc kết thúc dự án.` : 'Hiện không có điểm nghẽn nào về thời hạn.'}

3. **Đề xuất hành động trọng tâm:**
• Hoàn thành dứt điểm **${doing} việc đang làm** trước khi bắt đầu các nhiệm vụ mới.
• Thường xuyên kiểm tra danh sách nhiệm vụ sắp đến hạn để chủ động phân bổ nguồn lực.`;
  }

  // 4. Khối lượng công việc / Thành viên / Quá tải / Phân công
  if (/(^|\s)ai(\s|$|\?)|thành viên|quá tải|khối lượng|nhiều việc|phân công|gánh|phụ trách/i.test(q)) {
    const load = {};
    const unassigned = [];
    for (const t of tasks.filter((x) => x.status !== 'done')) {
      if (!t.assignee) {
        unassigned.push(t);
      } else {
        load[t.assignee] = (load[t.assignee] || 0) + 1;
      }
    }

    const entries = Object.entries(load).sort((a, b) => b[1] - a[1]);
    if (!entries.length && !unassigned.length) {
      return `👥 **PHÂN TÍCH KHỐI LƯỢNG CÔNG VIỆC**\n\nHiện tại tất cả công việc trong dự án đã được hoàn thành. Nhóm đang ở trạng thái rảnh rỗi.`;
    }

    const breakdownStr = entries
      .map(
        ([m, n], idx) =>
          `• **${idx + 1}. ${m}**: **${n} việc đang mở** ${n >= 3 ? '⚠️ *(Cảnh báo: Có nguy cơ quá tải)*' : '✅ *(Khối lượng ổn định)*'}`
      )
      .join('\n');

    const overloaded = entries.filter(([, n]) => n >= 3).map(([m]) => m);

    return `👥 **PHÂN TÍCH KHỐI LƯỢNG CÔNG VIỆC THÀNH VIÊN**

1. **Phân bổ công việc đang mở (Doing & Todo):**
${breakdownStr || '• Chưa có thành viên nào được giao việc mở.'}
${unassigned.length ? `• **Chưa phân công**: **${unassigned.length}** nhiệm vụ` : ''}

2. **Đánh giá mức độ cân bằng tải:**
• ${overloaded.length ? `Thành viên **${overloaded.join(', ')}** đang gánh từ 3 việc trở lên, có nguy cơ làm chậm tiến độ chung nếu bị quá tải.` : 'Khối lượng công việc giữa các thành viên đang được cân đối tốt.'}
• ${unassigned.length ? `Cần sớm phân công người chịu trách nhiệm cho ${unassigned.length} việc chưa giao.` : 'Tất cả các việc đang mở đều đã có người chịu trách nhiệm rõ ràng.'}

3. **Giải pháp điều phối:**
• Cân nhắc chuyển giao bớt nhiệm vụ chưa bắt đầu từ người quá tải sang thành viên có ít việc hơn.
• Giới hạn số việc "Đang làm" đồng thời tối đa 2 việc/người để tối ưu chất lượng.`;
  }

  // 5. Ưu tiên / Việc cần làm tiếp / Lộ trình / Next steps
  if (/ưu tiên|làm gì tiếp|cần làm|gợi ý|tiếp theo|hướng xử lý/.test(q)) {
    const highOpen = tasks.filter((x) => x.status !== 'done' && x.priority === 'high');
    const doingOpen = tasks.filter((x) => x.status === 'doing');
    const urgent = tasks
      .filter((x) => x.status !== 'done' && (x.overdue || x.priority === 'high'))
      .slice(0, 4);

    return `⚡ **ĐỀ XUẤT THỨ TỰ ƯU TIÊN THỰC HIỆN TIẾP THEO**

Dựa trên ma trận Mức độ ưu tiên & Thời hạn chót, thứ tự hành động hợp lý nhất là:

1. **Nhóm khẩn cấp (Ưu tiên giải quyết trước):**
${urgent.length ? urgent.map((t, i) => `• **${i + 1}. ${t.title}**\n   - Ưu tiên: **${prioText[t.priority]}** | Hạn: **${t.deadline || 'Chưa đặt'}**\n   - Phụ trách: **${t.assignee || 'Chưa giao'}**\n   - Lý do: ${t.overdue ? 'Đã quá hạn' : 'Ưu tiên cao cần đẩy nhanh'}`).join('\n\n') : '• Không có việc khẩn cấp nào.'}

2. **Nhóm việc đang làm (Cần hoàn thành dứt điểm):**
${doingOpen.length ? doingOpen.map((t) => `• **${t.title}** (Phụ trách: ${t.assignee || 'Chưa giao'})`).join('\n') : '• Hiện chưa có việc nào đang ở trạng thái Đang làm.'}

💡 **Nguyên tắc quản lý:**
• Áp dụng quy tắc "Xong việc cũ mới mở việc mới" để tránh dàn trải nguồn lực.
• Theo dõi chặt chẽ các mốc thời gian để ngăn ngừa phát sinh việc quá hạn mới.`;
  }

  // Phản hồi chung có cấu trúc
  return `Tôi đã ghi nhận câu hỏi của bạn: "${question}".

📌 **Thông tin dự án "${projectName}":**
• Tổng số nhiệm vụ: **${total}** (${done} hoàn thành - **${pct}%**)
• Đang thực hiện: **${doing}** | Chưa làm: **${todo}** | Quá hạn: **${overdue.length}**

💡 **Để tôi hỗ trợ bạn tốt nhất, bạn có thể hỏi cụ thể về:**
1. *"Nhiệm vụ nào đang bị quá hạn?"* -> Phân tích chi tiết rủi ro trễ hạn.
2. *"Ai đang có nhiều việc nhất?"* -> Báo cáo cân bằng khối lượng công việc.
3. *"Nên làm việc gì tiếp theo?"* -> Đề xuất thứ tự ưu tiên khoa học.
4. Hoặc hỏi tên một nhiệm vụ cụ thể để xem thông tin chi tiết.`;
}

function fallback(kind, ctx, question, notice, truncated) {
  const ans = kind === 'ask' ? offlineAnswer(ctx, question) : null;
  const isRefusal = ans && ans.includes('TỪ CHỐI CUNG CẤP THÔNG TIN');
  const result =
    kind === 'ask'
      ? { ...emptyResult(ans), insufficient_data: !!isRefusal }
      : fallbackAnalysis(ctx);
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