/**
 * 归档区 KV + 写前日志（WAL）行为验证。
 *
 * 用 esbuild 把真源码打进临时目录再跑（不重写实现），用 stub KV 顶掉
 * 真 namespace —— 不需要网络、不需要 Cloudflare 账号。
 *
 * 重点验证三件事：
 *   1. **优雅降级**：没绑 ARCHIVE_KV 时所有操作是 no-op，绝不抛异常
 *      （否则「可选能力」会变成「没配就崩」）。
 *   2. **WAL 生命周期**：start 留 pending → done 删掉 → fail 留 failed。
 *      「done 后不残留」是关键 —— 残留会淹没真正需要关注的记录。
 *   3. **失败不外溢**：KV 抛异常时业务调用点不应收到异常。
 *
 * 用法：node scripts/test-archive-wal.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'archwal-'));

const entry = path.join(tmp, 'entry.ts');
writeFileSync(
  entry,
  `
export * from ${JSON.stringify(path.join(ROOT, 'src/services/archive.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/services/wal.ts'))};
`,
);

const out = path.join(tmp, 'bundle.mjs');
// 用 esbuild 的 JS API（与 test-kv-router.mjs 一致）。
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
const {
  archiveKv, archiveEnabled, archivePut, archiveList, archiveCount,
  walEnabled, walStart, walDone, walFail, walUnfinished,
} = mod;

/** 内存 KV stub：记录调用次数，可选地模拟抛错。 */
function makeKv({ failOn } = {}) {
  const store = new Map();
  const stats = { get: 0, put: 0, delete: 0, list: 0 };
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
        return store.has(k) ? JSON.parse(store.get(k)) : null;
      },
      async put(k, v) {
        stats.put += 1;
        maybeThrow('put');
        store.set(k, v);
      },
      async delete(k) {
        stats.delete += 1;
        maybeThrow('delete');
        store.delete(k);
      },
      async list(opts = {}) {
        stats.list += 1;
        maybeThrow('list');
        const prefix = opts.prefix ?? '';
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { keys: keys.map((name) => ({ name })), list_complete: true, cacheStatus: null };
      },
    },
  };
}

console.log('── 归档区 KV / 写前日志 ──');

// ---------- 1. 未绑定时优雅降级 ----------
{
  const bare = {}; // 没有 ARCHIVE_KV
  assert.equal(archiveKv(bare), null, '未绑定时 archiveKv 应返回 null');
  assert.equal(archiveEnabled(bare), false);
  assert.equal(walEnabled(bare), false);

  // 所有操作都要是 no-op，且**不抛异常**
  assert.equal(await archivePut(bare, 'settings', 'x', { a: 1 }), false, 'archivePut 应返回 false');
  assert.deepEqual(await archiveList(bare, 'settings'), [], 'archiveList 应返回空数组');
  assert.equal(await archiveCount(bare), 0);
  const h = await walStart(bare, 'op', 'ref');
  assert.equal(h, null, '未绑定时 walStart 应返回 null');
  await walDone(bare, h); // 不应抛
  await walFail(bare, h, 'op', 'ref', new Error('x')); // 不应抛
  assert.deepEqual(await walUnfinished(bare), []);
  console.log('  ✓ 未绑定 ARCHIVE_KV：全部 no-op，不抛异常');
}

// ---------- 2. 归档读写 ----------
{
  const kv = makeKv();
  const env = { ARCHIVE_KV: kv.ns };
  assert.equal(archiveEnabled(env), true);

  const ok = await archivePut(env, 'settings', 'global', { siteName: 'old' }, { actor: 1, note: 'chg' });
  assert.equal(ok, true, 'archivePut 应成功');
  assert.equal(kv.stats.put, 1);

  const list = await archiveList(env, 'settings', 'global');
  assert.equal(list.length, 1, '应能读回 1 条归档');
  assert.deepEqual(list[0].value, { siteName: 'old' });
  assert.equal(list[0].kind, 'settings');
  assert.equal(String(list[0].id), 'global');
  assert.equal(String(list[0].actor), '1');
  console.log('  ✓ 归档写入并读回（含 actor / note）');

  // 同一毫秒内两次归档不能互相覆盖（尾部随机串）
  await archivePut(env, 'settings', 'global', { siteName: 'older' });
  const list2 = await archiveList(env, 'settings', 'global');
  assert.equal(list2.length, 2, '同一对象两次归档应留两条（不覆盖）');
  console.log('  ✓ 同一对象的多次归档都保留（不会互相覆盖）');

  // 计数
  assert.equal(await archiveCount(env, 'settings'), 2);
  console.log('  ✓ archiveCount 统计正确');
}

// ---------- 3. 归档写失败不影响调用方 ----------
{
  const env = { ARCHIVE_KV: makeKv({ failOn: 'put' }).ns };
  const r = await archivePut(env, 'settings', 'x', { a: 1 });
  assert.equal(r, false, 'KV put 抛错时 archivePut 应返回 false 而不是抛异常');
  console.log('  ✓ 归档写失败被吞掉（返回值 false，不抛异常）');

  const env2 = { ARCHIVE_KV: makeKv({ failOn: 'list' }).ns };
  assert.deepEqual(await archiveList(env2, 'settings'), [], 'list 抛错应返回空数组');
  console.log('  ✓ 归档读失败被吞掉（返回空数组）');
}

// ---------- 4. WAL 生命周期 ----------
{
  const kv = makeKv();
  const env = { ARCHIVE_KV: kv.ns };

  // start → pending
  const h = await walStart(env, 'payment.fulfill', 'ORD-1', { userId: 7 });
  assert.ok(h, 'walStart 应返回句柄');
  assert.equal(kv.stats.put, 1, '应为 pending 写一条');
  let un = await walUnfinished(env);
  assert.equal(un.length, 1, '应看到 1 条未完成');
  assert.equal(un[0].status, 'pending');
  assert.equal(un[0].op, 'payment.fulfill');
  console.log('  ✓ walStart 留下 pending 记录');

  // done → 删除（不留残留）
  await walDone(env, h);
  assert.equal(kv.stats.delete, 1, 'done 应删除该条');
  un = await walUnfinished(env);
  assert.equal(un.length, 0, 'done 后不该再有未完成记录');
  console.log('  ✓ walDone 删除记录（成功的操作不留残留）');

  // fail → 保留 failed
  const h2 = await walStart(env, 'payment.fulfill', 'ORD-2');
  await walFail(env, h2, 'payment.fulfill', 'ORD-2', new Error('boom'));
  un = await walUnfinished(env);
  assert.equal(un.length, 1, 'failed 应保留');
  assert.equal(un[0].status, 'failed');
  assert.equal(un[0].error, 'boom');
  console.log('  ✓ walFail 保留 failed 记录（含错误原因）');

  // 序列化里不能有循环引用导致丢失（payload 可带对象）
  const h3 = await walStart(env, 'op', 'r3', { nested: { a: [1, 2] } });
  assert.ok(h3);
  const un3 = await walUnfinished(env);
  const withPayload = un3.find((e) => e.ref === 'r3');
  assert.deepEqual(withPayload.payload, { nested: { a: [1, 2] } }, 'payload 应原样保留');
  console.log('  ✓ payload 原样保留');

  // 按开始时间倒序（最新的在前）
  assert.equal(un3[0].ref, 'r3', '最新的应排在最前');
  console.log('  ✓ 未完成列表按开始时间倒序');
}

// ---------- 5. WAL 在 KV 抛错时不外溢 ----------
{
  const env = { ARCHIVE_KV: makeKv({ failOn: 'put' }).ns };
  const h = await walStart(env, 'op', 'ref');
  assert.equal(h, null, 'walStart 遇 KV 错误应返回 null 而不是抛');
  await walFail(env, { key: 'x', startedAt: 'now' }, 'op', 'ref', new Error('e')); // 不应抛
  console.log('  ✓ WAL 写入失败不外溢（返回 null / 静默）');
}

console.log('  ✓ 全部通过');
rmSync(tmp, { recursive: true, force: true });
