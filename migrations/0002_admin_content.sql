-- =============================================================================
-- 0002 —— 管理后台内容表与 OAuth 应用
--
-- 补三张表，让官方前端的管理页面不再是 404：
--   oauth_clients / oauth_grants —— 管理后台「OAuth 应用」页 + 授权页
--   nodes                        —— 管理后台「节点」页（边缘版永远是空列表）
--
-- 列名严格对齐上游 ent schema（ent/schema/oauthclient.go、oauthgrant.go），
-- 前端字段名直接取这些列名的 JSON 形态，改名会让管理页静默读不到值。
--
-- 注意：scripts/migrate.mjs 按分号朴素切分语句，且会剥掉 `--` 之后的内容。
-- 因此本文件里不要出现字符串字面量包住的分号，也不要用 dollar-quoted 块。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- OAuth 应用（第三方接入 Cloudreve 的客户端）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_clients (
    id            SERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ,
    guid          TEXT NOT NULL,
    secret        TEXT NOT NULL,
    name          TEXT NOT NULL,
    homepage_url  TEXT,
    redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
    scopes        JSONB NOT NULL DEFAULT '[]'::jsonb,
    props         JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_enabled    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS oauthclient_guid ON oauth_clients (guid);

-- ---------------------------------------------------------------------------
-- 用户对 OAuth 应用的授权记录。user_id + client_id 唯一（原版就是这么约束的）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_grants (
    id           SERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ,
    user_id      INTEGER NOT NULL,
    client_id    INTEGER NOT NULL,
    scopes       JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS oauthgrant_user_id_client_id ON oauth_grants (user_id, client_id);
CREATE INDEX IF NOT EXISTS oauthgrant_client_id ON oauth_grants (client_id);

-- ---------------------------------------------------------------------------
-- 节点。边缘版是单体 Worker，没有 master/slave 概念，这张表只会是空的；
-- 建它是为了让管理后台「节点」页面正常渲染空列表，而不是抛 404。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nodes (
    id              SERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'slave',
    server          TEXT,
    slave_key       TEXT,
    capabilities    TEXT,
    weight          INTEGER,
    status          TEXT NOT NULL DEFAULT 'inactive',
    storage_policy_nodes INTEGER
);

CREATE INDEX IF NOT EXISTS node_storage_policy_nodes ON nodes (storage_policy_nodes);

-- ---------------------------------------------------------------------------
-- 外键
-- ---------------------------------------------------------------------------
ALTER TABLE oauth_grants DROP CONSTRAINT IF EXISTS oauth_grants_user_id_fkey;
ALTER TABLE oauth_grants ADD  CONSTRAINT oauth_grants_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE oauth_grants DROP CONSTRAINT IF EXISTS oauth_grants_client_id_fkey;
ALTER TABLE oauth_grants ADD  CONSTRAINT oauth_grants_client_id_fkey
    FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE;

ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_storage_policy_nodes_fkey;
ALTER TABLE nodes ADD  CONSTRAINT nodes_storage_policy_nodes_fkey
    FOREIGN KEY (storage_policy_nodes) REFERENCES storage_policies (id) ON DELETE SET NULL;
