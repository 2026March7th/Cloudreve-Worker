/**
 * 迁移切分器 + 备库 schema 自动建表验证（真机，本地 PostgreSQL）。
 *
 * ## 这个测试为什么存在（两次事故的教训）
 *
 * 事故 1（d3a55ec 发现）：备库缺表时同步默默跳过，构建照常成功，
 *   用户「配了 5 个库实际只有 1 个」。
 * 事故 2（2026-09-21 生产 503）：0010_archive.sql 用 $$...$$ 包 PL/pgSQL
 *   函数体，函数体内的分号被旧朴素切分器拦腰截断，Worker 自举失败、
 *   全站 503。当时测试用 `psql -f` 应用迁移 —— **psql 自己会解析
 *   dollar-quote**，所以 SQL 文件本身是对的、运行时切分却是错的，
 *   测试完全测不出来。
 *
 * 现在的测法：切分器是全仓库唯一实现（src/lib/sql-split.mjs，运行时
 * 自举 / 备库建表 / 手动迁移共用），本测试**用这同一份切分器**把全部
 * 迁移逐条（psql -c，一条一个参数）灌进真实 PostgreSQL —— 运行时怎么
 * 切，这里就怎么执行。另外对触发器做行为级验证（UPDATE/DELETE 必须被
 * 拒绝），证明 dollar-quote 函数体不是「看起来对」而是「真的对」。
 *
 * 用 psql 子进程执行（而不是 Neon HTTP 驱动）：驱动的 endpoint 固定推导为
 * `https://api.<host>/sql`，连不了本机 Postgres；这里要验的是 SQL 文本
 * 与切分逻辑，与用哪个客户端无关。
 *
 * 用法：node scripts/test-db-schema-sync.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { splitStatements } from '../src/lib/sql-split.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PSQL = process.env.PG_BIN
  ? path.join(process.env.PG_BIN, 'psql.exe')
  : 'F:/Users/.pgsql/pg/pgsql/bin/psql.exe';
// 与 test-copy-roundtrip.mjs 同一套连接参数：必须显式 -U postgres，
// 否则 psql 会用当前系统用户名（本机是 Administrator）→ role 不存在。
const CONN = ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '--no-psqlrc'];

/** 与 db-sync.mjs / provision.ts 的迁移清单保持一致。 */
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

/**
 * 经运行时切分器逐条应用迁移（复刻 provision.ts / db-sync.mjs 的路径）。
 *
 * 关键设计：**每个片段独立一次 psql 调用、经 stdin（`-f -`）喂入**。
 *
 *   - 为什么不 join 回去再喂？psql 会自己重新分句，等于把切分结果
 *     原样拼回去 → 切错了也看不出来（事故 2 里 `psql -f` 掩盖 bug 的
 *     同一个机制）。逐片段喂，切错必然在 Postgres 报错。
 *   - 为什么走 stdin 不走 argv（`-c`）？Windows 上 psql.exe 的窄字符
 *     入口按 ANSI 代码页（本机 GBK）转码 argv，0010 HINT 里的中文会
 *     变成 `invalid byte sequence for encoding "UTF8": 0xb9`（实测）。
 *     stdin 是原始 UTF-8 字节流，与 `psql -f 文件` 同一通道，跨机器稳定。
 *   - `-1`（--single-transaction）+ ON_ERROR_STOP=1：片段出错立即失败。
 */
function applyMigrationsViaSplitter(db) {
  for (const f of MIGRATION_FILES) {
    const text = readFileSync(path.join(ROOT, 'migrations', f), 'utf8');
    const stmts = splitStatements(text);
    assert.ok(stmts.length > 0, `${f} 拆分后不该为空`);
    for (const s of stmts) {
      execFileSync(
        PSQL,
        [...CONN, '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-d', db, '-f', '-'],
        { input: s, encoding: 'utf8' },
      );
    }
  }
}

function countTables(db) {
  return Number(
    psql(db, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`),
  );
}

/** 期望被触发器/约束拒绝的语句：必须失败且错误信息匹配。 */
function assertRejected(db, sqlText, pattern) {
  try {
    psql(db, sqlText);
  } catch (e) {
    assert.match(String(e?.stderr ?? e), pattern);
    return;
  }
  assert.fail(`这条语句应当被拒绝却没有：${sqlText}`);
}

console.log('── 切分器单元断言（生产事故回归核心）──');

// 0010 必须恰好切成 8 条：表 + 2 索引 + 函数 + 2×(DROP+CREATE TRIGGER)。
// 旧朴素切分器会把函数体切成 3 段（在 $$ 内的分号处断开）。
const m0010 = readFileSync(path.join(ROOT, 'migrations', '0010_archive.sql'), 'utf8');
const s0010 = splitStatements(m0010);
assert.equal(s0010.length, 8, `0010 应切成 8 条语句，实际 ${s0010.length}：\n${s0010.join('\n---\n')}`);
const fnStmt = s0010.find((s) => s.includes('CREATE OR REPLACE FUNCTION') && s.includes('archive_entries_immutable'));
assert.ok(fnStmt, '函数语句应完整存在');
assert.ok(fnStmt.includes('LANGUAGE plpgsql'), '函数语句必须包含 LANGUAGE plpgsql（证明 $$ 函数体没被截断）');
assert.ok(!s0010.some((s) => s.startsWith('$$')), '不应出现以 $$ 开头的残片');
assert.ok(!s0010.some((s) => s === 'END'), '不应出现孤立的 END 残片');
console.log('  ✓ 0010_archive.sql 正确切出 8 条语句，$$ 函数体完整');

// 合成用例：引号/注释/dollar-quote 内的分号都不是边界。
assert.deepEqual(
  splitStatements("INSERT INTO t VALUES ('a;b'); -- note;c"),
  ["INSERT INTO t VALUES ('a;b')"],
  '单引号内的分号不是边界',
);
assert.deepEqual(
  splitStatements('SELECT $tag$ he;llo $tag$, $$x;y$$;'),
  ['SELECT $tag$ he;llo $tag$, $$x;y$$'],
  '$tag$ 与 $$ 内的分号不是边界',
);
assert.deepEqual(
  splitStatements('/* /* 注释;里的分号 */ */ SELECT 1;'),
  ['SELECT 1'],
  '嵌套块注释内的分号不是边界',
);
assert.deepEqual(
  splitStatements('SELECT $1 + $2;'),
  ['SELECT $1 + $2'],
  '$1 参数占位符不是 dollar-quote',
);
assert.deepEqual(splitStatements(';;  -- 纯注释\n/* x */ ;;'), [], '纯注释/纯分号不产出空语句');
console.log('  ✓ 合成用例全部通过（引号/注释/dollar-quote/参数占位符）');

// 每个迁移文件都能拆出非空语句（文件清单与运行时/同步脚本一致）。
for (const f of MIGRATION_FILES) {
  const stmts = splitStatements(readFileSync(path.join(ROOT, 'migrations', f), 'utf8'));
  assert.ok(stmts.length > 0, `${f} 拆分后不该为空`);
}
console.log(`  ✓ ${MIGRATION_FILES.length} 个迁移文件都能拆出可执行语句`);

console.log('── 备库 schema 自动建表（经运行时切分器）──');

try {
  psql('postgres', `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  psql('postgres', `CREATE DATABASE ${TEST_DB}`);

  assert.equal(countTables(TEST_DB), 0, '测试库应当是空的');
  console.log('  ✓ 起始状态：空库（0 张表）—— 模拟新开的 Neon 备库');

  // ★ 核心：用与 Worker 自举/备库建表完全相同的切分器逐条应用。
  // 任何片段切错，Postgres 立即报错（ON_ERROR_STOP=1）。
  applyMigrationsViaSplitter(TEST_DB);
  const after = countTables(TEST_DB);
  assert.ok(after >= SYNC_TABLES.length, `建表后应至少 ${SYNC_TABLES.length} 张表，实际 ${after}`);
  console.log(`  ✓ 经运行时切分器应用全部迁移，建出 ${after} 张表`);

  const missing = SYNC_TABLES.filter(
    (t) => psql(TEST_DB, `SELECT to_regclass('public.${t}') IS NOT NULL`) !== 't',
  );
  assert.equal(missing.length, 0, `这些同步表没建出来：${missing.join(', ')}`);
  console.log(`  ✓ db-sync 要同步的 ${SYNC_TABLES.length} 张表全部存在`);

  // dollar-quote 函数体必须以正确形态落库（不是被截断的残次品）。
  assert.equal(
    psql(TEST_DB, `SELECT count(*) FROM pg_proc WHERE proname = 'archive_entries_immutable'`),
    '1',
    'archive_entries_immutable() 函数应存在',
  );
  assert.equal(
    psql(TEST_DB, `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
                    WHERE tgrelid = 'archive_entries'::regclass AND NOT tgisinternal`),
    'archive_entries_no_delete,archive_entries_no_update',
    '两个只增不改触发器应存在',
  );
  console.log('  ✓ 归档函数 + 两个触发器存在（$$ 函数体正确落库）');

  // 行为级验证：触发器真的拦得住 UPDATE/DELETE。
  psql(TEST_DB, `INSERT INTO archive_entries (entry_id, kind, object_id, at, value)
                 VALUES ('t1', 'k', 'o', now(), '{}')`);
  assertRejected(
    TEST_DB,
    `UPDATE archive_entries SET note = 'x' WHERE entry_id = 't1'`,
    /append-only/,
  );
  assertRejected(
    TEST_DB,
    `DELETE FROM archive_entries WHERE entry_id = 't1'`,
    /append-only/,
  );
  console.log('  ✓ 行为验证：对归档表的 UPDATE / DELETE 都被数据库拒绝');

  // 幂等：每次构建都会重跑，重复应用不能报错、不能改变结果。
  applyMigrationsViaSplitter(TEST_DB);
  assert.equal(countTables(TEST_DB), after, '重复应用迁移不该改变表数量');
  assert.equal(
    psql(TEST_DB, `SELECT count(*) FROM pg_trigger
                    WHERE tgrelid = 'archive_entries'::regclass AND NOT tgisinternal`),
    '2',
    '重复应用不该产生重复触发器',
  );
  console.log('  ✓ 迁移可重复执行（幂等）—— 每次构建重跑不会出错');

  console.log('  ✓ 全部通过');
} finally {
  try {
    psql('postgres', `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  } catch {
    /* 清理失败不影响结论 */
  }
}
