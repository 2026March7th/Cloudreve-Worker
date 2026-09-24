/**
 * 分域库自举：建表 + 把存量数据从主库搬过去。
 *
 * ## 触发时机
 *
 *   1. 冷启动自举（index.ts bootstrap，在 provision/ensureSettings 之后）；
 *   2. 定时任务兜底（cron 每小时跑一次，幂等靠 KV 标记）——自举时域库
 *      恰好不可用的话，一小时后会自动补上。
 *
 * ## 语义
 *
 *   - `DATABASE_URL_2`（日志域）：建 `audit_logs`，搬主库存量行，之后
 *     新写入经 AuditRepo 直打域库；
 *   - `DATABASE_URL_3`（元数据域）：建 `metadata`（含唯一索引），搬存量；
 *   - **没配对应环境变量 → 该域整体跳过**，一行都不会往主库之外的库写；
 *   - 主库上对应表的 schema 永远保留（迁移只搬数据不删表）：域库故障时
 *     resolveDomainHandle 会回退主库（空表 = 功能降级但站点存活）。
 *
 * ## 幂等与并发
 *
 *   - DDL 全部 IF NOT EXISTS，天然幂等；
 *   - 数据搬迁用 KV 标记（`shard:migrated:<domain>`）只做一次；
 *   - 两个 isolate 并发迁移的竞态：metadata 有唯一索引（file_id,name），
 *     用 ON CONFLICT DO NOTHING 吞掉重复；audit_logs 无唯一键，并发窗口
 *     内可能出少量重复行（管理端日志展示层面的瑕疵，无害），KV 最终一致
 *     后窗口关闭。搬迁期间请求被自举闸门串行化，正常部署不会并发。
 */
import type { Env } from '../env';
import { kvFor } from '../lib/kvRouter';
import { auditDomainUrl, metadataDomainUrl, sqlForUrl } from './index';
import type { Sql } from './index';

// DDL 逐条执行（Neon HTTP 单请求不保证多语句，provision 的教训）
const AUDIT_DDL = [
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id         BIGSERIAL   PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id    INTEGER,
    type       INTEGER     NOT NULL,
    meta       JSONB       NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS audit_logs_created_at ON audit_logs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_type ON audit_logs (type)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_user_id ON audit_logs (user_id)`,
];

const METADATA_DDL = [
  `CREATE TABLE IF NOT EXISTS metadata (
    id         SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    name       TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    file_id    INTEGER NOT NULL,
    is_public  BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS metadata_file_id_name ON metadata (file_id, name)`,
];

const BATCH = 500;

async function ensureDomainDdl(env: Env, domain: 'audit' | 'metadata', url: string): Promise<void> {
  const flag = `shard:ddl:${domain}`;
  const kv = kvFor(env, 'flag');
  if (await kv.get(flag)) return;
  const sql = sqlForUrl(url);
  for (const stmt of domain === 'audit' ? AUDIT_DDL : METADATA_DDL) {
    await sql(stmt);
  }
  await kv.put(flag, '1');
}

/** 把主库一张表的全量行搬到域库，搬完删主库侧。返回是否执行了搬迁。 */
async function migrateTable(
  primary: Sql,
  domain: Sql,
  table: 'audit_logs' | 'metadata',
  insertRows: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  for (let round = 0; round < 1000; round++) {
    const rows =
      table === 'audit_logs'
        ? ((await primary`SELECT id, created_at, user_id, type, meta FROM audit_logs ORDER BY id LIMIT ${BATCH}`) as Record<string, unknown>[])
        : ((await primary`SELECT id, created_at, updated_at, deleted_at, name, value, file_id, is_public FROM metadata ORDER BY id LIMIT ${BATCH}`) as Record<string, unknown>[]);
    if (rows.length === 0) break;

    await insertRows(rows);
    const maxId = Math.max(...rows.map((r) => Number(r.id)));
    if (table === 'audit_logs') {
      await primary`DELETE FROM audit_logs WHERE id <= ${maxId}`;
    } else {
      await primary`DELETE FROM metadata WHERE id <= ${maxId}`;
    }
    if (rows.length < BATCH) break;
  }

  // 序列对齐：显式带 id 插入后，把域库序列拨到最大 id 之后
  if (table === 'audit_logs') {
    await domain`SELECT setval(pg_get_serial_sequence('audit_logs','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM audit_logs), 1))`;
  } else {
    await domain`SELECT setval(pg_get_serial_sequence('metadata','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM metadata), 1))`;
  }
}

/** 单域自举：DDL + 数据搬迁（KV 标记幂等）。 */
async function ensureDomain(
  env: Env,
  domain: 'audit' | 'metadata',
  url: string,
): Promise<void> {
  const kv = kvFor(env, 'flag');
  const migratedFlag = `shard:migrated:${domain}`;
  if (await kv.get(migratedFlag)) return;

  await ensureDomainDdl(env, domain, url);
  const domainSql = sqlForUrl(url);

  // 主库句柄：域迁移只读/删主库侧的这两张表
  const primary = sqlForUrl(primaryUrlOf(env));

  if (domain === 'audit') {
    await migrateTable(primary, domainSql, 'audit_logs', async (rows) => {
      for (const r of rows) {
        await domainSql`
          INSERT INTO audit_logs (id, created_at, user_id, type, meta)
          VALUES (${Number(r.id)}, ${r.created_at}, ${r.user_id}, ${Number(r.type)}, ${JSON.stringify(r.meta ?? {})}::jsonb)
          ON CONFLICT (id) DO NOTHING
        `;
      }
    });
  } else {
    await migrateTable(primary, domainSql, 'metadata', async (rows) => {
      for (const r of rows) {
        await domainSql`
          INSERT INTO metadata (id, created_at, updated_at, deleted_at, name, value, file_id, is_public)
          VALUES (${Number(r.id)}, ${r.created_at}, ${r.updated_at}, ${r.deleted_at}, ${r.name}, ${r.value},
                  ${Number(r.file_id)}, ${r.is_public === true})
          ON CONFLICT (file_id, name) DO NOTHING
        `;
      }
    });
  }

  await kv.put(migratedFlag, '1');
}

function primaryUrlOf(env: Env): string {
  const url = (env as unknown as Record<string, string | undefined>).DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is not configured');
  return url;
}

/**
 * 分域自举入口：有配置的域逐个建表 + 搬迁，失败只记日志（cron 会重试）。
 * 单库部署（没填 _2/_3）直接返回，零开销。
 */
export async function ensureDomainShards(env: Env): Promise<void> {
  const jobs: Array<[string, 'audit' | 'metadata', string]> = [];
  const auditUrl = auditDomainUrl(env);
  if (auditUrl) jobs.push(['audit', 'audit', auditUrl]);
  const metadataUrl = metadataDomainUrl(env);
  if (metadataUrl) jobs.push(['metadata', 'metadata', metadataUrl]);
  if (jobs.length === 0) return;

  for (const [name, domain, url] of jobs) {
    try {
      await ensureDomain(env, domain, url);
      console.log(`domain shard ready: ${name} (own database)`);
    } catch (e) {
      // 失败不阻断：cron 每小时重试；期间该域的查询仍打域库，若域库本身
      // 不可用会由 resolveDomainHandle 的降级窗口回退主库。
      console.error(`domain shard bootstrap failed for ${name}:`, e instanceof Error ? e.message : String(e));
    }
  }
}
