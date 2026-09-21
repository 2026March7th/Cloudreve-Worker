/**
 * 缓存清空 / 刷新行为验证。
 *
 * ## 为什么这个测试值得存在
 *
 * 「清空 KV」是**破坏性**操作，而这个系统里有一样东西**绝不能清**：
 * `flag` 角色里的自举标记（`bootstrap:done:v*`）。清掉它会让每次冷启动
 * 重放 `provision()` + `ensureSettings()` —— 两次全表扫描，免费档 Neon
 * 直接打限流，而症状是「站点变慢」而不是「报错」，极难定位。
 *
 * 所以这里最重要的一条断言是：**清理之后自举标记还在**。
 * 这类「不该发生的事没发生」的保证，只能靠测试固化 —— 代码评审看的是
 * 「清理逻辑对不对」，很难注意到「有没有漏掉某个不该清的键」。
 *
 * 其余验证：按前缀精确清理（不误伤别的角色）、预算上限生效、
 * 失败不外溢、预热是覆盖写（不 list/delete，开销恒定）。
 *
 * 用 esbuild 把真源码打进临时目录再跑，用 stub KV 顶掉真 namespace ——
 * 不重写实现，也不需要网络与 Cloudflare 账号。
 *
 * 用法：node scripts/test-cache-purge.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'cachepurge-'));

const entry = path.join(tmp, 'entry.ts');
writeFileSync(
  entry,
  `
export * from ${JSON.stringify(path.join(ROOT, 'src/services/cacheWarmer.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/lib/cacheRegistry.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/lib/kvRouter.ts'))};
`,
);

const out = path.join(tmp, 'bundle.mjs');
// 用 esbuild 的 JS API（与 test-kv-router.mjs / test-archive-wal.mjs 一致）。
// 不要 `node node_modules/esbuild/bin/esbuild`：Windows 上是 JS 包装脚本
// 所以本地能跑，Linux 上是原生 ELF 二进制，会报 SyntaxError。
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
const { purgeAllCaches, purgeEntry, warmAllCaches, CACHE_ENTRIES, purgeableEntries, kvFor } = mod;

/**
 * 内存 KV stub。`list` 返回的是**真实键名**（含调用方传进来的前缀），
 * 因此这里记录的 store 键名就是 `角色:业务键` —— 与线上一致，能直接
 * 断言「哪些键被删了」。
 */
function makeKv({ failOn } = {}) {
  const store = new Map();
  const stats = { get: 0, put: 0, delete: 0, list: 0, deletedKeys: [] };
  const maybeThrow = (op) => {
    if (failOn === op) throw new Error(`simulated KV ${op} failure`);
  };
  return {
    store,
    stats,
    ns: {
      async get(k) {
        stats.get += 1;
        maybeThrow('get');
        return store.has(k) ? store.get(k) : null;
      },
      async put(k, v) {
        stats.put += 1;
        maybeThrow('put');
        store.set(k, v);
      },
      async delete(k) {
        stats.delete += 1;
        maybeThrow('delete');
        stats.deletedKeys.push(k);
        store.delete(k);
      },
      async list(opts = {}) {
        stats.list += 1;
        maybeThrow('list');
        const prefix = opts.prefix ?? '';
        const limit = opts.limit ?? 1000;
        const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const keys = all.slice(0, limit);
        // 简化的分页：一次给完（测试数据量小），足够验证清理语义。
        return { keys: keys.map((name) => ({ name })), list_complete: true, cacheStatus: null };
      },
    },
  };
}

/** 造一个 env：5 个角色各一个独立 namespace。 */
function makeEnv(overrides = {}) {
  const kvs = {
    KV_1: makeKv(),
    KV_2: makeKv(),
    KV_3: makeKv(),
    KV_4: makeKv(),
    KV_5: makeKv(),
  };
  const env = {};
  for (const [name, kv] of Object.entries(kvs)) env[name] = kv.ns;
  return { env: { ...env, ...overrides }, kvs };
}

console.log('── 缓存清空 / 刷新 ──');

// ---------- 1. 清单本身的正确性 ----------
{
  assert.ok(CACHE_ENTRIES.length >= 6, `缓存清单应有若干条，实际 ${CACHE_ENTRIES.length}`);
  const flag = CACHE_ENTRIES.find((e) => e.role === 'flag');
  assert.ok(flag, '清单里必须有 flag 条目（用于显式排除）');
  assert.equal(flag.purge, false, '★ flag 角色必须 purge=false —— 否则会触发重新自举');

  const purgeable = purgeableEntries();
  assert.ok(
    purgeable.every((e) => e.role !== 'flag'),
    '★ 可清理名单里绝不能出现 flag 角色',
  );
  assert.equal(purgeable.length, CACHE_ENTRIES.length - 1, '只有 flag 一条不参与清理');
  console.log(`  ✓ 清单 ${CACHE_ENTRIES.length} 类，可清理 ${purgeable.length} 类，flag 已排除`);
}

// ---------- 2. 清理只删该删的（最关键） ----------
{
  const { env, kvs } = makeEnv();
  // 预置数据：每个 namespace 里都放「该清的」与「不该清的」
  kvs.KV_1.store.set('site:settings:all:v1', '{}'); // site 角色，该清
  kvs.KV_1.store.set('site:other:keep', 'x'); // site 角色但不匹配前缀 → 保留
  kvs.KV_2.store.set('session:user:v2:1', '{}'); // session，该清
  kvs.KV_2.store.set('session:captcha:abc', 'ABCD'); // 该清
  kvs.KV_2.store.set('session:session:oidc:state1', 'y'); // 该清
  kvs.KV_3.store.set('upload:upload_session:1', 'z'); // 该清
  kvs.KV_4.store.set('cred:onedrive:token:1', 'tok'); // cred 前缀为空 → 全清
  // ★ 自举标记：绝不能动
  kvs.KV_5.store.set('flag:bootstrap:done:v8', '1');
  kvs.KV_5.store.set('flag:bootstrap:cooldown:v1', '1');

  const before = kvs.KV_5.store.size;
  await purgeAllCaches(env);

  assert.equal(kvs.KV_5.store.size, before, '★ 自举标记必须原封不动');
  assert.ok(kvs.KV_5.store.has('flag:bootstrap:done:v8'), '★ bootstrap:done 必须还在');
  assert.ok(!kvs.KV_5.stats.deletedKeys.some((k) => k.startsWith('flag:')), '★ 不该对 flag 角色发任何 delete');
  assert.equal(kvs.KV_5.stats.list, 0, '★ 连 list 都不该碰 flag 角色（清单里 purge=false 直接跳过）');
  console.log('  ✓ ★ 清理不碰自举标记（flag 角色零操作）');

  assert.ok(!kvs.KV_1.store.has('site:settings:all:v1'), '站点设置缓存应被清掉');
  assert.deepEqual(await kvs.KV_1.ns.get('site:other:keep'), 'x', '不匹配前缀的键应保留');
  assert.ok(!kvs.KV_2.store.has('session:user:v2:1'), '用户缓存应被清掉');
  assert.ok(!kvs.KV_2.store.has('session:captcha:abc'), '验证码应被清掉');
  assert.ok(!kvs.KV_2.store.has('session:session:oidc:state1'), '一次性会话状态应被清掉');
  assert.ok(!kvs.KV_3.store.has('upload:upload_session:1'), '上传会话应被清掉');
  assert.equal(kvs.KV_4.store.size, 0, 'cred 前缀为空 → 整块清空');
  console.log('  ✓ 按前缀精确清理，不误伤其它键');
}

// ---------- 3. 前缀写宽了会误删 —— 证明前缀是有效的闸门 ----------
{
  const { env, kvs } = makeEnv();
  kvs.KV_1.store.set('site:settings:all:v1', '{}');
  kvs.KV_1.store.set('site:custom_nav', 'nav'); // 不属于任何清单条目 → 应保留
  await purgeAllCaches(env);
  assert.ok(!kvs.KV_1.store.has('site:settings:all:v1'));
  assert.ok(kvs.KV_1.store.has('site:custom_nav'), '未被任何条目覆盖的键保留（前缀闸门在生效）');
  console.log('  ✓ 前缀闸门生效：没被清单覆盖的键不会被误删');
}

// ---------- 4. 预算上限 ----------
{
  const { env, kvs } = makeEnv();
  for (let i = 0; i < 50; i++) kvs.KV_2.store.set(`session:user:v2:${i}`, '{}');
  const entry = CACHE_ENTRIES.find((e) => e.id === 'user');
  const r = await purgeEntry(env, entry, 10); // 预算 10
  assert.equal(r.deleted, 10, '应严格按预算删除');
  assert.equal(r.truncated, true, '撞上预算上限应标记 truncated');
  assert.equal(kvs.KV_2.store.size, 40, '剩余的键应完好（构建期脚本下一次继续清）');
  console.log('  ✓ 预算上限生效（Worker 内不会烧爆 subrequest）');
}

// ---------- 5. KV 失败不外溢 ----------
{
  const { env, kvs } = makeEnv();
  kvs.KV_2.store.set('session:user:v2:1', '{}');
  kvs.KV_2.ns.list = async () => {
    throw new Error('simulated list failure');
  };
  const results = await purgeAllCaches(env); // 不应抛
  const userResult = results.find((r) => r.id === 'user');
  assert.ok(userResult.error, '失败应记录在结果里而不是抛出');
  // 其它类仍应正常清理
  const settingsResult = results.find((r) => r.id === 'settings');
  assert.equal(settingsResult.error, undefined, '一类失败不该影响其它类');
  console.log('  ✓ 单类失败被隔离（记入结果、不抛、不影响其它类）');
}

// ---------- 6. 预热只做覆盖写，不 list/delete ----------
{
  const { env, kvs } = makeEnv();
  // 预热不应触碰 flag 角色的 list/delete
  for (const [name, kv] of Object.entries(kvs)) {
    kv.stats.list = 0;
    kv.stats.delete = 0;
  }
  const warmed = await warmAllCaches(env); // 站点设置预热会尝试查库；本测试没配 DATABASE_URL
  assert.ok(Array.isArray(warmed) && warmed.length > 0, 'warmAllCaches 应返回逐条结果');
  for (const [name, kv] of Object.entries(kvs)) {
    assert.equal(kv.stats.list, 0, `预热（${name}）不应做 list —— 开销必须恒定`);
    assert.equal(kv.stats.delete, 0, `预热（${name}）不应做 delete —— 只覆盖写`);
  }
  console.log('  ✓ 预热是覆盖写（零 list / 零 delete，开销恒定）');
}

// ---------- 7. 预热失败不外溢 ----------
{
  const { env } = makeEnv(); // 没配 DATABASE_URL → refreshSettingsCache 必然失败
  const warmed = await warmAllCaches(env); // 不应抛
  const settings = warmed.find((w) => w.id === 'settings');
  assert.ok(settings, '应包含 settings 条目');
  assert.equal(settings.ok, false, '缺少数据库时应报告失败（而不是抛）');
  console.log('  ✓ 预热失败被吞掉（返回 ok=false，不抛异常）');
}

// ---------- 8. kvRouter 的 delete 不接受数组（防静默失效） ----------
{
  const { env } = makeEnv();
  const ns = kvFor(env, 'site');
  assert.throws(
    () => ns.delete(['a', 'b']),
    /不接受数组/,
    '★ 传数组必须当场报错 —— 否则 `prefix + array` 会静默删不掉任何键',
  );
  console.log('  ✓ ★ 批量删被显式拒绝（KV 绑定没有批量删，防静默失效）');
}

console.log('  ✓ 全部通过');
