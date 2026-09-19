/**
 * 线上冒烟测试：验证核心接口「真的能调用、返回真的是信封」。
 *
 * 背景：387 处 `c.json(ok(...))` 双重包装把响应变成 `{}`，构建检查（dry-run）
 * 完全发现不了 —— 只有真打接口才能暴露。这个脚本就是那道保险。
 *
 * 用法：
 *   node scripts/smoke.mjs https://your-worker.example.com
 *   npm run smoke -- http://localhost:8787        （本地 wrangler dev）
 *
 * 覆盖面：
 *   - 匿名矩阵：ping / 站点配置各 section / 验证码 / manifest / 未知路由 / 直链 404
 *   - 完整链路（注册开启时）：注册 → 登录 → me → 建目录 → 列目录 → 重命名 → 删除 → 注销
 *
 * 断言原则：信封必须是 {code, msg} 且 code=0 时 data 存在；不内卷字段全集，
 * 但关键身份/令牌字段必须真实存在（防再次出现「200 + {}」这种假成功）。
 */
const BASE = (process.argv[2] || process.env.SMOKE_BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');

let pass = 0;
let failCount = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

async function req(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应（静态页 / 重定向）*/
  }
  return { status: res.status, json, headers: res.headers };
}

/** 信封健全性：能解析为 JSON、有 code、有 msg、code=0 时 data 不缺失。 */
function envelopeOk(name, r, { needData = true } = {}) {
  check(`${name}: 响应是标准信封`, r.json !== null && typeof r.json === 'object' && 'code' in r.json && 'msg' in r.json, `实际: ${JSON.stringify(r.json)?.slice(0, 120)}`);
  if (r.json?.code !== 0) return false;
  if (needData && r.json.data === undefined) {
    check(`${name}: code=0 时 data 存在`, false, `data 缺失: ${JSON.stringify(r.json).slice(0, 120)}`);
    return false;
  }
  return r.json.code === 0;
}

async function main() {
  console.log(`\n▶ 冒烟测试目标：${BASE}\n`);

  // ---------- 匿名矩阵 ----------
  console.log('—— 匿名接口 ——');

  const ping = await req('GET', '/api/v4/site/ping');
  check('ping: HTTP 200', ping.status === 200, `实际 ${ping.status}`);
  if (envelopeOk('ping', ping)) {
    check('ping: data 是版本号字符串', typeof ping.json.data === 'string' && ping.json.data.length > 0, JSON.stringify(ping.json.data));
  }

  const basic = await req('GET', '/api/v4/site/config/basic');
  if (envelopeOk('config/basic', basic)) {
    check('config/basic: data.title 存在', typeof basic.json.data.title === 'string' && basic.json.data.title.length > 0);
    check('config/basic: 匿名用户 anonymous=true', basic.json.data.user?.anonymous === true);
  }

  const loginCfg = await req('GET', '/api/v4/site/config/login');
  let registerEnabled = false;
  if (envelopeOk('config/login', loginCfg, { needData: false })) {
    registerEnabled = loginCfg.json.data?.register_enabled === true;
    check('config/login: register_enabled / authn 字段存在', 'register_enabled' in loginCfg.json.data && 'authn' in loginCfg.json.data);
  }

  envelopeOk('config/explorer', await req('GET', '/api/v4/site/config/explorer'), { needData: false });
  envelopeOk('config/app', await req('GET', '/api/v4/site/config/app'), { needData: false });

  const captcha = await req('GET', '/api/v4/site/captcha');
  if (envelopeOk('captcha', captcha)) {
    check('captcha: image 是 data URL', typeof captcha.json.data.image === 'string' && captcha.json.data.image.startsWith('data:image'));
    check('captcha: ticket 非空', typeof captcha.json.data.ticket === 'string' && captcha.json.data.ticket.length > 0);
  }

  const manifest = await req('GET', '/manifest.json');
  check('manifest.json: HTTP 200 且是 JSON', manifest.status === 200 && manifest.json !== null);
  check('manifest.json: name/icons 存在', typeof manifest.json?.name === 'string' && Array.isArray(manifest.json?.icons));

  const unknown = await req('GET', '/api/v4/__no_such_endpoint__');
  check('未知 API: 信封 + 非零 code', unknown.json !== null && unknown.json.code !== 0, `实际 ${JSON.stringify(unknown.json)?.slice(0, 100)}`);

  const badLink = await req('GET', '/f/000000/nope.bin');
  check('直链不存在: HTTP 404 + 信封', badLink.status === 404 && badLink.json?.code !== undefined, `HTTP ${badLink.status}`);

  const staticRoot = await fetch(`${BASE}/`);
  const staticBody = await staticRoot.text();
  check('静态首页: HTTP 200 且是 HTML', staticRoot.status === 200 && staticBody.includes('<'));

  // ---------- 登录前置 ----------
  console.log('\n—— session/prepare ——');
  const unknownUser = await req('GET', `/api/v4/session/prepare?email=nobody-${Date.now()}@example.com`);
  check('prepare: 未知邮箱返回错误（非 {}）', unknownUser.json !== null && unknownUser.json.code !== 0, `实际 ${JSON.stringify(unknownUser.json)?.slice(0, 100)}`);

  // ---------- 完整链路 ----------
  console.log('\n—— 注册 / 登录 / 文件操作 ——');
  let token = null;
  let refreshToken = null;

  if (!registerEnabled) {
    console.log('  ⏭ 站点未开启注册，跳过完整链路（可在管理后台开启后重跑）');
  } else {
    const email = `smoke-${Date.now()}@example.com`;
    const password = 'Smoke-Test-1234';

    const reg = await req('POST', '/api/v4/user', { body: { email, password } });
    const regAccepted = reg.json !== null && (reg.json.code === 0 || reg.json.code === 203 || reg.json.code === 40023);
    check('注册: 请求被接受（0 / 203 待激活 / 40023 邮件）', regAccepted, `实际 ${JSON.stringify(reg.json)?.slice(0, 140)}`);

    const login = await req('POST', '/api/v4/session', { body: { email, password } });
    if (envelopeOk('登录', login)) {
      token = login.json.data?.token?.access_token;
      refreshToken = login.json.data?.token?.refresh_token;
      check('登录: data.token.access_token 非空', typeof token === 'string' && token.length > 0);
      check('登录: data.user 存在', login.json.data?.user !== undefined);
    }

    if (token) {
      const prepared = await req('GET', `/api/v4/session/prepare?email=${encodeURIComponent(email)}`);
      check('prepare: 已注册账号 password_enabled=true', prepared.json?.data?.password_enabled === true, JSON.stringify(prepared.json?.data));

      const me = await req('GET', '/api/v4/user/me', { token });
      if (envelopeOk('user/me', me)) {
        check('user/me: 匿名为 false 且有 id', me.json.data?.anonymous === false && !!me.json.data?.id);
      }

      const folderName = `smoke-${Date.now()}`;
      const created = await req('POST', '/api/v4/file/create', {
        token,
        body: { uri: `cloudreve://my/${folderName}`, type: 'folder' },
      });
      if (envelopeOk('file/create 建目录', created)) {
        const list = await req('GET', `/api/v4/file?uri=${encodeURIComponent('cloudreve://my/')}&page=0&page_size=100`, { token });
        if (envelopeOk('file 列表', list, { needData: false })) {
          const objects = list.json.data?.objects ?? list.json.data?.files ?? [];
          check('列表: 能看到刚建的目录', objects.some((o) => o.name === folderName), JSON.stringify(list.json.data)?.slice(0, 140));
        }

        const renamed = await req('POST', '/api/v4/file/rename', {
          token,
          body: { uri: `cloudreve://my/${folderName}`, new_name: `${folderName}-r` },
        });
        envelopeOk('file/rename 重命名', renamed, { needData: false });

        const del = await req('DELETE', '/api/v4/file', { token, body: { uris: [`cloudreve://my/${folderName}-r`] } });
        envelopeOk('file 删除', del, { needData: false });
      }
    }

    if (refreshToken) {
      const logout = await req('DELETE', '/api/v4/session/token', { body: { refresh_token: refreshToken } });
      envelopeOk('注销', logout, { needData: false });
    }
  }

  // ---------- 汇总 ----------
  console.log(`\n${'='.repeat(46)}`);
  console.log(`通过 ${pass} / ${pass + failCount}`);
  if (failCount > 0) {
    console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

main().catch((e) => {
  console.error('冒烟测试自身跑挂了（多半是站点不可达）：', e?.message ?? e);
  process.exit(2);
});
