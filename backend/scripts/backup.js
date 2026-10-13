const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../src/db');

async function main() {
  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `app-${stamp}.db`);
  await db.backup(dest); // sao lưu nhất quán, an toàn ngay cả khi server đang chạy
  console.log('Đã sao lưu tại:', dest);
  db.close();
}

main().catch((err) => {
  console.error('Sao lưu lỗi:', err.message);
  process.exit(1);
});