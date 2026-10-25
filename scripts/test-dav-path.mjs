/**
 * WebDAV 路径与 href 的单测。
 *
 * 这两块决定「客户端能不能连上」：Windows WebClient 会把 `<D:href>` 与请求
 * URL 逐字节比对，差一个字就是「找不到网络路径」；而路径解析同时是越权边界
 * （`..` 穿越）。
 *
 * 跑法：`npm run test:dav`
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(os.tmpdir(), 'davpath-'));

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}\n        实际 ${JSON.stringify(actual)}\n        期望 ${JSON.stringify(expected)}`);
  }
}

try {
  const bundlePath = path.join(outDir, 'davPath.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/davPath.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });

  const { resolveDavTarget, davHref, encodeDavPath, safeDecode } = await import(
    `file://${bundlePath}`
  );

  console.log('\n[1] resolveDavTarget —— 正常路径');
  check('/dav → 根', resolveDavTarget('cloudreve://my', '/dav')?.path, '/');
  check('/dav/ → 根', resolveDavTarget('cloudreve://my', '/dav/')?.path, '/');
  check('/dav/a/b', resolveDavTarget('cloudreve://my', '/dav/a/b')?.path, '/a/b');
  check('/dav/a/ 去尾斜杠', resolveDavTarget('cloudreve://my', '/dav/a/')?.path, '/a');
  check('中文解码', resolveDavTarget('cloudreve://my', '/dav/%E4%B8%AD%E6%96%87')?.path, '/中文');
  check('空格解码', resolveDavTarget('cloudreve://my', '/dav/a%20b')?.path, '/a b');
  check('加号不进路径（不当空格）', resolveDavTarget('cloudreve://my', '/dav/a+b')?.path, '/a+b');
  check('重复斜杠折叠', resolveDavTarget('cloudreve://my', '/dav//a///b')?.path, '/a/b');
  check('. 被丢弃', resolveDavTarget('cloudreve://my', '/dav/./a')?.path, '/a');

  console.log('\n[2] resolveDavTarget —— 拒绝的情况');
  check('畸形百分号 /dav/%zz', resolveDavTarget('cloudreve://my', '/dav/%zz'), null);
  check('截断的百分号 /dav/a%', resolveDavTarget('cloudreve://my', '/dav/a%'), null);
  check('不在 /dav 下', resolveDavTarget('cloudreve://my', '/api/v4/file'), null);
  check('分享空间不是 my', resolveDavTarget('cloudreve://m5fM@share', '/dav'), null);
  check('回收站不是 my', resolveDavTarget('cloudreve://trash', '/dav'), null);
  check('非法 URI', resolveDavTarget('not a uri', '/dav'), null);

  console.log('\n[3] resolveDavTarget —— 账号根目录下的穿越防护');
  // 账号限定在 my:///davroot 时，任何解析后跑出去的路径都必须拒绝
  check('账号根内正常访问', resolveDavTarget('cloudreve://my/davroot', '/dav/a')?.path, '/davroot/a');
  check('账号根自身', resolveDavTarget('cloudreve://my/davroot', '/dav')?.path, '/davroot');
  check('../ 跑出根 → 拒', resolveDavTarget('cloudreve://my/davroot', '/dav/..'), null);
  check('../secret 跑出根 → 拒', resolveDavTarget('cloudreve://my/davroot', '/dav/../secret'), null);
  check('编码的 %2e%2e 同样被规整后拒绝', resolveDavTarget('cloudreve://my/davroot', '/dav/%2e%2e/secret'), null);
  check('同名前缀不算在根内（/davrootX）', resolveDavTarget('cloudreve://my/davroot', '/dav/../davrootX'), null);
  check('子目录仍然可以', resolveDavTarget('cloudreve://my/davroot', '/dav/sub/../sub2')?.path, '/davroot/sub2');

  console.log('\n[4] davHref —— 目录必须带尾斜杠');
  check('根目录', davHref('/', true), '/dav/');
  // 根永远按集合处理（不存在「根是文件」），即便 isDir 传 false 也补尾斜杠：
  // 根目录回 `/dav` 会让 Windows 判「找不到网络路径」。
  check('根即使当文件也补尾斜杠', davHref('/', false), '/dav/');
  check('子目录', davHref('/docs', true), '/dav/docs/');
  check('已经带斜杠不重复加', davHref('/docs/', true), '/dav/docs/');
  check('文件不加斜杠', davHref('/docs/a.txt', false), '/dav/docs/a.txt');

  console.log('\n[5] davHref —— 编码');
  check('中文+空格', davHref('/中文 文件.txt', false), '/dav/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.txt');
  check('# 必须编码（否则被当片段）', davHref('/a#b', false), '/dav/a%23b');
  check('? 必须编码（否则被当 query）', davHref('/a?b', false), '/dav/a%3Fb');
  check('% 必须编码', davHref('/100%.txt', false), '/dav/100%25.txt');
  check('& 必须编码', davHref('/a&b', false), '/dav/a%26b');
  check('Unicode 目录 + 尾斜杠', davHref('/资料/图片', true), '/dav/%E8%B5%84%E6%96%99/%E5%9B%BE%E7%89%87/');

  console.log('\n[6] 工具函数');
  check('safeDecode 合法', safeDecode('a%20b'), 'a b');
  check('safeDecode 非法回 null', safeDecode('%zz'), null);
  check('encodeDavPath 根', encodeDavPath('/'), '/');
  check('encodeDavPath 多级', encodeDavPath('/a b/c'), '/a%20b/c');

  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项不通过`}（${passed} 项通过，${failed} 项失败）`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
