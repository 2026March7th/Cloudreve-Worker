/**
 * 数据库自动开通：建表 + 播种系统数据。
 *
 * 目标是**部署后零命令** —— 用户在手机上点完「Deploy to Cloudflare」按钮、
 * 打开站点就能用，不经过任何本机步骤。原来的 `npm run db:migrate` /
 * `npm run db:seed` 只剩开发用途。
 *
 * 机制：
 *   - migrations/*.sql 通过 wrangler 的 Text 规则打进包里，作为唯一事实来源；
 *   - 语句全部幂等（CREATE TABLE IF NOT EXISTS / DROP ... IF EXISTS），
 *     冷启动并发时最多互相报「already exists」，逐条容错忽略；
 *   - 用 KV 标记（键含最后一个迁移的文件名）避免每次冷启动都重放全部 DDL。
 *
 * 播种内容与 scripts/seed.mjs 一致：三个系统用户组（id 1/2/3）、默认 R2
 * 存储策略、默认组绑定策略。**管理员账号不在这里建**（密码无从得知）：
 * 第一个注册的用户自动进管理员组，见 services/user.ts 的 register()。
 */
import m0001 from '../../migrations/0001_init.sql';
import m0002 from '../../migrations/0002_admin_content.sql';
import m0003 from '../../migrations/0003_dav_passkey.sql';
import m0004 from '../../migrations/0004_node_settings.sql';
import { getSql, withRetry } from './index';
import type { Env } from '../env';

const MIGRATIONS: ReadonlyArray<readonly [name: string, sqlText: string]> = [
  ['0001_init.sql', m0001],
  ['0002_admin_content.sql', m0002],
  ['0003_dav_passkey.sql', m0003],
  ['0004_node_settings.sql', m0004],
];

/** KV 标记：值是最后一个已应用的迁移文件名，文件名不变就跳过。 */
const MARKER_KEY = 'provision:schema';

/** 模块级缓存：每个 isolate 只跑一次完整检查（一次 KV get）。 */
let ran = false;

/** 去掉注释后按分号切分。与 scripts/migrate.mjs 的 splitStatements 同源。 */
function splitStatements(sqlText: string): string[] {
  const noBlock = sqlText.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  return noLine
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 并发冷启动时两条相同 DDL 相撞是正常现象，不算失败。 */
function isBenignError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists|duplicate/i.test(msg);
}

/**
 * 应用全部迁移（幂等）。
 *
 * **每个文件用一次 `sql.transaction()` 整体提交** —— 关键约束：Workers 免费版
 * 单请求只有 50 个 subrequest，而逐条执行 0001 就要 52 个请求，必然爆掉；
 * Neon 免费版还会对突发请求直接回 429。合并后 4 个文件只有 4 个请求。
 * 事务里语句按序执行，失败整体回滚 —— 全部语句幂等，并发冷启动时第二遍重放
 * 即可收敛。
 */
async function applyMigrations(env: Env): Promise<void> {
  const sql = getSql(env);
  const done = await env.KV.get(MARKER_KEY);
  const last = MIGRATIONS[MIGRATIONS.length - 1]![0];
  if (done === last) return;

  for (const [name, sqlText] of MIGRATIONS) {
    const queries = splitStatements(sqlText).map((statement) => sql(statement));
    try {
      await withRetry(() => sql.transaction(queries));
    } catch (err) {
      if (!isBenignError(err)) {
        throw new Error(`migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // 不设 TTL：做过的 schema 就算做过了
  await env.KV.put(MARKER_KEY, last);
}

/**
 * 播种系统数据。字段值逐条对齐 scripts/seed.mjs，而 seed.mjs 对齐的是
 * 上游 `application/migrator` 的 migrateAdminGroup / migrateUserGroup /
 * migrateAnonymousGroup。全部 ON CONFLICT DO NOTHING，重复执行无害。
 */
async function seedSystemData(env: Env): Promise<void> {
  const sql = getSql(env);

  // 权限位号来自 inventory/types/types.go 的 GroupPermission（LSB-first）
  const PERM = {
    IsAdmin: 0,
    IsAnonymous: 1,
    Share: 2,
    WebDAV: 3,
    ArchiveDownload: 4,
    ArchiveTask: 5,
    WebDAVProxy: 6,
    ShareDownload: 7,
    RemoteDownload: 9,
    RedirectedSource: 11,
    AdvanceDelete: 12,
    IgnoreFileOwnership: 16,
    UniqueRedirectDirectLink: 17,
  } as const;

  const GB = 1 << 30;
  const TB = 1 << 40;

  const groups = [
    {
      id: 1,
      name: 'Admin',
      maxStorage: 1 * TB,
      permissions: [
        PERM.IsAdmin,
        PERM.Share,
        PERM.WebDAV,
        PERM.WebDAVProxy,
        PERM.ArchiveDownload,
        PERM.ArchiveTask,
        PERM.ShareDownload,
        PERM.RemoteDownload,
        PERM.RedirectedSource,
        PERM.AdvanceDelete,
        PERM.IgnoreFileOwnership,
      ],
      settings: {
        source_batch: 1000,
        aria2_batch: 50,
        max_walked_files: 100000,
        trash_retention: 7 * 24 * 3600,
        redirected_source: true,
      },
    },
    {
      id: 2,
      name: 'User',
      maxStorage: 1 * GB,
      permissions: [PERM.Share, PERM.ShareDownload, PERM.RedirectedSource],
      settings: {
        source_batch: 10,
        aria2_batch: 1,
        max_walked_files: 100000,
        trash_retention: 7 * 24 * 3600,
        redirected_source: true,
      },
    },
    {
      id: 3,
      name: 'Anonymous',
      maxStorage: null,
      permissions: [PERM.IsAnonymous, PERM.ShareDownload],
      settings: {
        max_walked_files: 100000,
        redirected_source: true,
      },
    },
  ];

  // 三个系统组 + 序列校正合并成一个事务（= 1 个 HTTP 请求）
  await withRetry(() =>
    sql.transaction([
      ...groups.map((group) => {
        const maxBit = group.permissions.length ? Math.max(...group.permissions) : -1;
        const bytes = new Uint8Array(Math.max(1, (maxBit >> 3) + 1));
        for (const bit of group.permissions) {
          bytes[bit >> 3] |= 1 << (bit & 7);
        }
        let hex = '';
        for (const b of bytes) hex += b.toString(16).padStart(2, '0');

        return sql`
          INSERT INTO groups (id, name, max_storage, speed_limit, permissions, settings, storage_policy_id)
          VALUES (${group.id}, ${group.name}, ${group.maxStorage}, NULL, ${`\\x${hex}`}::bytea,
                  ${JSON.stringify(group.settings)}::jsonb, NULL)
          ON CONFLICT (id) DO NOTHING
        `;
      }),
      // 让自增序列跟在手工指定的 id 之后，避免后续插入主键冲突
      sql`SELECT setval(pg_get_serial_sequence('groups', 'id'), (SELECT MAX(id) FROM groups))`,
    ]),
  );

  // 默认 R2 存储策略 + 默认组绑定（对齐 seed.mjs）
  const policyRows = (await sql`SELECT id FROM storage_policies WHERE deleted_at IS NULL ORDER BY id LIMIT 1`) as Array<{
    id: number | string;
  }>;
  if (!policyRows[0]) {
    const inserted = (await sql`
      INSERT INTO storage_policies
        (name, type, server, bucket_name, is_private, max_size,
         dir_name_rule, file_name_rule, settings)
      VALUES
        ('R2 Default', 'r2', '', '', true, 0,
         'uploads/{uid}/{path}', '{uid}_{randomkey8}_{originname}', '{}'::jsonb)
      RETURNING id
    `) as Array<{ id: number | string }>;
    const policyId = Number(inserted[0]!.id);
    await sql`UPDATE groups SET storage_policy_id = ${policyId} WHERE id = 2 AND storage_policy_id IS NULL`;
  }
}

/** 冷启动入口：建表 + 播种。可安全重复调用（幂等 + KV 标记短路）。 */
export async function provision(env: Env): Promise<void> {
  if (ran) return;
  ran = true;
  try {
    await applyMigrations(env);
    await seedSystemData(env);
  } catch (err) {
    // 失败要复位模块缓存，让下一个请求重试（KV 标记只在成功后写入）
    ran = false;
    throw err;
  }
}
