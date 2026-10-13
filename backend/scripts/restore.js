const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.log('Cách dùng: npm run restore -- backups\\ten-file.db');
  process.exit(1);
}

// Kiểm tra file sao lưu trước khi ghi đè
const check = new Database(src, { fileMustExist: true });
const ok = check.pragma('integrity_check', { simple: true });
check.close();
if (ok !== 'ok') {
  console.log('File sao lưu bị lỗi, không khôi phục:', ok);
  process.exit(1);
}

const target = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.truoc-khoi-phuc-${stamp}`);
for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true });
fs.copyFileSync(src, target);
console.log('Đã khôi phục từ:', src);
console.log('Hãy khởi động lại server (npm start).');