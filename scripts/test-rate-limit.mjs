/**
 * 限速逻辑的单测。
 *
 * 计数后端是可注入的（`hitRateLimit(env, opts, store)`），测试用内存 Map 替掉
 * 数据库；生产走 `rate_limits` 表的一条原子 upsert。
 *
 * 跑法：`npm run test:rate-limit`
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'rltest');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
};

/** 内存版计数后端，语义与 SQL 的 upsert 一致（窗口变了就重置）。 */
function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async bump(key, windowStart) {
      const cur = rows.get(key);
      const hits = cur && cur.windowStart === windowStart ? cur.hits + 1 : 1;
      rows.set(key, { windowStart, hits });
      return hits;
    },
    async reset(key) {
      rows.delete(key);
    },
  };
}

try {
  const bundlePath = path.join(outDir, 'rl.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/rateLimit.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
    plugins: [
      {
        name: 'db-stub',
        setup(b) {
          b.onResolve({ filter: /^\.\.\/db$/ }, () => ({
            path: path.join(ROOT, 'scripts/fixtures/db-stub.ts'),
          }));
        },
      },
    ],
  });
  const { hitRateLimit, clearRateLimit, clientIp, rateKeyOf, windowStartOf, RATE_LIMITS } =
    await import(`file://${bundlePath}`);

  console.log('\n[1] 计数与超限');
  let store = memoryStore();
  const opts = { bucket: 'test', id: 'a@b.c', limit: 3, windowSec: 60 };
  const seq = [];
  for (let i = 0; i < 4; i += 1) seq.push(await hitRateLimit({}, opts, store));
  check('前 3 次放行', seq.slice(0, 3).every((r) => r.ok));
  check('第 4 次拒绝（超限的那次也计数）', seq[3].ok === false && seq[3].count === 4, JSON.stringify(seq[3]));
  check('拒绝时带 retryAfter（1..60）', seq[3].retryAfter >= 1 && seq[3].retryAfter <= 60, String(seq[3].retryAfter));

  console.log('\n[2] 不同 id / bucket 互不影响');
  check('换 id 重新计数', (await hitRateLimit({}, { ...opts, id: 'x@y.z' }, store)).ok);
  check('换 bucket 重新计数', (await hitRateLimit({}, { ...opts, bucket: 'test2' }, store)).ok);
  check('原 id 仍被拦', (await hitRateLimit({}, opts, store)).ok === false);

  console.log('\n[3] clearRateLimit 清零');
  await clearRateLimit({}, opts, store);
  check('清掉后恢复放行', (await hitRateLimit({}, opts, store)).ok);

  console.log('\n[4] 窗口滚动');
  store = memoryStore();
  const fast = { bucket: 'win', id: 'z', limit: 1, windowSec: 1 };
  check('第 1 次放行', (await hitRateLimit({}, fast, store)).ok);
  check('同窗口第 2 次拒绝', (await hitRateLimit({}, fast, store)).ok === false);
  await new Promise((r) => setTimeout(r, 1100));
  check('新窗口重新放行', (await hitRateLimit({}, fast, store)).ok);

  console.log('\n[5] 计数后端抛错时放行（不能因计数表挂了锁死所有人）');
  const broken = {
    async bump() {
      throw new Error('db down');
    },
    async reset() {
      throw new Error('db down');
    },
  };
  const degraded = await hitRateLimit({}, opts, broken);
  check('后端失败 → ok=true', degraded.ok === true);

  console.log('\n[6] 键与窗口');
  check('键包含 bucket/window/id', rateKeyOf({ bucket: 'b', id: 'i', limit: 1, windowSec: 60 }) === 'b|60|i');
  const ws = windowStartOf(60);
  check('窗口起点按 60 对齐', ws % 60 === 0);

  console.log('\n[7] clientIp 取值优先级');
  const mk = (h) => ({ req: { header: (n) => h[n.toLowerCase()] } });
  check('优先 CF-Connecting-IP', clientIp(mk({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' })) === '1.2.3.4');
  check('回落到 XFF 第一段', clientIp(mk({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' })) === '5.6.7.8');
  check('都没有时 unknown', clientIp(mk({})) === 'unknown');

  console.log('\n[8] 策略数值合理性');
  check('登录邮箱 10/min', RATE_LIMITS.loginByEmail.limit === 10 && RATE_LIMITS.loginByEmail.windowSec === 60);
  check('注册 5/min', RATE_LIMITS.registerByIp.limit === 5);
  check('找回密码 3/5min', RATE_LIMITS.resetByIp.limit === 3 && RATE_LIMITS.resetByIp.windowSec === 300);

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项不通过`}（${passed} 项通过，${failed} 项失败）`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('测试异常：', err);
  process.exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
