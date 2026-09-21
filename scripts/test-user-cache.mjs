/**
 * 用户缓存（services/userCache.ts）行为验证。
 *
 * 重点验证**失效**：缓存用户数据最大的风险不是慢，而是「改了不生效」
 * —— 例如管理员封禁了用户但对方还能登录、用户改完密码旧密码仍可用。
 * 所以这里既验证命中路径，也验证每条写路径都会清缓存。
 *
 * 用 esbuild 把真源码打进临时目录再跑（不重写实现），
 * 用 stub 顶掉 KV 与 Sql：不需要真库、不需要网络。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'ucache-'));

const entry = path.join(tmp, 'entry.ts');
writeFileSync(
  entry,
  `
export * from ${JSON.stringify(path.join(ROOT, 'src/services/userCache.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/db/repo.ts'))};
`,
);

const out = path.join(tmp, 'bundle.mjs');
execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules/esbuild/bin/esbuild'),
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--external:cloudflare:sockets',
    `--outfile=${out}`,
    '--log-level=error',
  ],
  { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
);

const mod = await import('file://' + out.replace(/\\/g, '/'));
const { getCachedUser, evictUserCache, clearUserCacheMemory, rememberEnv, userCacheSize, UserRepo } = mod;

/** 极简 KV stub：内存 Map，记录 get/put/delete 调用次数。 */
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

const fakeUser = (id) => ({
  id,
  email: `u${id}@example.com`,
  nick: `user${id}`,
  storage: 100,
  status: 'active',
  group_users: 2,
  settings: {},
  group: { id: 2, name: 'Default', permission: 'abc' },
});

/** 造一个只在 byIdWithGroup 上计数的假 Sql/Repo 环境。 */
function makeEnv(kv, dbHits) {
  const sql = () => {
    throw new Error('（本测试不应触发裸 SQL）');
  };
  // UserRepo 只用到 this.sql；这里给一个可调用的假 sql，并让 byIdWithGroup 计数。
  const origRepo = UserRepo;
  return {
    env: {
      KV_2: kv.ns,
      KV: kv.ns,
    },
    sql,
  };
}

console.log('── 用户缓存 ──');

// ---------- 1. 回源 + 回填 ----------
{
  clearUserCacheMemory();
  const kv = makeKv();
  const env = { KV_2: kv.ns };
  rememberEnv(env);

  let dbHits = 0;
  // 用真 UserRepo，但把 byIdWithGroup 换成计数实现（其余方法保持真实）。
  const repoProto = UserRepo.prototype;
  const orig = repoProto.byIdWithGroup;
  repoProto.byIdWithGroup = async function (id) {
    dbHits += 1;
    return fakeUser(id);
  };

  const u1 = await getCachedUser(env, {}, 7);
  assert.equal(u1.id, 7);
  assert.equal(dbHits, 1, '首次应回源一次');
  assert.equal(kv.stats.put, 1, '应回填 L2');

  // L1 命中：不再打 KV、不再回源
  const kvGetsBefore = kv.stats.get;
  const u2 = await getCachedUser(env, {}, 7);
  assert.equal(u2.id, 7);
  assert.equal(dbHits, 1, 'L1 命中不该回源');
  assert.equal(kv.stats.get, kvGetsBefore, 'L1 命中不该打 KV');
  console.log('  ✓ 首次回源并回填；随后 L1 命中（0 次 DB、0 次 KV）');

  // ---------- 2. L1 过期后走 L2 ----------
  // 直接把 L1 清掉，模拟 TTL 到期（比 sleep 3s 快）
  clearUserCacheMemory();
  kv.stats.get = 0;
  const u3 = await getCachedUser(env, {}, 7);
  assert.equal(u3.id, 7);
  assert.equal(dbHits, 1, 'L2 命中后仍不该回源');
  assert.equal(kv.stats.get, 1, 'L1 未命中应查一次 L2');
  console.log('  ✓ L1 未命中 → L2 命中（1 次 KV get，0 次 DB）');

  // ---------- 3. 失效：L1 + L2 都要清 ----------
  await evictUserCache(7);
  assert.equal(userCacheSize(), 0, 'L1 应被清空');
  assert.equal(kv.stats.delete, 1, 'L2 应被删一次');
  clearUserCacheMemory();
  kv.stats.get = 0;
  await getCachedUser(env, {}, 7);
  assert.equal(kv.stats.get, 1, '失效后应重新查 L2');
  assert.equal(dbHits, 2, '失效后应重新回源');
  console.log('  ✓ 失效清掉 L1+L2，下次请求重新回源');

  // ---------- 4. 仓储层写方法自动失效（关键：防漏） ----------
  // 逐个验证 8 个写方法都会触发缓存清理。这是防止「改了不生效」的核心断言。
  const writeMethods = [
    ['updatePassword', [7, 'newdigest']],
    ['updateProfile', [7, { nick: 'x' }]],
    ['updateSettings', [7, { a: 1 }]],
    ['updateGroup', [7, 3]],
    ['updateStatus', [7, 'sys_banned']],
    ['updateEmail', [7, 'new@example.com']],
    ['setTwoFactorSecret', [7, 'SECRET']],
    ['addStorage', [7, 123]],
  ];

  for (const [name, args] of writeMethods) {
    clearUserCacheMemory();
    const u = fakeUser(7);
    // 预置缓存
    const kv2 = makeKv();
    const env2 = { KV_2: kv2.ns };
    rememberEnv(env2);
    const sqlTag = Object.assign(
      () => Promise.resolve([]),
      { transaction: async () => [] },
    );
    const repo = new UserRepo(sqlTag);
    // 先把该用户放进 L1/L2
    await kv2.ns.put('user:v2:7', JSON.stringify(u));
    const repoHit = UserRepo.prototype.byIdWithGroup;
    UserRepo.prototype.byIdWithGroup = async (id) => fakeUser(id);
    await getCachedUser(env2, {}, 7); // 填 L1
    assert.equal(userCacheSize(), 1, `${name}: 前置缓存应存在`);

    UserRepo.prototype.byIdWithGroup = repoHit;
    await repo[name](...args);

    assert.equal(userCacheSize(), 0, `${name} 应清掉 L1`);
    assert.equal(kv2.stats.delete, 1, `${name} 应删掉 L2 键`);
  }
  console.log(`  ✓ ${writeMethods.length} 个写方法全部自动失效（L1+L2），无遗漏`);

  // 还原
  repoProto.byIdWithGroup = orig;
}

console.log('  ✓ 全部通过');
rmSync(tmp, { recursive: true, force: true });
