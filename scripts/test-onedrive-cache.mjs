/**
 * OneDrive 驱动令牌缓存行为验证（src/storage/onedrive.ts）。
 *
 * 覆盖五条关键路径：
 *   T1  冷启动刷新 + L1 命中 + 并发单飞 + 轮换 refresh_token 回写数据库
 *   T2  KV 里的轮换令牌优先于数据库旧值被用于刷新
 *   T3  刷新失败（微软 5xx）但缓存 token 仍在真实有效期内 → 降级继续用，不抛错
 *   T4  刷新失败且缓存 token 已真过期 → 抛错（不吞）
 *   T5  Graph 401 → 强制换新后重试自愈
 *   T6  exchangeCode（重新授权）结果直接进 L1
 *
 * 用 esbuild 把真源码打进临时目录再跑（不重写实现）。
 * 全局 fetch stub 在**导入 bundle 之前**安装：微软端点与 Neon 端点
 * 都由它分流应答（Neon 的 fetchFunction 在首查询时捕获当时的全局 fetch）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'odcache-'));

// ---------------------------------------------------------------------------
// 全局 fetch stub（必须先装，再 import bundle）
// ---------------------------------------------------------------------------
const calls = { token: 0, graph: 0, db: 0, dbSql: [] };
let tokenQueue = []; // { status, body }
let graphQueue = []; // { status, body }
const nowS = () => Math.floor(Date.now() / 1000);

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : String(input instanceof URL ? input : input.url);
  if (url.includes('microsoftonline.com') || url.includes('chinacloudapi.cn')) {
    calls.token += 1;
    const r = tokenQueue.length
      ? tokenQueue.shift()
      : { status: 200, body: JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) };
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('graph.') || url.includes('/sql')) {
    if (url.includes('/sql')) {
      // Neon HTTP：记录 SQL，返回最小成功响应
      calls.db += 1;
      try {
        if (init && init.body) calls.dbSql.push(String(init.body));
      } catch {}
      return new Response(JSON.stringify({ command: 'UPDATE', rowCount: 1, rows: [], fields: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    calls.graph += 1;
    const r = graphQueue.length
      ? graphQueue.shift()
      : { status: 200, body: JSON.stringify({ size: 1 }) };
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('unexpected fetch: ' + url);
};

// ---------------------------------------------------------------------------
// bundle
// ---------------------------------------------------------------------------
const entry = path.join(tmp, 'entry.ts');
writeFileSync(
  entry,
  `
export * from ${JSON.stringify(path.join(ROOT, 'src/storage/onedrive.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/lib/kvRouter.ts'))};
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
const { OneDriveDriver, invalidateOdCredentialCache, kvFor } = mod;

// ---------------------------------------------------------------------------
// stub 基础设施
// ---------------------------------------------------------------------------
function makeKv() {
  const store = new Map();
  const stats = { get: 0, put: 0, delete: 0 };
  return {
    store,
    stats,
    ns: {
      async get(k) {
        stats.get += 1;
        return store.has(k) ? JSON.parse(store.get(k)) : null;
      },
      async put(k, v) {
        stats.put += 1;
        store.set(k, v);
      },
      async delete(k) {
        stats.delete += 1;
        store.delete(k);
      },
    },
  };
}

const kv = makeKv();
const env = {
  KV_4: kv.ns,
  DATABASE_URL: 'postgres://user:password@ep-test123456.us-east-2.aws.neon.tech/neondb?sslmode=require',
};

function makePolicy(id, accessKey) {
  return {
    id,
    type: 'onedrive',
    name: 'od-' + id,
    server: 'https://graph.microsoft.com/v1.0',
    bucket_name: 'client-id-' + id,
    secret_key: 'client-secret',
    access_key: accessKey ?? 'rt-db-initial-' + id,
    settings: { od_redirect: 'https://example.com/cb' },
    updated_at: new Date('2026-09-21T12:00:00Z'),
  };
}
const driver = (id, accessKey) => new OneDriveDriver(env, makePolicy(id, accessKey));

const CRED = (id) => 'cred_od_' + id;

// ---------------------------------------------------------------------------
// T1 冷启动刷新 + L1 命中 + 并发单飞 + 轮换回写
// ---------------------------------------------------------------------------
{
  const d = driver(1);
  tokenQueue = [
    { status: 200, body: JSON.stringify({ access_token: 'AT1', refresh_token: 'RT2', expires_in: 3600 }) },
  ];
  // 3 个并发操作都走到 accessToken：应共享同一次刷新（单飞）
  await Promise.all([d.meta('a.txt'), d.meta('b.txt'), d.meta('c.txt')]);
  assert.equal(calls.token, 1, 'T1 并发单飞：微软 token 端点只打 1 次');
  assert.equal(calls.graph, 3, 'T1 三个并发 Graph 请求各自发出');
  assert.ok(kv.store.has('cred:' + CRED(1)), 'T1 凭证已写入 KV（带 cred: 前缀）');

  // 轮换出的 RT2 回写数据库
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.db >= 1, 'T1 刷新后向数据库写回轮换令牌');
  assert.ok(
    calls.dbSql.some((s) => s.includes('storage_policies') && s.includes('RT2')),
    'T1 SQL 里包含新 refresh_token RT2',
  );

  // 第二次操作：L1 命中，KV 都不再读
  const kvGets = kv.stats.get;
  await d.meta('d.txt');
  assert.equal(calls.token, 1, 'T1 L1 命中后不再刷新');
  assert.equal(kv.stats.get, kvGets, 'T1 L1 命中后连 KV 都不读');
}

// ---------------------------------------------------------------------------
// T2 KV 里的轮换令牌优先于数据库旧值
// ---------------------------------------------------------------------------
{
  const t0 = calls.token;
  await kvFor(env, 'cred').put(
    CRED(2),
    JSON.stringify({
      access_token: 'AT_EXPIRED_SOON',
      refresh_token: 'RT_FROM_KV',
      expires_in: nowS() + 100, // margin(600) 内 → 触发刷新
      refreshed_at: nowS() - 3500,
    }),
  );
  const d = driver(2, 'rt-db-stale');
  tokenQueue = [
    { status: 200, body: JSON.stringify({ access_token: 'AT2', refresh_token: 'RT3', expires_in: 3600 }) },
  ];
  await d.meta('a.txt');
  assert.equal(calls.token - t0, 1, 'T2 margin 内触发刷新');
  assert.ok(
    calls.dbSql.some((s) => s.includes('RT3')),
    'T2 轮换令牌 RT3 回写数据库',
  );
}

// ---------------------------------------------------------------------------
// T3 刷新失败但缓存 token 仍在真实有效期内 → 降级继续用
// ---------------------------------------------------------------------------
{
  await kvFor(env, 'cred').put(
    CRED(3),
    JSON.stringify({
      access_token: 'AT_STILL_VALID',
      refresh_token: 'RT_X',
      expires_in: nowS() + 300, // margin 内但未真过期
      refreshed_at: nowS() - 3300,
    }),
  );
  invalidateOdCredentialCache(3); // 清 L1，强制走 KV 路径
  const d = driver(3);
  const t0 = calls.token;
  tokenQueue = [{ status: 500, body: 'MS boom' }];
  const size = await d.meta('a.txt'); // 不应抛错
  assert.equal(calls.token - t0, 1, 'T3 尝试过刷新');
  assert.ok(size && size.size === 1, 'T3 降级用旧 token 完成 Graph 调用');
}

// ---------------------------------------------------------------------------
// T4 刷新失败且缓存 token 已真过期 → 抛错
// ---------------------------------------------------------------------------
{
  await kvFor(env, 'cred').put(
    CRED(4),
    JSON.stringify({
      access_token: 'AT_DEAD',
      refresh_token: 'RT_DEAD',
      expires_in: nowS() - 10, // 真过期
      refreshed_at: nowS() - 7200,
    }),
  );
  invalidateOdCredentialCache(4);
  const d = driver(4);
  tokenQueue = [{ status: 400, body: '{"error":"invalid_grant"}' }];
  await assert.rejects(() => d.meta('a.txt'), /Failed to refresh OneDrive token/, 'T4 真过期且刷新失败要抛错');
}

// ---------------------------------------------------------------------------
// T5 Graph 401 → 强制换新后重试自愈
// ---------------------------------------------------------------------------
{
  const d = driver(5);
  const t0 = calls.token;
  tokenQueue = [
    { status: 200, body: JSON.stringify({ access_token: 'AT5a', refresh_token: 'RT5b', expires_in: 3600 }) },
  ];
  await d.meta('warm.txt'); // 正常拿一次 token，进 L1
  assert.equal(calls.token - t0, 1);
  graphQueue = [
    { status: 401, body: '{"error":"token revoked"}' },
    { status: 200, body: JSON.stringify({ size: 42 }) },
  ];
  const size = await d.meta('c.txt');
  assert.equal(calls.token - t0, 2, 'T5 401 触发强制刷新');
  assert.ok(size && size.size === 42, 'T5 刷新后重试成功');
}

// ---------------------------------------------------------------------------
// T6 exchangeCode（重新授权）结果直接进 L1
// ---------------------------------------------------------------------------
{
  const d = driver(6);
  const t0 = calls.token;
  tokenQueue = [
    { status: 200, body: JSON.stringify({ access_token: 'AT6', refresh_token: 'RT6', expires_in: 3600 }) },
  ];
  await d.exchangeCode('auth-code-xyz');
  assert.equal(calls.token - t0, 1, 'T6 授权码换 token 打 1 次');
  assert.ok(kv.store.has('cred:' + CRED(6)), 'T6 凭证写入 KV');
  const kvGets = kv.stats.get;
  await d.meta('x.txt');
  assert.equal(calls.token - t0, 1, 'T6 后续操作用 L1，不再刷新');
  assert.equal(kv.stats.get, kvGets, 'T6 后续操作不读 KV');
}

// ---------------------------------------------------------------------------
// T7 invalidateOdCredentialCache 生效（清 L1 后下一次读 KV）
// ---------------------------------------------------------------------------
{
  invalidateOdCredentialCache(6);
  const d = driver(6);
  const t0 = calls.token;
  const kvGets = kv.stats.get;
  await d.meta('y.txt');
  assert.equal(calls.token - t0, 0, 'T7 KV 里凭证仍有效，不刷新');
  assert.ok(kv.stats.get > kvGets, 'T7 L1 失效后回落到 KV');
}

// ---------------------------------------------------------------------------
// T8 授权状态：数据库为权威（KV 传播延迟不误报「掉授权」）
// ---------------------------------------------------------------------------
{
  // 库里有 access_key、KV/L1 全空（模拟刚授权完、KV 未同步到的 colo）
  const d = driver(8, 'rt-db-8');
  const st = await d.credentialStatus();
  assert.equal(st.valid, true, 'T8 库里有 refresh token 即已授权');
  assert.equal(
    st.last_refresh_time,
    new Date('2026-09-21T12:00:00Z').toISOString(),
    'T8 缓存缺失时回退 policy.updated_at',
  );

  // 缓存命中时返回精确刷新时间
  await kvFor(env, 'cred').put(
    CRED(8),
    JSON.stringify({
      access_token: 'AT8',
      refresh_token: 'RT8',
      expires_in: nowS() + 3600,
      refreshed_at: 1700000000,
    }),
  );
  const st2 = await d.credentialStatus();
  assert.equal(st2.valid, true, 'T8 缓存命中依然有效');
  assert.equal(
    st2.last_refresh_time,
    new Date(1700000000 * 1000).toISOString(),
    'T8 缓存命中返回精确刷新时间',
  );

  // 库里没有 access_key → 未授权
  const d2 = driver(9, '');
  const st3 = await d2.credentialStatus();
  assert.deepEqual(st3, { valid: false, last_refresh_time: null }, 'T9 无 refresh token 即未授权');
}

// ---------------------------------------------------------------------------
console.log('onedrive token cache: all assertions passed');
console.log(
  JSON.stringify(
    { token: calls.token, graph: calls.graph, db: calls.db, kv: kv.stats },
    null,
    2,
  ),
);

try {
  rmSync(tmp, { recursive: true, force: true });
} catch {}
