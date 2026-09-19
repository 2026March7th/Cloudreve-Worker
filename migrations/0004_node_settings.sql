-- =============================================================================
-- 0004 —— 节点（admin/node）补齐
--
-- 上游 ent/schema/node.go：status 是 active/suspended 二值枚举、settings 是
-- NodeSetting JSON（aria2 / qBittorrent 下载器配置）。0002 建表时 status
-- 默认值写成了 'inactive'，这里对齐，并补上缺失的 settings 列。
-- =============================================================================

ALTER TABLE nodes DROP COLUMN IF EXISTS status;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
