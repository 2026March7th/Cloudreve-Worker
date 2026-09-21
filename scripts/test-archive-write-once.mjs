/**
 * 归档表「只增不改」验证（真机，需要本地 PostgreSQL）。
 *
 * ## 为什么必须真机验证
 *
 * 「归档不可修改」这个承诺的力量全在**数据库层**（0010_archive.sql 上的
 * BEFORE UPDATE / DELETE 触发器）。如果只在应用层挡，那么任何一处直接
 * 写 SQL 的代码都能绕过它 —— 那种「不可修改」是假的。
 *
 * 所以这里绕过应用层，**直接用 SQL 尝试 UPDATE / DELETE**，确认数据库
 * 真的拒绝。这一条只能靠真机跑，mock 测不出来。
 *
 * 用法：node scripts/test-archive-write-once.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PSQL = process.env.PG_BIN
  ? path.join(process.env.PG_BIN, 'psql.exe')
  : 'F:/Users/.pgsql/pg/pgsql/bin/psql.exe';
const CONN = ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '--no-psqlrc'];
const TEST_DB = 'cre_archive_test';

const MIGRATIONS = [
  '0001_init.sql', '0002_admin_content.sql', '0003_dav_passkey.sql',
  '0004_node_settings.sql', '0005_payment.sql', '0006_audit_log.sql',
  '0007_paid_share.sql', '0008_oidc.sql', '0009_group_storage_policies.sql',
  '0010_archive.sql',
];

/** 跑一条 SQL；返回 {ok, out, err}。用于「这条语句应当失败」的断言。 */
function trySql(db, sql) {
  try {
    const out = execFileSync(PSQL, [...CONN, '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, out, err: '' };
  } catch (e) {
    return { ok: false, out: '', err: String(e.stderr ?? e.message) };
  }
}

function psql(db, sql) {
  const r = trySql(db, sql);
  if (!r.ok) throw new Error(r.err);
  return r.out;
}

console.log('── 归档表：只增不改 ──');

try {
  psql('postgres', `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  psql('postgres', `CREATE DATABASE ${TEST_DB}`);
  for (const f of MIGRATIONS) {
    execFileSync(
      PSQL,
      [...CONN, '-q', '-v', 'ON_ERROR_STOP=1', '-d', TEST_DB, '-f', path.join(ROOT, 'migrations', f)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
  console.log('  ✓ 迁移应用完成（含 0010_archive.sql）');

  // 插入一条归档
  const id = '11111111-1111-1111-1111-111111111111';
  psql(
    TEST_DB,
    `INSERT INTO archive_entries (entry_id, kind, object_id, at, value, actor, note, source)
     VALUES ('${id}', 'settings', 'global', now(), '{"siteName":"old"}'::jsonb, '1', 'test', 1)`,
  );
  assert.equal(psql(TEST_DB, `SELECT count(*) FROM archive_entries`), '1');
  console.log('  ✓ 可以插入归档');

  // ① UPDATE 必须被拒绝（触发器）
  const upd = trySql(TEST_DB, `UPDATE archive_entries SET value = '{"hacked":true}'::jsonb WHERE entry_id = '${id}'`);
  assert.equal(upd.ok, false, 'UPDATE 必须被数据库拒绝');
  assert.match(upd.err, /append-only/i, `拒绝原因应提到 append-only，实际：${upd.err}`);
  console.log('  ✓ UPDATE 被数据库拒绝（触发器：append-only）');

  // ② DELETE 必须被拒绝
  const del = trySql(TEST_DB, `DELETE FROM archive_entries WHERE entry_id = '${id}'`);
  assert.equal(del.ok, false, 'DELETE 必须被数据库拒绝');
  assert.match(del.err, /append-only/i);
  console.log('  ✓ DELETE 被数据库拒绝（触发器：append-only）');

  // ③ 值确实没被改掉
  assert.equal(
    psql(TEST_DB, `SELECT value->>'siteName' FROM archive_entries WHERE entry_id = '${id}'`),
    'old',
    '被拒绝的 UPDATE 不应留下任何痕迹',
  );
  console.log('  ✓ 拒绝后原值完好（siteName 仍是 old）');

  // ④ 主键冲突：同一 entry_id 重复插入不覆盖
  const dup = trySql(
    TEST_DB,
    `INSERT INTO archive_entries (entry_id, kind, object_id, at, value)
     VALUES ('${id}', 'settings', 'global', now(), '{"siteName":"evil"}'::jsonb)`,
  );
  assert.equal(dup.ok, false, '重复 entry_id 应因主键冲突失败');
  console.log('  ✓ 重复 entry_id 被主键拦截（不会覆盖已有归档）');

  // ⑤ (kind, object_id, at) 唯一：同一时刻同一对象只能一条
  const at = psql(TEST_DB, `SELECT at FROM archive_entries WHERE entry_id = '${id}'`);
  const dup2 = trySql(
    TEST_DB,
    `INSERT INTO archive_entries (entry_id, kind, object_id, at, value)
     VALUES ('22222222-2222-2222-2222-222222222222', 'settings', 'global', '${at}', '{"siteName":"evil"}'::jsonb)`,
  );
  assert.equal(dup2.ok, false, '同一 (kind, object_id, at) 应被唯一约束拦截');
  console.log('  ✓ 同一对象的同一时刻重复归档被唯一约束拦截');

  // ⑥ 不同时刻可以追加（历史要能累积）
  psql(
    TEST_DB,
    `INSERT INTO archive_entries (entry_id, kind, object_id, at, value)
     VALUES ('33333333-3333-3333-3333-333333333333', 'settings', 'global', now() + interval '1 second', '{"siteName":"newer"}'::jsonb)`,
  );
  assert.equal(psql(TEST_DB, `SELECT count(*) FROM archive_entries`), '2');
  console.log('  ✓ 不同时刻可以继续追加（历史正常累积）');

  // ⑦ 按时间倒序能拿到最新一条
  assert.equal(
    psql(TEST_DB, `SELECT value->>'siteName' FROM archive_entries ORDER BY at DESC LIMIT 1`),
    'newer',
  );
  console.log('  ✓ 按 at 倒序取到最新归档');

  console.log('  ✓ 全部通过');
} finally {
  try {
    psql('postgres', `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  } catch {
    /* 清理失败不影响结论 */
  }
}
