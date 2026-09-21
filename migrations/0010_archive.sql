-- ---------------------------------------------------------------------------
-- 归档表（archive_entries）
--
-- ## 为什么需要它
--
-- 用户现有 5 个 Neon。「5 个库全部当主库用」在架构上不成立（Neon 免费档
-- 没有多主复制，做成 5 写必然分裂）。所以给备库一个**天然不会冲突的
-- 用途**：存归档表。归档是「只增不改」的，多个库各存一份也不会互相矛盾。
--
-- ## 只增不改 = 数据表插入后不许修改/删除
--
-- 这是本文件的重点。归档的价值全在「可信」二字 —— 如果能被静默改写，
-- 它就不能用来核对「当时到底是什么值」。
--
-- SQL 层用三种手段锁死：
--   1. **主键 `entry_id`**（应用生成的 UUID）：重复插入同一 id 直接冲突，
--      不会覆盖已有归档。
--   2. **唯一约束 `(kind, object_id, at)`**：同一对象同一时刻只能有一条，
--      防止重放产生重复。
--   3. **触发器 `BEFORE UPDATE OR DELETE` 直接 RAISE**：任何 UPDATE/DELETE
--      都被数据库拒绝。这是真正的「只增不改」—— 应用层漏写检查也改不动。
--
-- 需要删数据时的做法：整表 `TRUNCATE`（运维操作，不走应用）。
-- 不给应用留任何「悄悄改一条」的入口。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS archive_entries (
    -- 应用生成的 UUID（不是自增）：跨库合并时不会撞 id。
    entry_id     TEXT        PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 归档对象的类别与标识，如 ('settings','global') / ('user','42')
    kind         TEXT        NOT NULL,
    object_id    TEXT        NOT NULL,
    -- **业务发生时间**（不是入库时间）—— 回放历史时要以它为准。
    at           TIMESTAMPTZ NOT NULL,
    -- 被归档的值（旧值）。jsonb 以便将来按字段查询。
    value        JSONB       NOT NULL,
    -- 谁触发的（用户 id / 'system' / 'cron'）
    actor        TEXT,
    note         TEXT,
    -- 数据来源库标识（1=主库，2..=备库），排查「这条是哪来的」用
    source       INTEGER     NOT NULL DEFAULT 1
);

-- 同一对象同一时刻只能有一条 —— 防重放。
CREATE UNIQUE INDEX IF NOT EXISTS archive_entries_kind_object_at
    ON archive_entries (kind, object_id, at);

-- 查某对象的历史（最新在前）
CREATE INDEX IF NOT EXISTS archive_entries_lookup
    ON archive_entries (kind, object_id, at DESC);

-- ---------------------------------------------------------------------------
-- 只增不改：数据库层拒绝 UPDATE / DELETE
--
-- 用触发器而不是「靠应用层自觉」——应用层有 30+ 处写路径，靠自觉必然漏。
-- 这里直接让数据库成为最后一道防线：任何试图修改归档的语句都会抛异常。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_entries_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'archive_entries is append-only: % is not allowed', TG_OP
        USING HINT = '归档不可修改/删除。确需清理请整表 TRUNCATE（运维操作）。';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS archive_entries_no_update ON archive_entries;
CREATE TRIGGER archive_entries_no_update
    BEFORE UPDATE ON archive_entries
    FOR EACH ROW EXECUTE FUNCTION archive_entries_immutable();

DROP TRIGGER IF EXISTS archive_entries_no_delete ON archive_entries;
CREATE TRIGGER archive_entries_no_delete
    BEFORE DELETE ON archive_entries
    FOR EACH ROW EXECUTE FUNCTION archive_entries_immutable();
