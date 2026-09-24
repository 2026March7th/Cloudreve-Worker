/**
 * 分域库解析（db/shard.ts resolveDomainHandle + db/index.ts 域连接串）离线测试。
 *
 * 场景：只填主库（全回退）/ _2/_3 已填（各归各域）/ _2 与主库相同（视为未配置）/
 * 域库失败后的降级窗口。neon 客户端是惰性的（不执行查询就没有网络），可安全构造。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'dshard-'));

const entry = path.join(tmp, 'entry.ts');
writeFileSync(
  entry,
  `
export * from ${JSON.stringify(path.join(ROOT, 'src/db/shard.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/db/index.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/db/audit.ts'))};
`,
);

const out = path.join(tmp, 'bundle.mjs');
await esbuild.build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['cloudflare:sockets'],
  logLevel: 'error',
});

const mod = await import('file://' + out.replace(/\\/g, '/'));
const { auditDomainUrl, metadataDomainUrl, resolveDomainHandle, noteDomainFailure, getSql } = mod;

const PRIMARY = 'postgres://u:p@ep-primary.neon.tech/db';
const DB2 = 'postgres://u:p@ep-db2.neon.tech/db';
const DB3 = 'postgres://u:p@ep-db3.neon.tech/db';
const env = (urls) => ({ DATABASE_URL: urls[0], DATABASE_URL_2: urls[1] ?? '', DATABASE_URL_3: urls[2] ?? '' });

console.log('── 分域库解析 ──');

// 1. 只填主库：两个域都回退主库
{
  const e = env([PRIMARY]);
  assert.equal(auditDomainUrl(e), null, '只填主库：日志域为空');
  assert.equal(metadataDomainUrl(e), null, '只填主库：元数据域为空');
  const h = resolveDomainHandle(e, 'audit');
  assert.equal(h.index, 0, '回退句柄落在主库');
}

// 2. _2/_3 已填：各归各域，互不串
{
  const e = env([PRIMARY, DB2, DB3]);
  assert.equal(auditDomainUrl(e), DB2);
  assert.equal(metadataDomainUrl(e), DB3);
  const audit = resolveDomainHandle(e, 'audit');
  const meta = resolveDomainHandle(e, 'metadata');
  assert.equal(audit.index, 1, '审计域 = DATABASE_URL_2');
  assert.equal(meta.index, 2, '元数据域 = DATABASE_URL_3');
  assert.notEqual(audit.sql, meta.sql, '两个域是不同的客户端');
  assert.notEqual(audit.sql, getSql(e), '域客户端不等于主库客户端');
}

// 3. _2 与主库相同：视为未配置（避免同库自引用）
{
  const e = env([PRIMARY, PRIMARY, DB3]);
  assert.equal(auditDomainUrl(e), null, '_2 与主库相同 → 日志域为空');
  assert.equal(metadataDomainUrl(e), DB3, '_3 正常生效');
}

// 4. 降级窗口：域库失败后 30s 内回退主库，恢复后回域库
{
  const e = env([PRIMARY, DB2, DB3]);
  const before = resolveDomainHandle(e, 'audit');
  assert.equal(before.index, 1, '健康时打域库');

  noteDomainFailure('audit');
  const degraded = resolveDomainHandle(e, 'audit');
  assert.equal(degraded.index, 0, '降级窗口内回退主库');
  assert.equal(degraded.degraded, true, '标记 degraded');
  const meta = resolveDomainHandle(e, 'metadata');
  assert.equal(meta.index, 2, '审计域降级不影响元数据域');
}

console.log('\n全部通过 ✓');
