-- ---------------------------------------------------------------------------
-- OIDC 第三方登录绑定（edge 自建实现）。
--
-- 官方开源版把「第三方登录」做成纯 Pro 装饰位：前端三个 checkbox 全部
-- checked={false} 且无 onChange，后端也没有消费者侧流程。边缘版补齐了
-- 通用 OIDC 授权码登录（service/oidc.ts），本表记录外部身份与本地账号的绑定。
--
-- 独立成表（而不是在 users 上加列）的理由：一个用户可绑定多个 IdP，
-- 后续接入更多 provider（QQ / Logto / Keycloak…）无需再改表结构。
--   subject = IdP 侧稳定用户标识（OIDC 的 sub）
--   issuer  = IdP 的 issuer（同一 subject 在不同 IdP 下含义不同，故需一起唯一）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_oidc_bindings (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id     INTEGER     NOT NULL,
    issuer      TEXT        NOT NULL,
    subject     TEXT        NOT NULL,
    email       TEXT,
    last_login  TIMESTAMPTZ
);

-- 同一 IdP 下同一 subject 只能绑定一个本地账号
CREATE UNIQUE INDEX IF NOT EXISTS user_oidc_bindings_issuer_subject
    ON user_oidc_bindings (issuer, subject);

CREATE INDEX IF NOT EXISTS user_oidc_bindings_user
    ON user_oidc_bindings (user_id);
