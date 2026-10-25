-- 站点级一次性状态（原子抢占）。
--
-- 目前只有一个用途：「第一个管理员名额」。原来的做法是
--   SELECT isEmpty() → 是空的就 group_id = 1
-- 两条语句之间没有原子性：两个并发注册都会看到「站点为空」，于是产生两个管理员。
-- 用一个带主键的小表做栅栏，`INSERT ... ON CONFLICT DO NOTHING RETURNING` 天然原子，
-- 谁抢到谁当管理员。
CREATE TABLE IF NOT EXISTS site_state (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
