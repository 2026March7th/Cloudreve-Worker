-- =============================================================================
-- Cloudreve Edge — Neon (PostgreSQL) 初始化 schema
--
-- 本文件是 Cloudreve v4 `ent/schema/*.go` 在 PostgreSQL 上的等价映射。
-- 表名、列名、约束、索引名尽量与 ent 生成的保持一致，便于日后对照。
--
-- 与原始 Go 版的差异（有意为之）：
--   1. 去掉了 nodes / dav_accounts / fsevents / oauth_clients / oauth_grants /
--      passkeys 六张表 —— 边缘版不实现多节点集群、WebDAV、事件推送、OAuth
--      应用与 Passkey 登录（见 README 的「未实现」清单）。
--   2. 所有 JSON 列使用 jsonb（ent 用的是 json）。
--   3. 布尔位集（groups.permissions 等）使用 bytea，位序与原版一致（LSB-first）。
--   4. users.group_users 等外键保留，但部分 ON DELETE 行为做了收敛，见注释。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 用户组。付费相关字段一概没有；保留 name / max_storage / speed_limit，
-- 因为需求是「只砍付费，保留用户组配额」。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
    id                SERIAL PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ,
    name              TEXT        NOT NULL,
    max_storage       BIGINT,
    speed_limit       INTEGER,
    -- boolset.BooleanSet，LSB-first 位序，见 src/lib/boolset.ts
    permissions       BYTEA       NOT NULL DEFAULT ''::bytea,
    settings          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    storage_policy_id INTEGER
);

-- ---------------------------------------------------------------------------
-- 用户
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                SERIAL PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ,
    email             VARCHAR(100) NOT NULL,
    nick              VARCHAR(100) NOT NULL,
    -- 格式: "<salt>:<sha256hex(password+salt)>"，兼容 v2 的 "md5:<hash>:<salt>"
    password          TEXT,
    status            TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive', 'manual_banned', 'sys_banned')),
    storage           BIGINT      NOT NULL DEFAULT 0,
    two_factor_secret TEXT,
    avatar            TEXT,
    settings          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    group_users       INTEGER     NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email ON users (email);

-- ---------------------------------------------------------------------------
-- 存储策略。type 取值为 'r2'（边缘内置）或 'onedrive'，以及原版的其它取值
-- （'s3' / 'local' / 'remote' 等——非 r2/onedrive 的类型在当前实现下不可用，
-- 上传时会返回 40006 策略不允许）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_policies (
    id                  SERIAL PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    name                TEXT   NOT NULL,
    type                TEXT   NOT NULL,
    server              TEXT,
    bucket_name         TEXT,
    is_private          BOOLEAN,
    access_key          TEXT,
    secret_key          TEXT,
    max_size            BIGINT,
    dir_name_rule       TEXT,
    file_name_rule      TEXT,
    settings            JSONB  NOT NULL DEFAULT '{}'::jsonb,
    node_id             INTEGER
);

-- ---------------------------------------------------------------------------
-- 文件节点（文件夹与文件的统一模型）。注意：files 表没有 deleted_at，
-- 回收站是通过把 file_children 指向 trash 根实现的，与原版一致。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS files (
    id                   SERIAL PRIMARY KEY,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    type                 INTEGER NOT NULL,   -- 0=file 1=folder
    name                 TEXT    NOT NULL,
    owner_id             INTEGER NOT NULL,
    size                 BIGINT  NOT NULL DEFAULT 0,
    primary_entity       INTEGER,
    file_children        INTEGER,            -- 父目录 id；根目录为 NULL
    is_symbolic          BOOLEAN NOT NULL DEFAULT false,
    props                JSONB,
    storage_policy_files INTEGER
);

-- 同名兄弟节点唯一（根目录自身 file_children 为 NULL，不参与该索引）。
CREATE UNIQUE INDEX IF NOT EXISTS file_file_children_name
    ON files (file_children, name) WHERE file_children IS NOT NULL;

-- 每个用户只有一个根目录。「根目录」的判定条件与原版一致：
--   name = '' AND file_children IS NULL（见 inventory/file.go RootFolderName）。
-- 注意：回收站里的文件同样是 file_children IS NULL，但 name 非空，
-- 所以这里必须带上 name = '' 才不会被回收站项误伤。
CREATE UNIQUE INDEX IF NOT EXISTS file_owner_root
    ON files (owner_id) WHERE file_children IS NULL AND name = '';

-- 回收站列表用：file_children IS NULL 且 name 非空
CREATE INDEX IF NOT EXISTS file_owner_trash
    ON files (owner_id, type, updated_at) WHERE file_children IS NULL AND name <> '';

CREATE INDEX IF NOT EXISTS file_file_children_type_updated_at ON files (file_children, type, updated_at);
CREATE INDEX IF NOT EXISTS file_file_children_type_created_at ON files (file_children, type, created_at);
CREATE INDEX IF NOT EXISTS file_file_children_type_size       ON files (file_children, type, size);
CREATE INDEX IF NOT EXISTS file_owner_id                      ON files (owner_id);
CREATE INDEX IF NOT EXISTS file_primary_entity                ON files (primary_entity);

-- ---------------------------------------------------------------------------
-- 实体（文件的实际内容版本）。source 是存储后端里的对象键。
-- 注意列名 recycle_options 对应 ent 里的 Go 字段 props（StorageKey 改写过）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
    id                      SERIAL PRIMARY KEY,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at              TIMESTAMPTZ,
    type                    INTEGER NOT NULL,   -- 0=version 1=thumbnail 2=live_photo
    source                  TEXT    NOT NULL,
    size                    BIGINT  NOT NULL,
    reference_count         INTEGER NOT NULL DEFAULT 1,
    storage_policy_entities INTEGER NOT NULL,
    created_by              INTEGER,
    upload_session_id       UUID,
    recycle_options         JSONB
);

CREATE INDEX IF NOT EXISTS entity_storage_policy_entities ON entities (storage_policy_entities);
CREATE INDEX IF NOT EXISTS entity_source                  ON entities (source);

-- 文件 ↔ 实体 多对多
CREATE TABLE IF NOT EXISTS file_entities (
    file_id   INTEGER NOT NULL REFERENCES files (id)    ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
    PRIMARY KEY (file_id, entity_id)
);

-- ---------------------------------------------------------------------------
-- 分享链接。没有「付费分享」相关列。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shares (
    id               SERIAL PRIMARY KEY,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    password         TEXT,
    views            INTEGER NOT NULL DEFAULT 0,
    downloads        INTEGER NOT NULL DEFAULT 0,
    expires          TIMESTAMPTZ,
    remain_downloads INTEGER,
    props            JSONB,
    file_shares      INTEGER,
    user_shares      INTEGER
);

CREATE INDEX IF NOT EXISTS share_file_shares ON shares (file_shares);
CREATE INDEX IF NOT EXISTS share_user_shares ON shares (user_shares);

-- ---------------------------------------------------------------------------
-- 文件自定义元数据
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metadata (
    id         SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    name       TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    file_id    INTEGER NOT NULL,
    is_public  BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS metadata_file_id_name ON metadata (file_id, name);

-- ---------------------------------------------------------------------------
-- 文件外链（直链）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS direct_links (
    id         SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    name       TEXT    NOT NULL,
    downloads  INTEGER NOT NULL DEFAULT 0,
    speed      INTEGER NOT NULL DEFAULT 0,
    file_id    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS directlink_file_id ON direct_links (file_id);

-- ---------------------------------------------------------------------------
-- 站点设置（key-value）。原版 ent 里 name 是唯一索引。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
    id         SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    name       TEXT NOT NULL,
    value      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS setting_name ON settings (name);

-- ---------------------------------------------------------------------------
-- 异步任务。边缘版只用于「打包下载」这类需要跨请求保存状态的任务，
-- 不实现远程下载 / 解压 / 集群任务。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id              SERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    type            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'processing', 'suspending', 'error', 'canceled', 'completed')),
    public_state    JSONB NOT NULL DEFAULT '{}'::jsonb,
    private_state   TEXT,
    correlation_id  UUID,
    user_tasks      INTEGER
);

CREATE INDEX IF NOT EXISTS task_user_tasks ON tasks (user_tasks);

-- ---------------------------------------------------------------------------
-- 外键约束（放在建表之后，避免建表顺序造成的循环依赖）
-- ---------------------------------------------------------------------------
ALTER TABLE users              DROP CONSTRAINT IF EXISTS users_group_users_fkey;
ALTER TABLE users              ADD  CONSTRAINT users_group_users_fkey
    FOREIGN KEY (group_users) REFERENCES groups (id) ON DELETE NO ACTION;

ALTER TABLE groups             DROP CONSTRAINT IF EXISTS groups_storage_policy_id_fkey;
ALTER TABLE groups             ADD  CONSTRAINT groups_storage_policy_id_fkey
    FOREIGN KEY (storage_policy_id) REFERENCES storage_policies (id) ON DELETE SET NULL;

ALTER TABLE files              DROP CONSTRAINT IF EXISTS files_owner_id_fkey;
ALTER TABLE files              ADD  CONSTRAINT files_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE NO ACTION;

ALTER TABLE files              DROP CONSTRAINT IF EXISTS files_file_children_fkey;
ALTER TABLE files              ADD  CONSTRAINT files_file_children_fkey
    FOREIGN KEY (file_children) REFERENCES files (id) ON DELETE SET NULL;

ALTER TABLE files              DROP CONSTRAINT IF EXISTS files_storage_policy_files_fkey;
ALTER TABLE files              ADD  CONSTRAINT files_storage_policy_files_fkey
    FOREIGN KEY (storage_policy_files) REFERENCES storage_policies (id) ON DELETE SET NULL;

ALTER TABLE entities           DROP CONSTRAINT IF EXISTS entities_storage_policy_entities_fkey;
ALTER TABLE entities           ADD  CONSTRAINT entities_storage_policy_entities_fkey
    FOREIGN KEY (storage_policy_entities) REFERENCES storage_policies (id) ON DELETE NO ACTION;

ALTER TABLE entities           DROP CONSTRAINT IF EXISTS entities_created_by_fkey;
ALTER TABLE entities           ADD  CONSTRAINT entities_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE shares             DROP CONSTRAINT IF EXISTS shares_file_shares_fkey;
ALTER TABLE shares             ADD  CONSTRAINT shares_file_shares_fkey
    FOREIGN KEY (file_shares) REFERENCES files (id) ON DELETE SET NULL;

ALTER TABLE shares             DROP CONSTRAINT IF EXISTS shares_user_shares_fkey;
ALTER TABLE shares             ADD  CONSTRAINT shares_user_shares_fkey
    FOREIGN KEY (user_shares) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE metadata           DROP CONSTRAINT IF EXISTS metadata_file_id_fkey;
ALTER TABLE metadata           ADD  CONSTRAINT metadata_file_id_fkey
    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE NO ACTION;

ALTER TABLE direct_links       DROP CONSTRAINT IF EXISTS direct_links_file_id_fkey;
ALTER TABLE direct_links       ADD  CONSTRAINT direct_links_file_id_fkey
    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE NO ACTION;

ALTER TABLE tasks              DROP CONSTRAINT IF EXISTS tasks_user_tasks_fkey;
ALTER TABLE tasks              ADD  CONSTRAINT tasks_user_tasks_fkey
    FOREIGN KEY (user_tasks) REFERENCES users (id) ON DELETE SET NULL;

-- 说明：原版 storage_policies.node_id 指向 nodes 表。边缘版没有多节点，
-- 该列保留为普通可空整数（不建外键），以便将来需要时兼容原表结构。

