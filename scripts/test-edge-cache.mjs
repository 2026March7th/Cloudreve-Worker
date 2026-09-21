/**
 * 边缘 CDN 缓存（lib/edgeCache.ts + services/download.ts serveEntity）行为验证。
 *
 * 覆盖：
 *   T1  edgeCachePut：键规范化（query 不入键）、Cache-Control、body 完整
 *   T2  非 200 响应不缓存
 *   T3  edgeCacheMatch 命中 / 未命中
 *   T4  caches 全局缺失（本地 Node）时全部跳过、不炸
 *   T5  serveEntity：开关开 → 回源后写缓存 → 第二次命中（不再回源）
 *   T6  Range 请求不参与缓存
 *   T7  策略未开 edge_cache → 不读不写缓存
 *
 * 全局 caches stub 在导入 bundle 之前安装（与 fetch stub 同理）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'edgecache-'));

// ---------------------------------------------------------------------------
// caches.default stub（必须先装，再 import bundle）
// ---------------------------------------------------------------------------
const cacheStore = new Map(); // url(string) -> Response
let putCalls = 0;
globalThis.caches = {
  default: {
    match: async (req) => cacheStore.get(String(req instanceof Request ? req.url : String(req))),
    put: async (req, res) => {
      putCalls += 1;
      cacheStore.set(String(req instanceof Request ? req.url : String(req)), res);
    },
  },
};

// ---------------------------------------------------------------------------
// bundle
// ---------------------------------------------------------------------------
const entry = path.join(tmp, 'entry.ts');
writeFileSync(
  entry,
  `
export * from ${JSON.stringify(path.join(ROOT, 'src/lib/edgeCache.ts'))};
export * from ${JSON.stringify(path.join(ROOT, 'src/services/download.ts'))};
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
const { edgeCacheMatch, edgeCachePut, DownloadService } = mod;

const drain = (p) => Promise.all(p);

// ---------------------------------------------------------------------------
// T1 put：键规范化 + Cache-Control + body 完整
// ---------------------------------------------------------------------------
{
  const waited = [];
  edgeCachePut(
    (p) => waited.push(p),
    'https://x.test',
    '/__edge_cache__/content/e1/a.txt',
    new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    60,
  );
  await drain(waited);
  assert.equal(cacheStore.size, 1, 'T1 缓存写入一条');
  const [url, res] = [...cacheStore.entries()][0];
  assert.equal(url, 'https://x.test/__edge_cache__/content/e1/a.txt', 'T1 键 = origin + 规范化路径');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=60', 'T1 TTL 写进 Cache-Control');
  assert.equal(await res.text(), 'hello', 'T1 缓存体完整');
}

// ---------------------------------------------------------------------------
// T2 非 200 不缓存
// ---------------------------------------------------------------------------
{
  const waited = [];
  edgeCachePut(
    (p) => waited.push(p),
    'https://x.test',
    '/nope',
    new Response('gone', { status: 404 }),
  );
  await drain(waited);
  assert.equal(cacheStore.size, 1, 'T2 非 200 响应被跳过');
}

// ---------------------------------------------------------------------------
// T3 match 命中 / 未命中
// ---------------------------------------------------------------------------
{
  const hit = await edgeCacheMatch('https://x.test', '/__edge_cache__/content/e1/a.txt');
  assert.ok(hit, 'T3 命中返回响应');
  assert.equal(hit.headers.get('Content-Type'), 'text/plain');
  const miss = await edgeCacheMatch('https://x.test', '/never');
  assert.equal(miss, null, 'T3 未命中返回 null');
}

// ---------------------------------------------------------------------------
// T4 caches 缺失（本地 Node 直跑）→ 跳过不炸
// ---------------------------------------------------------------------------
{
  const saved = globalThis.caches;
  globalThis.caches = undefined;
  const hit = await edgeCacheMatch('https://x.test', '/k');
  assert.equal(hit, null, 'T4 无 caches 时 match 返回 null');
  let waited = false;
  edgeCachePut(() => (waited = true), 'https://x.test', '/k', new Response('x'));
  assert.equal(waited, false, 'T4 无 caches 时 put 不排任务');
  globalThis.caches = saved;
}

// ---------------------------------------------------------------------------
// serveEntity 的 fake 上下文
// ---------------------------------------------------------------------------
let driverGetCalls = 0;
function makeCtx(edgeCacheEnabled) {
  const waited = [];
  const ctx = {
    codec: { decodeEntityID: (h) => (h === 'e1' ? 101 : null) },
    entities: {
      byId: async (id) =>
        id === 101
          ? { id: 101, storage_policy_entities: 5, size: 1234, source: 'obj/key.bin' }
          : null,
    },
    policies: {
      byId: async (id) => ({ id: 5, type: 's3', settings: { edge_cache: edgeCacheEnabled } }),
    },
    driverFor: () => ({
      get: async (_source, range) => {
        driverGetCalls += 1;
        const bodyText = range ? 'RANGE' : 'FULLBODY';
        return {
          body: new Blob([bodyText]).stream(),
          size: bodyText.length,
          contentType: 'application/octet-stream',
          contentRange: range ? 'bytes 0-5/8' : undefined,
        };
      },
    }),
    waitUntil: (p) => waited.push(p),
  };
  return { ctx, waited };
}

function makeService(ctx) {
  // DownloadService 构造只保存引用，fs 参数不会被 serveEntity 用到
  return new DownloadService(ctx, {});
}

// ---------------------------------------------------------------------------
// T5 serveEntity：开关开 → 回源写缓存 → 第二次命中
// ---------------------------------------------------------------------------
{
  driverGetCalls = 0;
  const putBefore = putCalls;
  const { ctx, waited } = makeCtx(true);
  const svc = makeService(ctx);
  const scope = { origin: 'https://x.test', waitUntil: ctx.waitUntil };

  const first = await svc.serveEntity('e1', 'a.bin', null, scope);
  assert.equal(driverGetCalls, 1, 'T5 首次回源');
  assert.equal(first.size, 8, 'T5 返回完整内容尺寸');

  await drain(waited);
  assert.equal(putCalls - putBefore, 1, 'T5 回源后写入缓存');
  assert.ok(
    cacheStore.has('https://x.test/__edge_cache__/content/e1/a.bin'),
    'T5 缓存键按实体 + 文件名规范化',
  );

  const second = await svc.serveEntity('e1', 'a.bin', null, scope);
  assert.equal(driverGetCalls, 1, 'T5 第二次命中缓存，不再回源');
  assert.equal(second.size, 8, 'T5 缓存命中的尺寸来自 Content-Length');
  assert.equal(second.contentType, 'application/octet-stream');
  const text = await new Response(second.body).text();
  assert.equal(text, 'FULLBODY', 'T5 缓存命中的 body 完整');
}

// ---------------------------------------------------------------------------
// T6 Range 请求不参与缓存
// ---------------------------------------------------------------------------
{
  driverGetCalls = 0;
  const { ctx, waited } = makeCtx(true);
  const svc = makeService(ctx);
  const scope = { origin: 'https://x.test', waitUntil: ctx.waitUntil };
  const before = putCalls;
  const part = await svc.serveEntity('e1', 'a.bin', 'bytes=0-5', scope);
  assert.equal(driverGetCalls, 1, 'T6 Range 直接回源');
  assert.ok(part.contentRange, 'T6 Range 响应带 contentRange');
  await drain(waited);
  assert.equal(putCalls, before, 'T6 Range 不写缓存');
}

// ---------------------------------------------------------------------------
// T7 策略未开 edge_cache → 不读不写
// ---------------------------------------------------------------------------
{
  driverGetCalls = 0;
  const putBefore = putCalls;
  const { ctx, waited } = makeCtx(false);
  const svc = makeService(ctx);
  const scope = { origin: 'https://x.test', waitUntil: ctx.waitUntil };
  const content = await svc.serveEntity('e1', 'a.bin', null, scope);
  assert.equal(driverGetCalls, 1, 'T7 未开开关直接回源');
  await drain(waited);
  assert.equal(putCalls - putBefore, 0, 'T7 未开开关不写缓存');
  assert.ok(content.size > 0);
}

// ---------------------------------------------------------------------------
console.log('edge cache: all assertions passed');
console.log(JSON.stringify({ cacheEntries: cacheStore.size, putCalls, driverGetCalls }, null, 2));

try {
  rmSync(tmp, { recursive: true, force: true });
} catch {}
