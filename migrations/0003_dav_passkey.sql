-- =============================================================================
-- 0003 —— WebDAV 账号与 Passkey
--
-- dav_accounts —— WebDAV 账号（/api/v4/devices/dav + /dav 协议端点）
-- passkeys     —— WebAuthn 凭据（/api/v4/user/authn + /session/authn）
--
-- 列名严格对齐上游 ent schema（ent/schema/davaccount.go、passkey.go）。
-- 注意：scripts/migrate.mjs 按分号朴素切分语句，且会剥掉 `--` 之后的内容。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- WebDAV 账号。options 是 boolset 的 bytea（bit 0=readonly 1=proxy 2=disable_sys_files，
-- 与上游 inventory/types 的 DavAccountReadOnly/Proxy/DisableSysFiles 顺序一致）。
-- owner_id + password 唯一 —— 上游用这个索引做 Basic Auth 查询。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dav_accounts (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    name        TEXT NOT NULL,
    uri         TEXT NOT NULL,
    password    TEXT NOT NULL,
    options     BYTEA NOT NULL,
    props       JSONB NOT NULL DEFAULT '{}'::jsonb,
    owner_id    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS davaccount_owner_id_password ON dav_accounts (owner_id, password);
CREATE INDEX IF NOT EXISTS davaccount_owner_id ON dav_accounts (owner_id);

-- ---------------------------------------------------------------------------
-- WebAuthn / Passkey 凭据。credential 存 JSON（webauthn.Credential 的序列化形态：
-- id / public_key(基64) / attestation_type / transport / flags 等）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS passkeys (
    id            SERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ,
    user_id       INTEGER NOT NULL,
    credential_id TEXT NOT NULL,
    name          TEXT NOT NULL,
    credential    JSONB NOT NULL,
    used_at       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS passkey_user_id_credential_id ON passkeys (user_id, credential_id);
CREATE INDEX IF NOT EXISTS passkey_credential_id ON passkeys (credential_id);
