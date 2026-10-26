/**
 * SSE 客户端标识的单测（`src/lib/sse.ts`）。
 *
 * 钉的是 2026-10-26 那个真事：官方桌面端发 `X-Cr-Client-Id`，我们只认
 * `X-Client-Id`，于是 `/file/events` 回 400 信封，桌面端显示「实时事件推送丢失」。
 *
 * 跑法：`npm run test:sse`
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'ssetest');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

/** Hono 的 header() 大小写不敏感，这里照样模拟。 */
function headersOf(map) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower.get(name.toLowerCase());
}

try {
  const bundlePath = path.join(outDir, 'sse.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/sse.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { sseClientId } = await import(`file://${bundlePath}`);

  const CLIENT_UUID = '6f1c2b3a-1111-4a2b-9c3d-000000000001';

  console.log("\n[1] 官方桌面端的头（X-Cr-Client-Id）");
  check(
    'X-Cr-Client-Id 被识别',
    sseClientId(headersOf({ 'X-Cr-Client-Id': CLIENT_UUID })) === CLIENT_UUID,
  );
  check(
    '大小写不敏感',
    sseClientId(headersOf({ 'x-cr-client-id': CLIENT_UUID })) === CLIENT_UUID,
  );

  console.log('\n[2] 兼容旧写法与 query');
  check('X-Client-Id 仍可用', sseClientId(headersOf({ 'X-Client-Id': 'abc' })) === 'abc');
  check('query client_id 兜底', sseClientId(headersOf({}), 'from-query') === 'from-query');
  check(
    '头优先于 query',
    sseClientId(headersOf({ 'X-Cr-Client-Id': 'from-header' }), 'from-query') === 'from-header',
  );

  console.log('\n[3] 都没有时生成一个，不抛错');
  const generated = sseClientId(headersOf({}), null);
  check('返回非空字符串', typeof generated === 'string' && generated.length >= 16, generated);
  check('两次生成不同', sseClientId(headersOf({})) !== sseClientId(headersOf({})));
  check('空串头不会当成有效值', sseClientId(headersOf({ 'X-Cr-Client-Id': '   ' }), 'q') === 'q');

  console.log(
    `\n${failed === 0 ? '全部通过' : `${failed} 项不通过`}（${passed} 项通过，${failed} 项失败）`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('测试异常：', err);
  process.exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
