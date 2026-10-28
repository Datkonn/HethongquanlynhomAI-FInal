// Các biện pháp bảo mật ở tầng HTTP và vận hành

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

// Xóa nhật ký AI cũ hơn số ngày quy định (giảm thời gian lưu dữ liệu nhạy cảm)
function purgeOldAiLogs(db, days) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return db.prepare("DELETE FROM ai_logs WHERE created_at < datetime('now', ?)").run(`-${n} days`).changes;
}

module.exports = { securityHeaders, purgeOldAiLogs, CSP };