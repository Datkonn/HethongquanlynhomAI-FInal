const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../src/db');

const problems = [];

const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') problems.push(`Lỗi cấu trúc file: ${integrity}`);

const fkErrors = db.pragma('foreign_key_check');
if (fkErrors.length) problems.push(`Khóa ngoại sai ở ${fkErrors.length} dòng`);

const orphan = db
  .prepare(
    `SELECT COUNT(*) AS n FROM tasks t
     WHERE t.assignee_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM project_members pm WHERE pm.project_id = t.project_id AND pm.user_id = t.assignee_id)`
  )
  .get().n;
if (orphan) problems.push(`${orphan} nhiệm vụ có người phụ trách không thuộc dự án`);

const noManager = db
  .prepare(
    `SELECT COUNT(*) AS n FROM projects p
     WHERE NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.role = 'manager')`
  )
  .get().n;
if (noManager) problems.push(`${noManager} dự án không có quản lý`);

const counts = {};
for (const t of ['users', 'projects', 'project_members', 'tasks', 'activity', 'ai_logs']) {
  counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}
console.log('Số dòng mỗi bảng:', counts);

if (problems.length) {
  console.log('PHÁT HIỆN LỖI:');
  problems.forEach((p) => console.log(' -', p));
  process.exitCode = 1;
} else {
  console.log('Dữ liệu nhất quán. Không có lỗi.');
}
db.close();