/**
 * 速率限制的单测（用内存 KV 替掉 `lib/kvRouter`）。
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
        name: 'kv-stub',
        setup(b) {
          b.onResolve({ filter: /^\.\/kvRouter$/ }, () => ({
            path: path.join(ROOT, 'scripts/fixtures/dav-kv.ts'),
          }));
        },
      },
    ],
    external: [],
  });
  const { hitRateLimit, clearRateLimit, clientIp, RATE_LIMITS } = await import(`file://${bundlePath}`);
  const { resetKv } = await import(`file://${path.join(ROOT, 'scripts/fixtures/dav-kv.ts')}`);

  console.log('\n[1] 计数与超限');
  resetKv();
  const opts = { bucket: 'test', id: 'a@b.c', limit: 3, windowSec: 60 };
  const results = [];
  for (let i = 0; i < 4; i += 1) results.push(await hitRateLimit({}, opts));
  check('前 3 次放行', results.slice(0, 3).every((r) => r.ok));
  check('第 4 次拒绝', results[3].ok === false);
  check('拒绝时带 retryAfter（1..60）', results[3].retryAfter >= 1 && results[3].retryAfter <= 60, String(results[3].retryAfter));

  console.log('\n[2] 不同 id / 不同 bucket 互不影响');
  const other = await hitRateLimit({}, { ...opts, id: 'x@y.z' });
  check('换 id 重新计数', other.ok);
  const otherBucket = await hitRateLimit({}, { ...opts, bucket: 'test2' });
  check('换 bucket 重新计数', otherBucket.ok);
  const after = await hitRateLimit({}, opts);
  check('原 id 仍然被拦（已超限）', after.ok === false);

  console.log('\n[3] clearRateLimit 清零');
  await clearRateLimit({}, opts);
  const afterClear = await hitRateLimit({}, opts);
  check('清掉后恢复放行', afterClear.ok);

  console.log('\n[4] 窗口滚动');
  resetKv();
  const fast = { bucket: 'win', id: 'z', limit: 1, windowSec: 1 };
  check('1 秒窗口第 1 次放行', (await hitRateLimit({}, fast)).ok);
  check('同窗口第 2 次拒绝', (await hitRateLimit({}, fast)).ok === false);
  await new Promise((r) => setTimeout(r, 1100));
  check('新窗口重新放行', (await hitRateLimit({}, fast)).ok);

  console.log('\n[5] clientIp 取值优先级');
  const mk = (h) => ({ req: { header: (n) => h[n.toLowerCase()] } });
  check('优先 CF-Connecting-IP', clientIp(mk({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' })) === '1.2.3.4');
  check('回落到 XFF 第一段', clientIp(mk({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' })) === '5.6.7.8');
  check('都没有时 unknown', clientIp(mk({})) === 'unknown');

  console.log('\n[6] 策略数值合理性');
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
