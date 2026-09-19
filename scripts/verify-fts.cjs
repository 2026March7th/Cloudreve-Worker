/**
 * 全文检索集成测试：
 *   1. 起一个本地 mock HTTP 服务，同时扮演 Meilisearch 与 Tika；
 *   2. 编译后的 MeilisearchIndexer / chunkText / shouldExtract 直接打这个服务；
 *   3. 校验 REST 路径、请求体结构、响应解析与高亮取值。
 *
 * 运行：先 tsc 编译 src/services/search.ts 到 _verify，再 node 本脚本。
 */
'use strict';

const http = require('node:http');
const assert = require('node:assert');
const {
  MeilisearchIndexer,
  chunkText,
  shouldExtract,
} = require('./services/search.js');

// ---------------------------------------------------------------------------
// mock 服务：记录每个请求，按 Meilisearch / Tika 的真实响应格式返回
// ---------------------------------------------------------------------------

const seen = []; // {method, path, body}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const DOCS_STORE = [];

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  seen.push({ method: req.method, path: req.url, body });
  const auth = req.headers.authorization;

  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // --- Tika ---
  if (req.method === 'PUT' && req.url === '/tika') {
    if (req.headers.accept !== 'text/plain') {
      return json(400, { error: 'expected Accept: text/plain' });
    }
    return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('extracted text\n');
  }

  // --- Meilisearch ---
  if (!auth || auth !== 'Bearer test-key') {
    return json(401, { message: 'missing or invalid API key' });
  }

  if (req.method === 'POST' && req.url === '/indexes') {
    return json(202, { taskUid: 0 });
  }
  if (req.url.startsWith('/indexes/cloudreve_files/settings/')) {
    return json(202, { taskUid: 1 });
  }
  if (req.method === 'POST' && req.url === '/indexes/cloudreve_files/documents') {
    const docs = JSON.parse(body);
    for (const d of docs) {
      const i = DOCS_STORE.findIndex((x) => x.id === d.id);
      if (i >= 0) DOCS_STORE[i] = d;
      else DOCS_STORE.push(d);
    }
    return json(202, { taskUid: 2 });
  }
  if (req.method === 'POST' && req.url === '/indexes/cloudreve_files/documents/delete') {
    const { filter } = JSON.parse(body);
    const m = filter.match(/file_id IN \[([0-9, ]+)\]/);
    if (!m) return json(400, { message: 'bad filter' });
    const ids = m[1].split(',').map((s) => Number(s.trim()));
    for (const id of ids) {
      for (let i = DOCS_STORE.length - 1; i >= 0; i--) {
        if (DOCS_STORE[i].file_id === id) DOCS_STORE.splice(i, 1);
      }
    }
    return json(202, { taskUid: 3 });
  }
  if (req.method === 'POST' && req.url === '/indexes/cloudreve_files/search') {
    const q = JSON.parse(body);
    // 模拟 distinct + _formatted 高亮
    const hits = [];
    const seenFiles = new Set();
    for (const d of DOCS_STORE) {
      if (!d.text.includes(q.q)) continue;
      if (q.filter && !d.owner_id.toString().match(new RegExp(`^${q.filter.match(/owner_id = (\d+)/)[1]}$`))) continue;
      if (seenFiles.has(d.file_id)) continue;
      seenFiles.add(d.file_id);
      hits.push({ ...d, _formatted: { text: `<em>${d.text}</em>` } });
      if (hits.length >= (q.limit ?? 20)) break;
    }
    return json(200, { hits, estimatedTotalHits: hits.length });
  }
  if (req.method === 'DELETE' && req.url === '/indexes/cloudreve_files/documents') {
    DOCS_STORE.length = 0;
    return json(202, { taskUid: 4 });
  }

  return json(404, { message: `unexpected ${req.method} ${req.url}` });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function lastCall(pathSuffix) {
  for (let i = seen.length - 1; i >= 0; i--) {
    if (seen[i].path.endsWith(pathSuffix)) return seen[i];
  }
  return null;
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // ---------- chunkText：与 Go 版 chunker.go 逐条对齐 ----------
  console.log('\n--- chunkText（对齐上游 chunker.go） ---');

  check('空文本 -> []', JSON.stringify(chunkText('', 100)) === '[]');
  check('纯空白 -> []', JSON.stringify(chunkText('  \n\n  ', 100)) === '[]');

  // 单段，不超限
  const single = chunkText('hello', 100);
  check('单短段原样返回', JSON.stringify(single) === JSON.stringify(['hello']));

  // 多段合并，段间 \n\n
  const merged = chunkText('aaa\n\nbbb', 100);
  check('短段合并', JSON.stringify(merged) === JSON.stringify(['aaa\n\nbbb']));

  // 合并后超限则分段：各 6 字节，限 13（14=6+2+6 恰好等于上限时仍合并，与 Go 一致）
  const mergedEdge = chunkText('aaaaaa\n\nbbbbbb', 14);
  check(
    '恰好等于上限时仍合并（Go 边界语义）',
    JSON.stringify(mergedEdge) === JSON.stringify(['aaaaaa\n\nbbbbbb']),
    JSON.stringify(mergedEdge),
  );
  const seg = chunkText('aaaaaa\n\nbbbbbb', 13);
  check('合并超限时分段', JSON.stringify(seg) === JSON.stringify(['aaaaaa', 'bbbbbb']), JSON.stringify(seg));

  // 超长单段按词边界切：'four five' 9 字节 > 8，只能各自成段
  const long = chunkText('one two three four five', 8);
  check(
    '超长段按词切分',
    JSON.stringify(long) === JSON.stringify(['one two', 'three', 'four', 'five']),
    JSON.stringify(long),
  );

  // UTF-8 字节语义（Go 的 len(string)）：中文每字 3 字节。
  // 若误用 JS 的 String.length（5）就不会分段；正确按字节算才分得开。
  const zh = chunkText('一二三四五\n\n六七八九十', 20);
  check(
    'UTF-8 字节语义',
    JSON.stringify(zh) === JSON.stringify(['一二三四五', '六七八九十']),
    JSON.stringify(zh),
  );

  // ---------- shouldExtract：对齐上游 ShouldExtractText ----------
  console.log('\n--- shouldExtract ---');
  const exts = ['txt', 'pdf'];
  check('扩展名命中且未超限', shouldExtract(exts, 100, 'a.txt', 50) === true);
  check('扩展名不命中', shouldExtract(exts, 100, 'a.png', 50) === false);
  check('超过体积上限', shouldExtract(exts, 100, 'a.pdf', 200) === false);
  check('白名单为空一律不抽', shouldExtract([], 100, 'a.txt', 50) === false);
  check('扩展名大小写不敏感', shouldExtract(exts, 100, 'A.TXT', 50) === true);

  // ---------- MeilisearchIndexer：REST 契约 ----------
  console.log('\n--- MeilisearchIndexer REST 契约 ---');
  const idx = new MeilisearchIndexer(base, 'test-key', 5, false, '{}');

  await idx.ensureIndex();
  check('建索引请求', !!lastCall('/indexes') && lastCall('/indexes').method === 'POST');
  const filterable = lastCall('/settings/filterable-attributes');
  check(
    'filterable-attributes 内容',
    filterable && JSON.stringify(JSON.parse(filterable.body)) === JSON.stringify(['owner_id', 'file_id', 'entity_id']),
    filterable && filterable.body,
  );
  const searchable = lastCall('/settings/searchable-attributes');
  check(
    'searchable-attributes 内容',
    searchable && JSON.stringify(JSON.parse(searchable.body)) === JSON.stringify(['text', 'file_name']),
  );
  const distinct = lastCall('/settings/distinct-attribute');
  check('distinct-attribute = file_id', distinct && JSON.parse(distinct.body) === 'file_id');
  const embedReset = lastCall('/settings/embedders');
  check(
    '未开 embedder 时下发 reset（对齐上游 ResetEmbedders）',
    !!embedReset && embedReset.method === 'PUT' && JSON.parse(embedReset.body) === null,
    embedReset && `${embedReset.method} ${embedReset.body}`,
  );

  await idx.indexFile({
    ownerId: 7,
    fileId: 42,
    entityId: 99,
    fileName: 'notes.txt',
    text: 'hello world this is a chunked document',
    chunkSize: 15,
  });
  const addDoc = lastCall('/documents');
  check('写文档请求方法 POST', addDoc && addDoc.method === 'POST');
  const docs = JSON.parse(addDoc.body);
  check('chunk 按 {fileID}_{idx} 作主键', docs.every((d, i) => d.id === `42_${i}`), JSON.stringify(docs.map((d) => d.id)));
  check(
    '文档字段齐全',
    docs.every((d) => d.file_id === 42 && d.owner_id === 7 && d.entity_id === 99 && d.file_name === 'notes.txt' && typeof d.text === 'string'),
  );

  await idx.search(7, 'hello', 0);
  const searchCall = lastCall('/search');
  const searchBody = JSON.parse(searchCall.body);
  check('search 请求带 filter', searchBody.filter === 'owner_id = 7', searchCall.body);
  check('search 带 limit/offset', searchBody.limit === 5 && searchBody.offset === 0);
  check(
    'search 高亮 text 字段',
    JSON.stringify(searchBody.attributesToHighlight) === JSON.stringify(['text']),
  );

  // store 里已有一批 chunk；用符合 filter 的 owner 再搜一次验证解析
  DOCS_STORE.length = 0;
  DOCS_STORE.push(
    { id: '42_0', file_id: 42, owner_id: 7, entity_id: 99, chunk_idx: 0, file_name: 'notes.txt', text: 'hello a' },
    { id: '42_1', file_id: 42, owner_id: 7, entity_id: 99, chunk_idx: 1, file_name: 'notes.txt', text: 'hello b' },
    { id: '43_0', file_id: 43, owner_id: 7, entity_id: 100, chunk_idx: 0, file_name: 'other.txt', text: 'hello c' },
    { id: '44_0', file_id: 44, owner_id: 8, entity_id: 101, chunk_idx: 0, file_name: 'forbidden.txt', text: 'hello d' },
  );
  const result = await idx.search(7, 'hello', 0);
  check('按 owner 过滤', result.hits.every((h) => h.ownerId === 7), JSON.stringify(result));
  check('按 file_id 去重（同文件两个 chunk 只出一个）', result.hits.filter((h) => h.fileId === 42).length === 1);
  check('高亮文本优先取 _formatted', result.hits[0].text.startsWith('<em>'), JSON.stringify(result.hits[0]));
  // file 42（2 chunks）去重后 1 条 + file 43 1 条 = 2，owner 8 的被过滤
  check('estimatedTotalHits 透传', result.total === 2, String(result.total));

  // embedder 开启时：搜索带 hybrid，ensureIndex 下发 embedders
  const idx2 = new MeilisearchIndexer(base, 'test-key', 5, true, '{"source":"openAI"}');
  await idx2.ensureIndex();
  const embedCall = lastCall('/settings/embedders');
  check('embedders 设置被下发', !!embedCall && embedCall.method === 'PATCH');
  const embedBody = JSON.parse(embedCall.body);
  check(
    'embedder 带 documentTemplate',
    embedBody['cr-text'] && typeof embedBody['cr-text'].documentTemplate === 'string' && embedBody['cr-text'].documentTemplate.includes('{{doc.chunk_idx}}'),
    JSON.stringify(embedBody),
  );
  await idx2.search(7, 'hello', 0);
  check('hybrid 参数随请求发出', 'hybrid' in JSON.parse(lastCall('/search').body));

  // 删除
  await idx.deleteByFileIds([42, 43]);
  const delCall = lastCall('/documents/delete');
  check('delete filter 格式', JSON.parse(delCall.body).filter === 'file_id IN [42, 43]', delCall.body);
  check('mock 里文档被删除', DOCS_STORE.every((d) => d.file_id !== 42 && d.file_id !== 43));

  // 错误传播：错误 key -> 401
  const badIdx = new MeilisearchIndexer(base, 'wrong', 5, false, '{}');
  let threw = false;
  try {
    await badIdx.ensureIndex();
  } catch {
    threw = true;
  }
  check('HTTP 错误会抛出（不静默）', threw);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
