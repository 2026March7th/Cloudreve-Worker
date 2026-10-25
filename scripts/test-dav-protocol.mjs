/**
 * WebDAV **协议层**端到端测试：真的把 `davRoutes` 挂进一个 Hono app，然后
 * 用真实 HTTP 形状的请求打它，断言状态码 / XML / 响应头。
 *
 * 为什么需要它：MT管理器、Alist、OpenList、Windows 全都「连不上」，但那些
 * 问题全在协议细节上（`/dav` 的路由、`<D:href>` 形状、缺 Content-Length、
 * 覆盖已有文件的状态码）。这些不依赖数据库就能验，而真库在新加坡、跑一次
 * 端到端既慢又没凭据。
 *
 * 文件系统与上下文通过 esbuild 的模块替换换成内存实现
 * （`scripts/fixtures/dav-*.ts`），生产构建完全不受影响。
 *
 * 跑法：`npm run test:dav-protocol`
 */
import { Hono } from 'hono';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 产物必须放在项目内（node_modules/.cache 下）：bundle 里 `hono` 是 external，
// 放到系统临时目录时 Node 从那里向上找不到 node_modules。
const outDir = path.join(ROOT, 'node_modules', '.cache', 'davproto');
mkdirSync(outDir, { recursive: true });
void mkdtempSync;
void path;

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `实际 ${JSON.stringify(actual)} 期望 ${JSON.stringify(expected)}`);
}

const AUTH = `Basic ${Buffer.from('davuser:davpass').toString('base64')}`;
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/><D:displayname/><D:getetag/></D:prop></D:propfind>`;

const LOCK_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>dav@example.com</D:href></D:owner></D:lockinfo>`;

let bundle;

try {
  const entry = path.join(outDir, 'dav-bundle.mjs');
  const stub = {
    '../services/fs': path.join(ROOT, 'scripts/fixtures/dav-store.ts'),
    '../services/upload': path.join(ROOT, 'scripts/fixtures/dav-store.ts'),
    '../services/context': path.join(ROOT, 'scripts/fixtures/dav-ctx.ts'),
    '../services/audit': path.join(ROOT, 'scripts/fixtures/dav-audit.ts'),
    '../lib/kvRouter': path.join(ROOT, 'scripts/fixtures/dav-kv.ts'),
    '../middleware/app': path.join(ROOT, 'scripts/fixtures/dav-ctx.ts'),
  };
  await build({
    entryPoints: [path.join(ROOT, 'scripts/fixtures/dav-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: entry,
    logLevel: 'silent',
    plugins: [
      {
        name: 'dav-test-stubs',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            const hit = stub[args.path];
            return hit ? { path: hit } : null;
          });
        },
      },
    ],
    external: ['hono'],
  });

  bundle = await import(`file://${entry}`);
} catch (err) {
  console.error('打包失败：', err);
  rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

const { davRoutes, FakeAppContext, resetStore, resetKv, seedFile, seedFolder, contentOf, allPaths } =
  bundle;

/** 每次重置后装配一个 app；opts 用来切「账号无效 / 无 WebDAV 权限」。 */
function makeApp(opts = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('ctx', new FakeAppContext({}, {}, {}, {}, null, opts));
    await next();
  });
  app.route('/dav', davRoutes);
  return app;
}

async function req(app, method, urlPath, { headers = {}, body } = {}) {
  const init = { method, headers: { Authorization: AUTH, ...headers } };
  if (body !== undefined) init.body = body;
  const res = await app.request(`https://dav.test${urlPath}`, init);
  const text = await res.text();
  return { res, text, status: res.status };
}

try {
  // -------------------------------------------------------------------------
  console.log('\n[1] OPTIONS / 认证');
  resetStore();
  resetKv();
  let app = makeApp();

  {
    const r = await app.request('https://dav.test/dav', { method: 'OPTIONS' });
    eq('OPTIONS /dav（裸路径）→ 200', r.status, 200);
    eq('DAV 头', r.headers.get('dav'), '1, 2');
    eq('MS-Author-Via', r.headers.get('ms-author-via'), 'DAV');
    check(
      'Allow 里有 PROPFIND / LOCK / UNLOCK',
      ['PROPFIND', 'LOCK', 'UNLOCK', 'MKCOL', 'MOVE'].every((m) =>
        (r.headers.get('allow') ?? '').includes(m),
      ),
      r.headers.get('allow') ?? '',
    );
  }
  {
    const r = await app.request('https://dav.test/dav/', { method: 'OPTIONS' });
    eq('OPTIONS /dav/（带斜杠）→ 200', r.status, 200);
  }
  {
    const r = await app.request('https://dav.test/dav', { method: 'PROPFIND' });
    eq('无凭据 PROPFIND → 401', r.status, 401);
    check('401 必带 WWW-Authenticate', (r.headers.get('www-authenticate') ?? '').startsWith('Basic'));
  }
  {
    const bad = `Basic ${Buffer.from('davuser:wrong').toString('base64')}`;
    const r = await app.request('https://dav.test/dav', {
      method: 'PROPFIND',
      headers: { Authorization: bad },
    });
    eq('错密码 → 401', r.status, 401);
  }
  {
    const noPerm = makeApp({ davPermission: false });
    const r = await noPerm.request('https://dav.test/dav', {
      method: 'PROPFIND',
      headers: { Authorization: AUTH },
    });
    eq('组未开 WebDAV 权限 → 403', r.status, 403);
  }

  // -------------------------------------------------------------------------
  console.log('\n[2] PROPFIND');
  resetStore();
  resetKv();
  app = makeApp();
  seedFolder('/docs');
  seedFile('/readme.txt', 'hello');
  seedFile('/docs/a b.txt', 'x');

  {
    const { status, text, res } = await req(app, 'PROPFIND', '/dav', {
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: PROPFIND_BODY,
    });
    eq('Depth 0 根目录 → 207', status, 207);
    check('Content-Type 是 xml', (res.headers.get('content-type') ?? '').includes('xml'));
    check('带显式 Content-Length', Number(res.headers.get('content-length')) > 0);
    check('根 href 是 /dav/（带斜杠）', text.includes('<D:href>/dav/</D:href>'), text.slice(0, 200));
    check('根是 collection', text.includes('<D:resourcetype><D:collection/></D:resourcetype>'));
    check('多状态根元素带 DAV: 命名空间', text.includes('xmlns:D="DAV:"'));
    check('每个 propstat 带 status', text.includes('<D:status>HTTP/1.1 200 OK</D:status>'));
    check('声明 supportedlock', text.includes('<D:supportedlock>'));
    check('带 lockdiscovery', text.includes('<D:lockdiscovery'));
  }
  {
    const { status, text } = await req(app, 'PROPFIND', '/dav', {
      headers: { Depth: '1' },
      body: PROPFIND_BODY,
    });
    eq('Depth 1 → 207', status, 207);
    check('列出 readme.txt', text.includes('/dav/readme.txt'), '');
    check('列目录 docs 带尾斜杠', text.includes('<D:href>/dav/docs/</D:href>'));
    check('文件带 getcontentlength', text.includes('<D:getcontentlength>5</D:getcontentlength>'));
    check('文件带 getetag', /<D:getetag>"5-\d+"<\/D:getetag>/.test(text));
    check('文件带 getcontenttype', text.includes('<D:getcontenttype>'));
  }
  {
    const { text } = await req(app, 'PROPFIND', '/dav/docs/a%20b.txt', {
      headers: { Depth: '0' },
    });
    check('空格文件名 href 编码正确', text.includes('/dav/docs/a%20b.txt'), text.slice(0, 300));
  }
  {
    const { status } = await req(app, 'PROPFIND', '/dav/nope.txt', { headers: { Depth: '0' } });
    eq('不存在的路径 → 404', status, 404);
  }
  {
    const { status } = await req(app, 'PROPFIND', '/dav/%zz', { headers: { Depth: '0' } });
    check('畸形百分号编码不 500', status === 400 || status === 404, `实际 ${status}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n[3] GET / HEAD');
  {
    const { status, text, res } = await req(app, 'GET', '/dav/readme.txt');
    eq('GET 文件 → 200', status, 200);
    eq('内容正确', text, 'hello');
    check('带 ETag', (res.headers.get('etag') ?? '').length > 0);
    eq('Accept-Ranges', res.headers.get('accept-ranges'), 'bytes');
    check('带 Last-Modified', (res.headers.get('last-modified') ?? '').length > 0);
  }
  {
    const { status, res, text } = await req(app, 'GET', '/dav/readme.txt', {
      headers: { Range: 'bytes=0-1' },
    });
    eq('Range → 206', status, 206);
    eq('Range 内容', text, 'he');
    eq('Content-Range', res.headers.get('content-range'), 'bytes 0-1/5');
  }
  {
    const { status, res } = await req(app, 'HEAD', '/dav/readme.txt');
    eq('HEAD 文件 → 200', status, 200);
    eq('HEAD 带 Content-Length', res.headers.get('content-length'), '5');
  }
  {
    const { status, text } = await req(app, 'GET', '/dav');
    eq('GET 目录 → 200', status, 200);
    check('目录 HTML 链接是 /dav 路径', text.includes('/dav/readme.txt'), text.slice(0, 300));
    check('不出现 cloudreve:// 死链', !text.includes('cloudreve://'));
    check('目录链接带尾斜杠', text.includes('/dav/docs/'));
  }
  {
    const { status, res } = await req(app, 'HEAD', '/dav');
    eq('HEAD 目录 → 200', status, 200);
    eq('HEAD 目录 Content-Length 0', res.headers.get('content-length'), '0');
  }

  // -------------------------------------------------------------------------
  console.log('\n[4] PUT');
  {
    const { status } = await req(app, 'PUT', '/dav/new.txt', {
      headers: { 'Content-Length': '3' },
      body: 'abc',
    });
    eq('PUT 新文件 → 201', status, 201);
    eq('落到存储', Buffer.from(contentOf('/new.txt') ?? []).toString(), 'abc');
  }
  {
    const { status } = await req(app, 'PUT', '/dav/new.txt', {
      headers: { 'Content-Length': '5' },
      body: 'hello',
    });
    eq('PUT 覆盖已有文件 → 204（不是 405）', status, 204);
    eq('覆盖后内容更新', Buffer.from(contentOf('/new.txt') ?? []).toString(), 'hello');
  }
  {
    const { status } = await req(app, 'PUT', '/dav/chunked.txt', { body: 'abc' });
    eq('缺 Content-Length → 411（不能假装成功写 0 字节）', status, 411);
    check('没有生成空文件', contentOf('/chunked.txt') === null);
  }
  {
    const { status } = await req(app, 'PUT', '/dav/docs', {
      headers: { 'Content-Length': '1' },
      body: 'x',
    });
    eq('PUT 到目录 → 405', status, 405);
  }

  // -------------------------------------------------------------------------
  console.log('\n[5] MKCOL / DELETE');
  {
    const { status } = await req(app, 'MKCOL', '/dav/新目录');
    eq('MKCOL → 201', status, 201);
    const again = await req(app, 'MKCOL', '/dav/新目录');
    eq('MKCOL 已存在 → 405', again.status, 405);
  }
  {
    const { status } = await req(app, 'MKCOL', '/dav/no-parent/child');
    eq('MKCOL 父目录不存在 → 409', status, 409);
  }
  {
    const del = await req(app, 'DELETE', '/dav/new.txt');
    eq('DELETE 文件 → 204', del.status, 204);
    const again = await req(app, 'DELETE', '/dav/new.txt');
    eq('DELETE 不存在 → 404', again.status, 404);
  }
  {
    const del = await req(app, 'DELETE', '/dav');
    eq('DELETE 根 → 403', del.status, 403);
  }

  // -------------------------------------------------------------------------
  console.log('\n[6] COPY / MOVE');
  {
    const r = await req(app, 'COPY', '/dav/readme.txt', {
      headers: { Destination: 'https://dav.test/dav/readme-copy.txt' },
    });
    eq('COPY 到新名字 → 201', r.status, 201);
    eq('副本内容一致', Buffer.from(contentOf('/readme-copy.txt') ?? []).toString(), 'hello');
  }
  {
    const r = await req(app, 'COPY', '/dav/readme.txt', {
      headers: { Destination: 'https://evil.test/dav/x.txt' },
    });
    eq('Destination 指向别的主机 → 502', r.status, 502);
  }
  {
    const r = await req(app, 'MOVE', '/dav/readme-copy.txt', {
      headers: { Destination: 'https://dav.test/dav/renamed.txt' },
    });
    eq('MOVE 改名 → 201', r.status, 201);
    check('原路径已不存在', contentOf('/readme-copy.txt') === null);
    eq('新路径有内容', Buffer.from(contentOf('/renamed.txt') ?? []).toString(), 'hello');
  }
  {
    const r = await req(app, 'COPY', '/dav/renamed.txt', {
      headers: { Destination: 'https://dav.test/dav/renamed.txt', Overwrite: 'F' },
    });
    check('Overwrite: F 且目标存在 → 412', r.status === 412, `实际 ${r.status}`);
  }
  {
    const r = await req(app, 'COPY', '/dav/renamed.txt', {
      headers: { Destination: 'https://dav.test/dav/renamed.txt', Overwrite: 'X' },
    });
    eq('Overwrite 非法值 → 400', r.status, 400);
  }

  // -------------------------------------------------------------------------
  console.log('\n[7] LOCK / UNLOCK / 423');
  resetStore();
  resetKv();
  app = makeApp();
  seedFile('/locked.txt', 'v1');

  let lockToken = null;
  {
    const { status, res, text } = await req(app, 'LOCK', '/dav/locked.txt', {
      headers: { Depth: '0', Timeout: 'Second-600', 'Content-Type': 'application/xml' },
      body: LOCK_BODY,
    });
    check('LOCK 已存在资源 → 200/201', status === 200 || status === 201, `实际 ${status}`);
    const header = res.headers.get('lock-token') ?? '';
    const m = /opaquelocktoken:([^>]+)/.exec(header);
    lockToken = m ? m[1] : null;
    check('返回 Lock-Token 头', lockToken !== null, header);
    check('响应体有 activelock', text.includes('<D:activelock>'), text.slice(0, 200));
    check('响应体有 lockroot', text.includes('<D:lockroot>'));
  }
  {
    const r = await req(app, 'PUT', '/dav/locked.txt', {
      headers: { 'Content-Length': '2' },
      body: 'v2',
    });
    eq('被锁文件无 If 头写入 → 423', r.status, 423);
  }
  {
    const r = await req(app, 'PUT', '/dav/locked.txt', {
      headers: { 'Content-Length': '2', If: `(<opaquelocktoken:${lockToken}>)` },
      body: 'v2',
    });
    eq('带正确 token 写入 → 204', r.status, 204);
  }
  {
    const r = await req(app, 'PROPFIND', '/dav/locked.txt', { headers: { Depth: '0' } });
    check('PROPFIND 能看到活动锁', r.text.includes(lockToken), r.text.slice(0, 300));
  }
  {
    const r = await req(app, 'UNLOCK', '/dav/locked.txt', {
      headers: { 'Lock-Token': `<opaquelocktoken:${lockToken}>` },
    });
    eq('UNLOCK → 204', r.status, 204);
    const after = await req(app, 'PUT', '/dav/locked.txt', {
      headers: { 'Content-Length': '3' },
      body: 'v3!',
    });
    eq('解锁后写入不再 423', after.status, 204);
  }
  {
    // 锁一个不存在的 URL：RFC 4918 §7.3 → 先创建空资源，回 201
    const r = await req(app, 'LOCK', '/dav/brand-new.txt', {
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: LOCK_BODY,
    });
    eq('LOCK 不存在的资源 → 201', r.status, 201);
  }

  // -------------------------------------------------------------------------
  console.log('\n[8] 路径穿越');
  resetStore();
  resetKv();
  {
    // 账号根限定在 /scoped，任何跑出去的路径都必须拒绝
    const scoped = new Hono();
    scoped.use('*', async (c, next) => {
      c.set('ctx', new FakeAppContext({}, {}, {}, {}, null, {}));
      // 覆盖账号 URI 到子目录
      c.get('ctx').davAccounts.byNameAndPassword = async () => ({
        account: { name: 'davuser', password: 'davpass', uri: 'cloudreve://my/scoped', owner_id: 1, options: new Uint8Array(8) },
      });
      await next();
    });
    scoped.route('/dav', davRoutes);
    seedFolder('/scoped');
    seedFile('/secret.txt', 'top secret');
    const r = await scoped.request('https://dav.test/dav/..%2Fsecret.txt', {
      method: 'PROPFIND',
      headers: { Authorization: AUTH, Depth: '0' },
    });
    check('..%2F 穿越到账号根外 → 拒绝', r.status === 403 || r.status === 404, `实际 ${r.status}`);
    check('没有泄漏外层文件', !(await r.text()).includes('top secret'));
  }

  // -------------------------------------------------------------------------
  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项不通过`}（${passed} 项通过，${failed} 项失败）`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\n测试执行异常：', err);
  process.exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
