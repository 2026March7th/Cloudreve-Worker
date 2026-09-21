#!/usr/bin/env node
/**
 * 建起 COPY 往返测试用的两个本机数据库（sync_src / sync_dst）。
 *
 * 数据是刻意挑的「最容易在 COPY 文本格式上翻车」的样本：
 *   - NULL vs 空串（文本格式里是 `\N` vs 空）
 *   - 制表符 / 换行 / 回车 / 反斜杠（都要转义成两字符形式）
 *   - 字面量 `\N`（不是 NULL，别被解码器误判）
 *   - bytea 双重转义 / 空 bytea
 *   - jsonb 含反斜杠与中文字段名
 *   - 数组含 NULL 元素
 *   - timestamp 与带时区的 timestamptz
 *   - 中文与 emoji
 *
 * 需要本机 PostgreSQL 在 127.0.0.1:5432，用户 postgres。
 * 用法：npm run test:copy:setup （PG_BIN 可覆盖二进制目录）
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = process.env.PG_BIN || 'F:/Users/.pgsql/pg/pgsql/bin';
const PSQL = path.join(PG_BIN, 'psql.exe');
const HOST = ['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '--no-psqlrc'];

const SCHEMA = `CREATE TABLE t (
  id INTEGER PRIMARY KEY,
  txt TEXT,
  nullable TEXT,
  num BIGINT,
  b BYTEA,
  j JSONB,
  ts TIMESTAMP,
  tstz TIMESTAMPTZ,
  bl BOOLEAN,
  arr INTEGER[]
);`;

const DATA = `INSERT INTO t VALUES
 (1, 'plain', NULL, 123456789012345, '\\x0102ff'::bytea, '{"a":1}'::jsonb, '2026-09-21 10:30:00'::timestamp, '2026-09-21 10:30:00+08'::timestamptz, true, '{1,2,3}'),
 (2, E'has\\ttab', 'x', -5, '\\x00'::bytea, '{"nested":{"k":"v"}}'::jsonb, '2026-01-01 00:00:00'::timestamp, '2026-01-01 00:00:00Z'::timestamptz, false, '{}'),
 (3, E'has\\nnewline', '', 0, '\\xdeadbeef'::bytea, '[]'::jsonb, NULL, NULL, NULL, NULL),
 (4, E'back\\\\slash', 'N', 999, NULL, NULL, '1999-12-31 23:59:59.999'::timestamp, '1999-12-31 23:59:59.999+00'::timestamptz, true, '{9,NULL,7}'),
 (5, '\\u4E2D\\u6587emoji', '\\u4E2D\\u6587\\u503C', 42, '\\x'::bytea, '{"a":"b"}'::jsonb, '2026-09-21 21:00:00'::timestamp, '2026-09-21 21:00:00+00'::timestamptz, false, '{1}'),
 (6, E'\\r\\rcarriage', E'tab\\there', 7, '\\xff'::bytea, '"just a string"'::jsonb, '2026-06-15 12:00:00'::timestamp, '2026-06-15 12:00:00+09'::timestamptz, true, ARRAY[1,2]),
 (7, 'literal \\N', 'backslashN', 8, '\\x5c4e'::bytea, '{"a":"\\\\N"}'::jsonb, '2026-03-03 03:03:03'::timestamp, '2026-03-03 03:03:03+05:30'::timestamptz, false, ARRAY[NULL]::integer[]);`;

function psql(db, sql) {
  return execFileSync(PSQL, [...HOST, '-d', db, '-t', '-A', '-c', sql], { encoding: 'utf8' });
}

const tmp = mkdtempSync(path.join(tmpdir(), 'copysetup-'));
const fullFile = path.join(tmp, 'full.sql');
const schemaFile = path.join(tmp, 'schema.sql');

// ⚠️ 必须走**文件**而不是 `psql -c "..."`：`-c` 把 SQL 交给 Windows 命令行
// 传递时，中文会被当前活动代码页（GBK）重新编码，Postgres 按 UTF-8 解析
// 就报 `invalid byte sequence for encoding "UTF8"`。写文件则原样保留 UTF-8。
// DATA 里的中文用 U&'\\4E2D\\6587' 形式（Postgres 的 Unicode 转义字面量），
// 彻底绕开编码问题。
writeFileSync(schemaFile, SCHEMA + '\n', 'utf8');
writeFileSync(fullFile, SCHEMA + '\n' + DATA + '\n', 'utf8');

function recreate(db) {
  psql('postgres', `DROP DATABASE IF EXISTS ${db}`);
  psql('postgres', `CREATE DATABASE ${db}`);
}

console.log('▶ 重建 sync_src / sync_dst…');
recreate('sync_src');
recreate('sync_dst');

execFileSync(PSQL, [...HOST, '-d', 'sync_src', '-f', fullFile], { encoding: 'utf8' });
// 目标库只要表结构，数据由测试导入
execFileSync(PSQL, [...HOST, '-d', 'sync_dst', '-f', schemaFile], { encoding: 'utf8' });

const src = psql('sync_src', 'SELECT count(*) FROM t').trim();
const dst = psql('sync_dst', 'SELECT count(*) FROM t').trim();
if (src !== '7' || dst !== '0') {
  console.error(`✘ 数据准备异常：src=${src}（应为 7） dst=${dst}（应为 0）`);
  process.exit(1);
}
console.log(`✔ 就绪：sync_src 有 ${src} 行，sync_dst 有 ${dst} 行（空表待导入）`);
