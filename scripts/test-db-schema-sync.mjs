/**
 * `db-sync.mjs` 的 `ensureSchema` 核心逻辑验证（真机，本地 PostgreSQL）。
 *
 * ## 为什么要有这个测试
 *
 * 用户报「我绑了 5 个 Neon，实际只用了 1 个」。根因之一：备库是**新开的
 * 空库**，而同步脚本原来遇到「备库缺表」只打印操作指引就跳过了 ——
 * 结果是同步没做、构建照样成功、备库永远是空的，用户完全看不出来。
 *
 * 现在脚本会自动把 migrations/*.sql 应用过去。这里在真机上验证这套
 * 「读 .sql → 拆分 → 应用 → 校验 22 张表 → 可重复执行」的逻辑成立。
 *
 * 用 psql 子进程执行（而不是 Neon HTTP 驱动）：驱动的 endpoint 固定推导为
 * `https://api.<host>/sql`，连不了本机 Postgres；而这里要验的是 **SQL 文本
 * 与拆分逻辑**，与用哪个客户端无关。
 *
 * 用法：node scripts/test-db-schema-sync.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PSQL = process.env.PG_BIN
  ? path.join(process.env.PG_BIN, 'psql.exe')
  : 'F:/Users/.pgsql/pg/pgsql/bin/psql.exe';
// 与 test-copy-roundtrip.mjs 同一套连接参数：必须显式 -U postgres，
// 否则 psql 会用当前系统用户名（本机是 Administrator）→ role 不存在。
const CONN = ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '--no-psqlrc'];

/** 与 db-sync.mjs 顶部的 MIGRATION_FILES 保持一致。 */
const MIGRATION_FILES = [
  '0001_init.sql', '0002_admin_content.sql', '0003_dav_passkey.sql',
  '0004_node_settings.sql', '0005_payment.sql', '0006_audit_log.sql',
  '0007_paid_share.sql', '0008_oidc.sql', '0009_group_storage_policies.sql',
  '0010_archive.sql',
];

/** db-sync.mjs 的 SYNC_TABLES —— 全量同步要覆盖的表。 */
const SYNC_TABLES = [
  'settings', 'storage_policies', 'groups', 'group_storage_policies', 'nodes',
  'users', 'files', 'entities', 'file_entities', 'metadata', 'shares',
  'share_purchases', 'direct_links', 'tasks', 'dav_accounts', 'passkeys',
  'oauth_clients', 'oauth_grants', 'user_oidc_bindings', 'orders',
  'gift_codes', 'audit_logs', 'archive_entries',
];

const TEST_DB = 'cre_schema_sync_test';

function psql(db, sql) {
  return execFileSync(PSQL, [...CONN, '-t', '-A', '-q', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();
}

/** 复刻 db-sync.mjs 的 splitSqlStatements，用于确认拆分结果非空且合理。 */
function splitStatements(sqlText) {
  const noBlock = sqlText.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  return noLine.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

function applyMigrations(db) {
  for (const f of MIGRATION_FILES) {
    execFileSync(
      PSQL,
      [...CONN, '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', path.join(ROOT, 'migrations', f)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
}

function countTables(db) {
  return Number(
    psql(db, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`),
  );
}

console.log('── 备库 schema 自动建表 ──');

try {
  psql('postgres', `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  psql('postgres', `CREATE DATABASE ${TEST_DB}`);

  assert.equal(countTables(TEST_DB), 0, '测试库应当是空的');
  console.log('  ✓ 起始状态：空库（0 张表）—— 模拟新开的 Neon 备库');

  // 迁移文本能正确拆分成语句（拆错会漏建表）。
  for (const f of MIGRATION_FILES) {
    const text = readFileSync(path.join(ROOT, 'migrations', f), 'utf8');
    const stmts = splitStatements(text);
    assert.ok(stmts.length > 0, `${f} 拆分后不该为空`);
  }
  console.log('  ✓ 9 个迁移文件都能拆出可执行语句');

  applyMigrations(TEST_DB);
  const after = countTables(TEST_DB);
  assert.ok(after >= SYNC_TABLES.length, `建表后应至少 ${SYNC_TABLES.length} 张表，实际 ${after}`);
  console.log(`  ✓ 应用 migrations/*.sql 后建出 ${after} 张表`);

  const missing = SYNC_TABLES.filter(
    (t) => psql(TEST_DB, `SELECT to_regclass('public.${t}') IS NOT NULL`) !== 't',
  );
  assert.equal(missing.length, 0, `这些同步表没建出来：${missing.join(', ')}`);
  console.log(`  ✓ db-sync 要同步的 ${SYNC_TABLES.length} 张表全部存在`);
  console.log('    （含 group_storage_policies —— 它原先只在 provision.ts 里建，'
    + 'migrations 里没有，正是备库建表会漏掉的那张）');

  // 幂等：每次构建都会重跑，重复应用不能报错、不能改变结果。
  applyMigrations(TEST_DB);
  assert.equal(countTables(TEST_DB), after, '重复应用迁移不该改变表数量');
  console.log('  ✓ 迁移可重复执行（幂等）—— 每次构建重跑不会出错');

  console.log('  ✓ 全部通过');
} finally {
  try {
    psql('postgres', `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  } catch {
    /* 清理失败不影响结论 */
  }
}
