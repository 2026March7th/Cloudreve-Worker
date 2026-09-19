// 逻辑自检：TOML 回填 / 输出解析。与 scripts/deploy.mjs 里的正则保持一致。
const KV_ID_PLACEHOLDER = 'REPLACE_WITH_YOUR_KV_NAMESPACE_ID';
const KV_PREVIEW_PLACEHOLDER = 'REPLACE_WITH_YOUR_KV_PREVIEW_ID';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}`);
  }
}

// 1) TOML 回填
let toml = 'id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"\npreview_id = "REPLACE_WITH_YOUR_KV_PREVIEW_ID"';
toml = toml
  .replace(new RegExp(`id\\s*=\\s*"${KV_ID_PLACEHOLDER}"`), 'id = "abc12345abc12345abc12345abc12345"')
  .replace(new RegExp(`preview_id\\s*=\\s*"${KV_PREVIEW_PLACEHOLDER}"`), 'preview_id = "abc12345abc12345abc12345abc12345"');
check('toml 回填后无占位符残留', !toml.includes('REPLACE_WITH_YOUR_KV'));
check('toml id 正确', toml.includes('id = "abc12345abc12345abc12345abc12345"'));

// 2) create 输出解析
const created = '...\n[[kv_namespaces]]\nbinding = "KV"\nid = "deadbeefdeadbeefdeadbeefdeadbeef"\n';
const m = created.match(/id\s*=\s*"([0-9a-f]{32})"/i);
check('create 输出解析', Boolean(m) && m[1] === 'deadbeefdeadbeefdeadbeefdeadbeef');

// 3) list JSON 解析：stdout 混入警告行也能定位数组（与 deploy.mjs 同一实现）
function extractJsonArray(text) {
  for (const m of text.matchAll(/^\[/gm)) {
    const start = m.index;
    const end = text.lastIndexOf(']');
    if (end <= start) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 换下一个行首 [ 继续 */
    }
  }
  return null;
}
const out = '[wrangler warn]\n[\n{"id":"ff01ff01ff01ff01ff01ff01ff01ff01","title":"cloudreve-worker-KV"}\n]';
const arr = extractJsonArray(out);
check('list 输出解析（混入警告行）', Array.isArray(arr) && arr.find((n) => n.title === 'cloudreve-worker-KV').id === 'ff01ff01ff01ff01ff01ff01ff01ff01');
check('纯 JSON 输入解析', Array.isArray(extractJsonArray('[\n{"id":"x","title":"t"}\n]')));
check('无数组输入返回 null', extractJsonArray('no json here') === null);
check('坏 JSON 返回 null 不抛错', extractJsonArray('[oops]') === null);

// 4) R2 already-exists 容错
check('R2 已存在容错', /already exists|10041/i.test('error: bucket already exists (10041)'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
