/**
 * COPY 全量同步的真机验证（连本机 PostgreSQL，不是 mock）。
 *
 * 为什么必须真机跑：`COPY ... TO STDOUT / FROM STDIN` 的行为是**服务端 +
 * 协议层**决定的，靠读文档推断会漏掉关键细节。这个脚本已经被一次真实
 * 事故验证过价值 —— 最初实现里假设 COPY TO 会输出表头行（像 CSV 那样），
 * 于是 `lines.slice(1)` 把**每张表的第一行数据静默丢掉**。只有真机跑
 * 才能发现：`COPY TO STDOUT` 根本不发列名，列名走协议层的 RowDescription。
 *
 * 本脚本通过一个**忠实复刻 replicate.ts 的 syncTable 流程**的驱动函数，
 * 走完整的「读列 → TRUNCATE → 分批 COPY TO → COPY FROM」路径，然后逐列
 * 对拍两库内容。
 *
 * 前置：本机 PostgreSQL 已在 127.0.0.1:5432 运行。库不存在时先跑
 * `npm run test:copy:setup` 建库灌数据；本脚本自己会 TRUNCATE 目标表，
 * 因此可以独立重复执行。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PG = process.env.PG_BIN
  ? path.join(process.env.PG_BIN, 'psql.exe')
  : 'F:/Users/.pgsql/pg/pgsql/bin/psql.exe';
const HOST = ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '--no-psqlrc'];

/** 跑一条查询，返回纯文本（剥掉 Windows CRLF）。 */
function psql(db, sql) {
  return execFileSync(PG, [...HOST, '-d', db, '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  })
    .replace(/\r/g, '')
    .trim();
}

const tmp = mkdtempSync(path.join(tmpdir(), 'copyreal-'));

/** 用 psql 的 \copy 把一段 COPY 文本喂给目标表（等价于协议层 COPY FROM STDIN）。 */
function copyFrom(db, table, cols, text) {
  const dataFile = path.join(tmp, `d${Date.now()}${Math.random()}.txt`);
  const scriptFile = path.join(tmp, `s${Date.now()}${Math.random()}.sql`);
  writeFileSync(dataFile, text.endsWith('\n') ? text : text + '\n');
  writeFileSync(
    scriptFile,
    `\\copy ${table} (${cols.map((c) => '"' + c + '"').join(', ')}) FROM '${dataFile.replace(/\\/g, '/')}' WITH (FORMAT text)\n`,
  );
  return execFileSync(PG, [...HOST, '-d', db, '-f', scriptFile], { encoding: 'utf8' });
}

/** 走 COPY TO STDOUT 拿文本（不用 -t，纯数据流）。 */
function copyTo(db, table, cols, offset, limit) {
  return execFileSync(
    PG,
    [...HOST, '-d', db, '-t', '-A', '-c',
     `COPY (SELECT ${cols.map((c) => '"' + c + '"').join(', ')} FROM ${table} ORDER BY 1 OFFSET ${offset} LIMIT ${limit}) TO STDOUT WITH (FORMAT text)`],
    { encoding: 'utf8' },
  ).replace(/\r\n/g, '\n');
}

/**
 * 复刻 replicate.ts 的 syncTable 流程。
 *
 * 与生产代码的唯一区别是「怎么连库」（这里是 psql 子进程，生产是 Neon
 * HTTP 驱动）。算法本身——读列、TRUNCATE、分批、**不 slice(1)**——必须
 * 逐行一致，否则这个测试就失去意义。
 */
const CHUNK_ROWS = 500;
function syncTable(fromDb, toDb, table) {
  const cols = psql(
    fromDb,
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position`,
  ).split('\n').filter(Boolean);
  if (!cols.length) return { table, rows: 0, skipped: '无列' };

  const colList = cols.map((c) => '"' + c + '"').join(', ');
  psql(toDb, `TRUNCATE TABLE ${table}`);

  let offset = 0;
  let total = 0;
  for (;;) {
    const text = copyTo(fromDb, table, cols, offset, CHUNK_ROWS);
    // 这一行是本次修复的核心：COPY TO STDOUT 不含表头，不能 slice(1)。
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (!lines.length) break;
    copyFrom(toDb, table, cols, lines.join('\n'));
    total += lines.length;
    if (lines.length < CHUNK_ROWS) break;
    offset += CHUNK_ROWS;
  }
  return { table, rows: total };
}

console.log('── COPY 真机往返（PostgreSQL 16.9）──');

// 1. 列定义
const cols = psql(
  'sync_src',
  "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='t' ORDER BY ordinal_position",
).split('\n');
assert.equal(cols.length, 10, '应有 10 列');
console.log('  ✓ 列定义读取：' + cols.join(', '));

// 2. 确认 COPY TO 不含表头（这是整条链路的基石假设，必须显式断言）
const raw = copyTo('sync_src', 't', cols, 0, 500);
const rawLines = raw.split('\n').filter((l) => l.length > 0);
assert.equal(
  rawLines.length,
  7,
  `COPY TO STDOUT 应输出恰好 7 行（无表头），实际 ${rawLines.length}`,
);
assert.ok(
  !rawLines[0].includes('id'),
  '首行不该是列名行，实际：' + JSON.stringify(rawLines[0]),
);
assert.ok(rawLines[0].startsWith('1\t'), '首行应是 id=1 的数据行，实际：' + JSON.stringify(rawLines[0]));
console.log('  ✓ COPY TO STDOUT 无表头（7 行数据，首行 id=1）');

// 3. 走完整同步流程
//
// 前置：把目标表清空。**不要**改成断言 `before === '0'` —— 那是把「测试上
// 一次跑过」当成前置条件，第二次单独重跑必然失败（fixture 有状态，而测试
// 却假设了干净状态）。自己清自己，才能单独重复执行。
psql('sync_dst', 'TRUNCATE TABLE t');
const before = psql('sync_dst', 'SELECT count(*) FROM t');
assert.equal(before, '0', '目标清空失败，实际 ' + before);
const r = syncTable('sync_src', 'sync_dst', 't');
assert.equal(r.rows, 7, `syncTable 应搬 7 行，实际 ${r.rows}`);
assert.equal(psql('sync_dst', 'SELECT count(*) FROM t'), '7', '导入后应为 7 行');
console.log(`  ✓ 完整同步：${r.rows} 行（首行未丢失）`);

// 4. 全表内容哈希必须一致
const hashOf = (db) => psql(db, `SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM t`);
const h1 = hashOf('sync_src');
const h2 = hashOf('sync_dst');
assert.equal(h2, h1, `内容不一致：src=${h1} dst=${h2}`);
console.log(`  ✓ 内容逐字节一致（md5 ${h1.slice(0, 16)}…）`);

// 5. 逐字段核对最容易出错的值
const same = (sql, label) => {
  const a = psql('sync_src', sql);
  const b = psql('sync_dst', sql);
  assert.equal(b, a, `${label} 不一致：src=${JSON.stringify(a)} dst=${JSON.stringify(b)}`);
};
same('SELECT txt FROM t WHERE id=1', 'id=1 首行');           // 恰好是曾被丢掉的那行
same('SELECT txt FROM t WHERE id=2', '制表符');
same('SELECT txt FROM t WHERE id=3', '换行符');
same('SELECT txt FROM t WHERE id=4', '反斜杠');
same('SELECT txt FROM t WHERE id=7', '\\N 字面量');
same('SELECT encode(b,\'hex\') FROM t WHERE id=1', 'bytea#1');
same('SELECT length(b) FROM t WHERE id=5', '空 bytea');
console.log('  ✓ 首行 / 制表符 / 换行 / 反斜杠 / \\N 字面量 / bytea 全部一致');

// 6. NULL 与空串不能混淆
for (const [pred, label] of [
  ['nullable IS NULL', 'NULL'],
  ["nullable = ''", '空串'],
  ['num IS NULL', 'num NULL'],
  ['b IS NULL', 'bytea NULL'],
  ['j IS NULL', 'jsonb NULL'],
  ['ts IS NULL', 'timestamp NULL'],
  ['arr IS NULL', '数组 NULL'],
]) {
  same(`SELECT count(*) FROM t WHERE ${pred}`, label + ' 计数');
}
const nNull = psql('sync_dst', 'SELECT count(*) FROM t WHERE nullable IS NULL');
const nEmpty = psql('sync_dst', "SELECT count(*) FROM t WHERE nullable = ''");
assert.ok(Number(nNull) >= 1 && Number(nEmpty) >= 1, '两个计数都该 ≥1');
console.log(`  ✓ NULL / 空串未被混淆（NULL ${nNull} 个，空串 ${nEmpty} 个）`);

// 7. jsonb / 时间 / 数组 全量哈希
for (const [expr, label] of [
  ['j::text', 'jsonb'],
  ['ts::text', 'timestamp'],
  ['tstz::text', 'timestamptz'],
  ['arr::text', '数组'],
  ['bl::text', '布尔'],
  ['num::text', 'bigint'],
]) {
  same(`SELECT md5(string_agg(${expr}, ',' ORDER BY id)) FROM t`, label);
}
console.log('  ✓ jsonb / timestamp / timestamptz / 数组 / 布尔 / bigint 全量一致');

// 8. 中文与特殊字符
same("SELECT txt FROM t WHERE id=5", '中文/emoji 行');
same("SELECT nullable FROM t WHERE id=5", '中文字段值');
console.log('  ✓ 中文与 UTF-8 内容一致');

// 9. 分批路径：用 CHUNK_ROWS=2 强制多批，确认批间不丢行不重复
{
  psql('sync_dst', 'TRUNCATE TABLE t');
  const small = 2;
  let offset = 0;
  let total = 0;
  const colList = cols.map((c) => '"' + c + '"').join(', ');
  for (;;) {
    const text = copyTo('sync_src', 't', cols, offset, small);
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (!lines.length) break;
    copyFrom('sync_dst', 't', cols, lines.join('\n'));
    total += lines.length;
    if (lines.length < small) break;
    offset += small;
  }
  assert.equal(total, 7, `分批搬运应得 7 行，实际 ${total}`);
  assert.equal(hashOf('sync_dst'), h1, '分批搬运后内容不一致');
  console.log(`  ✓ 分批路径（每批 ${small} 行，共 4 批）：7 行无重复无遗漏`);
}

console.log('\n✅ COPY 真机往返全部通过（7 行 × 10 列：NULL/空串/bytea/jsonb/数组/时间/中文/制表符/换行/反斜杠）');
