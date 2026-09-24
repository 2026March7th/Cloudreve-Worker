/**
 * 策略缓存（services/policyCache.ts）行为验证。
 *
 * 重点：L1/L2/DB 三级命中路径、批量 byIds 的 L1 合并（不碰 KV）、
 * 写路径失效（update / softDelete / OneDrive 绕过 repo 的裸 SQL 由调用方
 * 自行 evict，这里测 repo 侧）。
 *
 * 用 esbuild 把真源码打进临时目录再跑（不重写实现），KV 与 Sql 全 stub。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'pcache-'));

const entry = path.join(tmp, 'entry.ts');
writeFileSync(
  entry,
  `
export * from ${JSON.stringify(path.join(ROOT, 'src/services/policyCache.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/db/repo.ts'))};
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
const {
  getCachedPolicy,
  getCachedPoliciesByIds,
  evictPolicyCache,
  clearPolicyCacheMemory,
  policyCacheSize,
  rememberPolicyEnv,
  kvFor,
  PolicyRepo,
} = mod;

/** 极简 KV stub：内存 Map + 调用计数（键含 kvRouter 的 role 前缀）。 */
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
      async list() {
        return { keys: [], list_complete: true, cacheStatus: null };
      },
    },
  };
}

/** 造一行能通过 normalizePolicy 的原始策略行。 */
const rawPolicy = (id, overrides = {}) => ({
  id,
  name: `policy-${id}`,
  type: 's3',
  server: null,
  bucket_name: null,
  is_private: null,
  access_key: null,
  secret_key: null,
  max_size: null,
  dir_name_rule: null,
  file_name_rule: null,
  settings: { slave_policy_ids: [] },
  node_id: null,
  created_at: new Date('2026-09-24T00:00:00Z'),
  updated_at: new Date('2026-09-24T00:00:00Z'),
  deleted_at: null,
  ...overrides,
});

/**
 * 假 Sql：同时支持两种调用形态。
 *  - tagged（`sql\`...\``）：单条 SELECT（${id} 是第一个参数）与
 *    UPDATE（${id} 永远是最后一个参数，且真的改 store，供失效断言用）
 *  - call（`sql(text, params)`）：byIds 的 ANY($1) 批量
 * 每次查询计数，用于断言「缓存省了几次往返」。
 */
function makeSql(store) {
  const stats = { query: 0 };
  const sql = (...args) => {
    stats.query += 1;
    const first = args[0];
    const isTagged = Array.isArray(first) && Array.isArray(first.raw);
    if (isTagged) {
      const text = first.join('?');
      const params = args.slice(1);
      if (text.includes('SELECT * FROM storage_policies')) {
        const row = store.get(params[0]);
        return Promise.resolve(row && !row.deleted_at ? [{ ...row }] : []);
      }
      if (text.includes('UPDATE storage_policies')) {
        const row = store.get(params[params.length - 1]);
        if (row) {
          if (text.includes('SET name =')) row.name = params[0];
          if (text.includes('SET deleted_at =')) row.deleted_at = params[0];
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }
    const ids = args[1][0] ?? [];
    return Promise.resolve(
      ids.map((i) => store.get(i)).filter((r) => r && !r.deleted_at),
    );
  };
  return { sql, stats };
}

const envOf = (kv) => ({ KV_2: kv.ns });

console.log('── 策略缓存 ──');

// ---------- 1. 回源 + L1 命中 + KV 回填 ----------
{
  clearPolicyCacheMemory();
  const kv = makeKv();
  rememberPolicyEnv(envOf(kv));
  const store = new Map([
    [7, rawPolicy(7)],
    [8, rawPolicy(8)],
  ]);
  const { sql, stats } = makeSql(store);

  const p1 = await getCachedPolicy(sql, 7);
  assert.equal(p1.id, 7);
  assert.equal(stats.query, 1, '首次应回源一次');
  assert.equal(kv.stats.put, 1, '应回填 L2(KV)');

  const q0 = stats.query;
  const g0 = kv.stats.get;
  const p2 = await getCachedPolicy(sql, 7);
  assert.equal(p2.id, 7);
  assert.equal(stats.query, q0, 'L1 命中不回源');
  assert.equal(kv.stats.get, g0, 'L1 命中不打 KV');
}

// ---------- 2. L2(KV) 命中：新 isolate（L1 空）不回源 ----------
{
  clearPolicyCacheMemory();
  const kv = makeKv();
  // 预写一条 L2（模拟上一个 isolate 的回填），键要过 kvFor 的 role 前缀
  await kvFor(envOf(kv), 'session').put('policy:v1:9', JSON.stringify(rawPolicy(9)));
  rememberPolicyEnv(envOf(kv));
  const store = new Map(); // 故意让 DB 里没有，命中 L2 就不该回源
  const { sql, stats } = makeSql(store);

  const p = await getCachedPolicy(sql, 9);
  assert.equal(p.id, 9, 'L2 命中应返回完整策略行');
  assert.equal(p.updated_at instanceof Date, true, 'Date 字段应被复原');
  assert.equal(stats.query, 0, 'L2 命中不回源');
}

// ---------- 3. evict：失效后重新回源 ----------
{
  clearPolicyCacheMemory();
  const kv = makeKv();
  rememberPolicyEnv(envOf(kv));
  const store = new Map([[5, rawPolicy(5)]]);
  const { sql, stats } = makeSql(store);

  await getCachedPolicy(sql, 5);
  await evictPolicyCache(5);
  assert.equal(kv.stats.delete, 1, '失效应删 L2');
  const q0 = stats.query;
  await getCachedPolicy(sql, 5);
  assert.equal(stats.query, q0 + 1, '失效后应重新回源');
}

// ---------- 4. byIds：顺序保持 / 去重 / 丢弃缺失 / L1 合并 ----------
{
  clearPolicyCacheMemory();
  const kv = makeKv();
  rememberPolicyEnv(envOf(kv));
  const store = new Map([
    [1, rawPolicy(1)],
    [2, rawPolicy(2)],
    [3, rawPolicy(3)],
  ]);
  const { sql, stats } = makeSql(store);

  const r1 = await getCachedPoliciesByIds(sql, [2, 1, 3, 99, 2]);
  assert.deepEqual(
    r1.map((p) => p.id),
    [2, 1, 3],
    '顺序与入参一致 + 去重 + 丢弃缺失',
  );
  assert.equal(stats.query, 1, '缺失项合并成一次批量 SQL');
  assert.equal(kv.stats.put, 0, '批量路径不写 KV（KV 无批量接口）');

  // 第二次：全部 L1 命中，0 查询
  const q0 = stats.query;
  await getCachedPoliciesByIds(sql, [1, 2, 3]);
  assert.equal(stats.query, q0, '热路径 0 查询');
  assert.equal(policyCacheSize(), 3, 'L1 条数正确');
}

// ---------- 5. repo 接线：byId/byIds 走缓存，update/softDelete 失效 ----------
{
  clearPolicyCacheMemory();
  const kv = makeKv();
  rememberPolicyEnv(envOf(kv));
  const store = new Map([[5, rawPolicy(5)]]);
  const { sql, stats } = makeSql(store);
  const repo = new PolicyRepo(sql);

  const p = await repo.byId(5);
  assert.equal(p.id, 5, 'repo.byId 应返回缓存层结果');
  const q0 = stats.query;
  await repo.byId(5);
  assert.equal(stats.query, q0, 'repo.byId 二次调用应命中 L1');

  // update 后失效 → 再读回源
  await repo.update(5, { name: 'renamed' }, {});
  assert.equal(store.get(5).name, 'renamed', 'update 应已写库');
  const q1 = stats.query;
  const p2 = await repo.byId(5);
  assert.equal(p2.name, 'renamed', '失效后回源拿到新值');
  assert.equal(stats.query, q1 + 1, 'update 后应重新回源');

  // softDelete 后失效，且不再返回（deleted_at 非空被过滤）
  await repo.softDelete(5);
  store.get(5).deleted_at = new Date();
  const p3 = await repo.byId(5);
  assert.equal(p3, null, '软删后应返回 null');

  const rows = await repo.byIds([5]);
  assert.deepEqual(rows, [], 'byIds 应丢弃已软删行');
}

// ---------- 6. 坏 L2 数据：按未命中回源，不崩 ----------
{
  clearPolicyCacheMemory();
  const kv = makeKv();
  rememberPolicyEnv(envOf(kv));
  await kvFor(envOf(kv), 'session').put('policy:v1:11', JSON.stringify({ foo: 'bar' }));
  const store = new Map([[11, rawPolicy(11)]]);
  const { sql, stats } = makeSql(store);

  const p = await getCachedPolicy(sql, 11);
  assert.equal(p.id, 11, '坏 L2 数据应回源而不是返回垃圾');
  assert.equal(stats.query, 1);
}

console.log('\n全部通过 ✓');
