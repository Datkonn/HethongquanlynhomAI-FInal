process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'offline';
process.env.DB_FILE = require('path').join(require('os').tmpdir(), `pm-bench-${Date.now()}.db`);

const app = require('../src/server');
const http = require('http');

const server = app.listen(0);
const base = `http://localhost:${server.address().port}/api`;

async function call(method, path, token, body) {
  const t0 = performance.now();
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  await res.text();
  return { status: res.status, ms: performance.now() - t0, data: null };
}

async function token(email, name) {
  const r = await fetch(base + '/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: '123456' }),
  });
  return (await r.json()).token;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, avg: avg.toFixed(1), p50: pick(50).toFixed(1), p95: pick(95).toFixed(1), max: s[s.length - 1].toFixed(1) };
}

async function main() {
  const stamp = Date.now();
  const tk = await token(`bench${stamp}@test.local`, 'Đo hiệu năng');
  const p = await call('POST', '/projects', tk, { name: 'Dự án đo' });
  const pid = JSON.parse(await (await fetch(base + '/projects', { headers: { authorization: `Bearer ${tk}` } })).text())[0].id;

  const results = {};
  const N = 30; // số lần lặp mỗi thao tác

  // Thêm nhiệm vụ: đo khi dự án có 0, 100, 500 nhiệm vụ
  const addSamples = [];
  for (let i = 0; i < N; i++) {
    addSamples.push((await call('POST', `/projects/${pid}/tasks`, tk, { title: `Việc ${i}` })).ms);
  }
  results['Thêm nhiệm vụ'] = stats(addSamples);

  // Danh sách nhiệm vụ khi có nhiều dữ liệu
  for (let i = 0; i < 470; i++) {
    await fetch(base + `/projects/${pid}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tk}` },
      body: JSON.stringify({ title: `Việc lớn ${i}`, deadline: '2026-12-31' }),
    });
  }
  const listSamples = [];
  for (let i = 0; i < N; i++) listSamples.push((await call('GET', `/projects/${pid}/tasks?sort=priority`, tk)).ms);
  results['Danh sách 500 nhiệm vụ'] = stats(listSamples);

  const statSamples = [];
  for (let i = 0; i < N; i++) statSamples.push((await call('GET', `/projects/${pid}/stats`, tk)).ms);
  results['Thống kê 500 nhiệm vụ'] = stats(statSamples);

  // Phân tích AI ở chế độ dự phòng: đo phần xử lý nội bộ, không tính thời gian mô hình
  const aiSamples = [];
  for (let i = 0; i < 10; i++) aiSamples.push((await call('POST', `/projects/${pid}/ai/analyze`, tk, {})).ms);
  results['AI dự phòng (xử lý nội bộ)'] = stats(aiSamples);

  console.log('| Thao tác | Số lần | Trung bình (ms) | P50 (ms) | P95 (ms) | Lớn nhất (ms) |');
  console.log('|---|---|---|---|---|---|');
  for (const [name, r] of Object.entries(results)) {
    console.log(`| ${name} | ${r.n} | ${r.avg} | ${r.p50} | ${r.p95} | ${r.max} |`);
  }

  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});