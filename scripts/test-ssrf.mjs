/**
 * SSRF 防护的单元测试。
 *
 * 重点覆盖 **CVE-2026-79913**（Cloudreve 4.18.0 修的）：把内网 IPv4 塞进
 * IPv6 过渡封装里，`IsPrivate` / 我们的等价判断会把它当公网地址放过。
 *
 * 跑法：`npm run test:ssrf`
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'ssrftest');
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

try {
  const bundlePath = path.join(outDir, 'ssrf.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/ssrf.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { assertSafeRemoteUrl, effectiveIp, safeFetch } = await import(`file://${bundlePath}`);

  const allowed = (url) => {
    try {
      assertSafeRemoteUrl(url);
      return true;
    } catch {
      return false;
    }
  };

  console.log('\n[1] 正常公网 URL 必须放行');
  for (const u of [
    'https://example.com/file.zip',
    'http://example.com/a/b?c=d',
    'https://cdn.example.co.uk/x.iso',
    'http://1.1.1.1/x',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/x',
    'https://abc.de/x',
    'https://my-host.example.com:8443/x',
  ]) {
    check(u, allowed(u));
  }

  console.log('\n[2] IPv4 私网 / 回环 / 链路本地');
  for (const u of [
    'http://127.0.0.1/',
    'http://127.1.2.3/',
    'http://0.0.0.0/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
  ]) {
    check(u, !allowed(u));
  }

  console.log('\n[3] 主机名形式的本地目标');
  for (const u of [
    'http://localhost/',
    'http://localhost:8080/x',
    'http://foo.localhost/',
    'http://metadata.google.internal/',
    'http://router.local/',
    'http://svc.internal/',
    'http://localhost./x',
    'http://2130706433/', // 127.0.0.1 的十进制写法
    'http://0x7f000001/',
    'http://0177.0.0.1/',
  ]) {
    check(u, !allowed(u));
  }

  console.log('\n[4] IPv6 自身的内网段');
  for (const u of ['http://[::1]/', 'http://[::]/', 'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[ff02::1]/']) {
    check(u, !allowed(u));
  }

  console.log('\n[5] CVE-2026-79913：IPv4 藏在 IPv6 里');
  const wrappers = [
    ['http://[::ffff:127.0.0.1]/', '::ffff:127.0.0.1'],
    ['http://[::ffff:169.254.169.254]/', '::ffff:169.254.169.254'],
    ['http://[64:ff9b::7f00:1]/', 'NAT64 → 127.0.0.1'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'NAT64 → 169.254.169.254'],
    ['http://[64:ff9b::a00:1]/', 'NAT64 → 10.0.0.1'],
    ['http://[::7f00:1]/', 'IPv4-compatible → 127.0.0.1'],
    ['http://[2002:7f00:1::]/', '6to4 → 127.0.0.1'],
    ['http://[2002:a9fe:a9fe::]/', '6to4 → 169.254.169.254'],
    ['http://[2002:ac10:1::]/', '6to4 → 172.16.0.1'],
    ['http://[2001:0:0:0:0:0:80ff:fffe]/', 'Teredo → 127.0.0.1'],
  ];
  for (const [u, why] of wrappers) check(`${u}（${why}）`, !allowed(u));

  console.log('\n[6] effectiveIp 拆封装');
  check('::ffff:127.0.0.1', effectiveIp('::ffff:127.0.0.1') === '127.0.0.1');
  check('::ffff:7f00:1', effectiveIp('::ffff:7f00:1') === '127.0.0.1');
  check('64:ff9b::a9fe:a9fe', effectiveIp('64:ff9b::a9fe:a9fe') === '169.254.169.254');
  check('2002:7f00:1::', effectiveIp('2002:7f00:1::') === '127.0.0.1');
  check('::7f00:1', effectiveIp('::7f00:1') === '127.0.0.1');
  check('::1 保持原样', effectiveIp('::1') === '::1');
  check('公网 IPv6 保持原样', effectiveIp('2606:4700::1111') === '2606:4700::1111');
  check('IPv4 保持原样', effectiveIp('1.2.3.4') === '1.2.3.4');

  console.log('\n[7] 协议与形态');
  for (const u of [
    'ftp://example.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'gopher://example.com/',
    'https://user:pass@example.com/x',
    'not a url',
  ]) {
    check(u, !allowed(u));
  }

  console.log('\n[7] safeFetch：重定向的每一跳都要重新校验');
  {
    const realFetch = globalThis.fetch;
    const stub = (handler) => {
      globalThis.fetch = async (url, init) => handler(String(url), init);
      return () => {
        globalThis.fetch = realFetch;
      };
    };

    // 302 到云元数据地址：必须拒绝，而不是把内网内容抓回来
    let restore = stub((url) =>
      url.includes('evil.example.com')
        ? new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } })
        : new Response('ok', { status: 200 }),
    );
    let blocked = false;
    try {
      await safeFetch('https://evil.example.com/x');
    } catch (e) {
      blocked = e?.name === 'UnsafeRemoteUrlError';
    }
    restore();
    check('302 到 169.254.169.254 被拦下', blocked);

    // 相对 Location + 一路公网：应当跟随并返回最终响应
    restore = stub((url, init) => {
      check(`跟随重定向时用 manual 模式（${url.slice(0, 32)}）`, init?.redirect === 'manual');
      if (url.endsWith('/a')) {
        return new Response(null, { status: 302, headers: { Location: '/b' } });
      }
      return new Response('final', { status: 200 });
    });
    let body = '';
    try {
      body = await (await safeFetch('https://example.com/a')).text();
    } catch (e) {
      body = `throw:${e?.message}`;
    }
    restore();
    check('相对重定向正常跟随', body === 'final', body);

    // 无限重定向必须中止
    restore = stub(
      () => new Response(null, { status: 302, headers: { Location: 'https://example.com/loop' } }),
    );
    blocked = false;
    try {
      await safeFetch('https://example.com/loop');
    } catch (e) {
      blocked = e?.name === 'UnsafeRemoteUrlError';
    }
    restore();
    check('超过跳数上限时中止', blocked);

    // 初始地址就不合规时压根不该发出请求
    let called = false;
    restore = stub(() => {
      called = true;
      return new Response('ok');
    });
    blocked = false;
    try {
      await safeFetch('http://127.0.0.1/x');
    } catch (e) {
      blocked = e?.name === 'UnsafeRemoteUrlError';
    }
    restore();
    check('初始地址非法时不发请求', blocked && !called);
  }

  console.log(
    `\n${failed === 0 ? '全部通过' : `${failed} 项不通过`}（${passed} 项通过，${failed} 项失败）`,
  );  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('测试异常：', err);
  process.exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
