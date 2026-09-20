-- 0006: 审计日志（边缘版自建 Pro 功能）
-- 对应前端管理设置「事件」标签（Event/Events.tsx）的 62 种 AuditLogType（0-61）。
-- 上游闭源 Pro 的表结构不可得，这里按自建需要设计：
--   audit_logs —— 审计事件流水（type 为前端 AuditLogType 枚举数值）
--
-- 写入走 logAudit()（services/audit.ts），按 audit_log_events 设置开关过滤，
-- 经 waitUntil 异步插入，不阻塞请求路径。

CREATE TABLE IF NOT EXISTS audit_logs (
    id         BIGSERIAL   PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id    INTEGER,
    type       INTEGER     NOT NULL,
    meta       JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_type ON audit_logs (type);
CREATE INDEX IF NOT EXISTS audit_logs_user_id ON audit_logs (user_id);
