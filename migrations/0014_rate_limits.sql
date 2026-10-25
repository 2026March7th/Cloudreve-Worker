-- 限速计数（登录 / 2FA / 注册 / 找回密码 / 分享密码）。
--
-- 为什么不用 KV：Workers KV 的读是最终一致的（可能命中 60 秒内的旧值），
-- 「读-加一-写回」在连续请求里永远读到初始值 —— 实测 12 次登录尝试一次都没
-- 触发限制。计数必须放在有原子语义的地方，所以用数据库：一条
-- `INSERT ... ON CONFLICT DO UPDATE` 由行锁串行化，跨 colo 共享同一份计数。
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 1
);

-- 清理过期窗口用（cron 顺带删 window_start < now - 3600 的行）
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
