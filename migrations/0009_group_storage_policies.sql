-- ---------------------------------------------------------------------------
-- 补齐 group_storage_policies 到迁移层
--
-- 这张表原先**只在 src/db/provision.ts 里用 CREATE TABLE IF NOT EXISTS 建**
-- （自举时随 seedSystemData 一起执行），migrations/*.sql 里根本没有它。
--
-- 后果（真实故障）：`scripts/db-sync.mjs` 的「备库建表」如果只按
-- migrations/*.sql 建库，备库就会**缺这一张表** → 该表的数据永远同步不过去
-- （甚至整个备库同步被判为结构不完整）。这正是「配了 5 个库却只有一个能真正
-- 用上」的隐藏原因之一。
--
-- 迁到这里之后，migrations/*.sql 成为建表的**唯一事实来源**；
-- provision.ts 里那段保留（幂等），作为存量库的兜底，不会与新迁移冲突。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_storage_policies (
    group_id  INTEGER NOT NULL,
    policy_id INTEGER NOT NULL,
    PRIMARY KEY (group_id, policy_id)
);

-- 幂等回填：把 groups.storage_policy_id 这个旧的单策略字段灌进关联表。
-- 上游 GetByGroup（inventory/policy.go:145）假定每个组都有策略，
-- 组只绑一个策略时这里就是那一条。
INSERT INTO group_storage_policies (group_id, policy_id)
SELECT id, storage_policy_id FROM groups
WHERE storage_policy_id IS NOT NULL
ON CONFLICT (group_id, policy_id) DO NOTHING;
