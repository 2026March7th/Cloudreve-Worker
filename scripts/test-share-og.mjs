#!/usr/bin/env node
/**
 * OG 分享预览的单元测试（对应上游 PR #3234）。
 *
 * 纯函数部分（`src/lib/shareOg.ts`）打包后直接测：爬虫识别、分享参数提取、
 * HTML 转义、体积格式化、页面渲染。中间件要读库，不在这一层覆盖。
 *
 * 跑法：node scripts/test-share-og.mjs
 */
import { build } from 'esbuild';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-og-'));
  const bundlePath = path.join(outDir, 'shareOg.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/shareOg.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { isSocialBot, extractShare, escapeHtml, formatSize, absoluteUrl, renderOgPage } = await import(
    `file://${bundlePath}`
  );

  console.log('[爬虫识别]');
  check('facebook 爬虫', isSocialBot('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'));
  check('Twitterbot', isSocialBot('Twitterbot/1.0'));
  check('Discordbot', isSocialBot('Mozilla/5.0 (compatible; Discordbot/2.0)'));
  check('TelegramBot（大小写不敏感）', isSocialBot('TelegramBot (like TwitterBot)'));
  check('Slackbot', isSocialBot('Slackbot-LinkExpanding 1.0'));
  check('WhatsApp', isSocialBot('WhatsApp/2.0'));
  check('普通 Chrome 不算', isSocialBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141 Safari/537.36') === false);
  check('空 UA 不算', isSocialBot(undefined) === false);
  check('空串不算', isSocialBot('') === false);

  console.log('\n[分享参数提取]');
  const q = (obj) => (name) => obj[name];
  eq('短链 /s/xxx', extractShare('/s/m5fM', q({})), { id: 'm5fM', password: '' });
  eq('短链带密码', extractShare('/s/m5fM/pwd123', q({})), { id: 'm5fM', password: 'pwd123' });
  eq('空 id', extractShare('/s/', q({})), null);
  eq('非分享路径', extractShare('/admin/user', q({})), null);
  eq(
    '长链 /home?path=',
    extractShare('/home', q({ path: 'cloudreve://m5fM@share' })),
    { id: 'm5fM', password: '' },
  );
  eq(
    '长链带密码',
    extractShare('/home', q({ path: 'cloudreve://m5fM:pwd@share/sub/dir' })),
    { id: 'm5fM', password: 'pwd' },
  );
  eq(
    '长链但路径不是分享',
    extractShare('/home', q({ path: 'cloudreve://my/下载' })),
    null,
  );
  eq('长链无 path 参数', extractShare('/home', q({})), null);

  console.log('\n[格式化与转义]');
  eq('字节', formatSize(0), '0 B');
  eq('KB', formatSize(2048), '2.00 KB');
  eq('MB', formatSize(5 * 1024 * 1024), '5.00 MB');
  eq('GB', formatSize(3.5 * 1024 * 1024 * 1024), '3.50 GB');
  eq('TB', formatSize(2 * 1024 * 1024 * 1024 * 1024), '2.00 TB');
  eq('转义引号', escapeHtml('a"b\'c'), 'a&quot;b&#39;c');
  eq('转义标签', escapeHtml('<script>'), '&lt;script&gt;');
  eq('转义 &', escapeHtml('a&b'), 'a&amp;b');
  eq('绝对地址补全', absoluteUrl('https://pan.example.com/', '/static/img/logo192.png'), 'https://pan.example.com/static/img/logo192.png');
  eq('绝对地址带协议的原样返回', absoluteUrl('https://a.com', 'https://b.com/x.png'), 'https://b.com/x.png');
  eq('去掉站点地址尾部斜杠', absoluteUrl('https://a.com//', 'x.png'), 'https://a.com/x.png');

  console.log('\n[页面渲染]');
  const page = renderOgPage({
    siteName: 'Cloudreve',
    title: '报告 v2.pdf',
    description: '1.50 MB · 阿砚',
    image: 'https://pan.example.com/static/img/logo192.png',
    shareUrl: 'https://pan.example.com/s/m5fM',
    redirectUrl: 'https://pan.example.com/home?path=cloudreve%3A%2F%2Fm5fM%40share',
  });
  const must = [
    'og:title" content="报告 v2.pdf"',
    'og:description" content="1.50 MB · 阿砚"',
    'og:image" content="https://pan.example.com/static/img/logo192.png"',
    'og:url" content="https://pan.example.com/s/m5fM"',
    'og:site_name" content="Cloudreve"',
    'twitter:card" content="summary"',
    'window.location.href = "https://pan.example.com/home?path=cloudreve%3A%2F%2Fm5fM%40share"',
    '<noscript>',
  ];
  for (const m of must) check(`包含 ${m.slice(0, 34)}…`, page.includes(m));
  check('Content-Type 之外没有把用户输入裸插进属性', !page.includes('content="报告 v2.pdf" onload'));

  // XSS：分享名里带引号/脚本时必须被转义
  const evil = renderOgPage({
    siteName: 'S',
    title: '"><script>alert(1)</script>',
    description: 'd',
    image: 'i',
    shareUrl: 'u',
    redirectUrl: 'r',
  });
  check('分享名被转义（不出现裸 script 标签）', !evil.includes('<script>alert(1)'));
  check('引号被转义', evil.includes('&quot;&gt;&lt;script&gt;'));

  await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${passed} 项通过，${failures.length} 项失败`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

function eq(name, actual, expected) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
