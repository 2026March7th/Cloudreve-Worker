# 部署手册

> **只想快点用上、手边没有电脑？** 走下面的一键部署，全程手机浏览器可完成；
> 后面的 CLI 手册留给想精细控制的人。

## 一键部署（推荐，手机可完成）

1. 打开 [neon.tech](https://neon.tech) 注册（可用 GitHub / Google 登录），新建项目，复制首页的 **Connection string**（`postgresql://...` 那串）。
2. 打开一键部署按钮：

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

3. 部署页里把 `DATABASE_URL` 填成第 1 步的连接串，其余保持默认，点 **Deploy**。
   KV、R2 由 Cloudflare 自动创建；**建表和初始化在首次打开站点时自动完成**，没有任何命令要跑。
4. 打开 Worker 地址（`https://cloudreve-worker.<你的子域>.workers.dev`），注册第一个账号 —— **第一个注册的用户自动是管理员**。
5. 收尾：Cloudflare 面板 → 你的 Worker → 设置 → 变量，把 `SITE_URL` 改成这个 Worker 地址。
6. 前端接入见第 5 节（同样只需要浏览器）。

### 不用按钮，在 Cloudflare 面板手动接仓库

Cloudflare 面板 → Workers & Pages → Create → 选你 fork 的仓库，只需要填两格：

| 框 | 填什么 |
|---|---|
| **构建命令**（Build command） | `npm install` |
| **部署命令**（Deploy command） | `npm run deploy` |

输出目录 / 根目录：留空。`npm run deploy` 会自动处理 KV namespace 和 R2
bucket：**账号里已有同名资源就直接连过来用，没有才新建**，并把真实 ID
回填进 wrangler.toml（`scripts/deploy.mjs` 干的），占位 ID 不用改。

然后在项目的 **设置 → 环境变量** 里添加 `DATABASE_URL`（值是 Neon 连接串），
保存后重新部署 —— 部署脚本会自动把它写入 Worker 的运行时 Secret。
`SITE_URL` 也加在这个环境变量里（部署时以 `--var` 覆盖生效）。

---

从零到能登录，一共 6 步。全程只需要 `wrangler` 和一个 Neon 账号。

> 前置条件：Node 20+、一个 Cloudflare 账号、一个 Neon 账号（免费档够用）。
> 本手册里的命令都在 `edge/` 目录下执行。

---

## 0. 先想清楚两件事

**① R2 要不要开？** R2 需要先在 Cloudflare 后台「同意 R2 服务条款」才能创建桶，
免费额度是 10GB 存储 + 每月 100 万次 A 类操作。不想用 R2 就跳过第 2 步的建桶，
改在部署完成后到管理后台加一个 OneDrive 存储策略。

**② 前端放哪？** 两种方案，第 5 步二选一：

| | 方案 A（推荐） | 方案 B |
|---|---|---|
| 做法 | 官方前端构建产物随 Worker 一起发布（`[assets]`） | 官方前端单独部署到 Cloudflare Pages，Worker 反代 |
| 优点 | 天然同源，Cookie 与 `/api` 路径都不用操心；一个域名搞定 | 前后端可以分别更新 |
| 缺点 | 改前端要重新发布 Worker | 要额外维护 `FRONTEND_URL`，跨域/回跳更容易出错 |

下面按方案 A 走，方案 B 的差异在第 5 节注明。

---

## 1. 装依赖

```bash
cd edge
npm install
```

---

## 2. 建 KV 与 R2

```bash
npx wrangler kv namespace create KV
```

输出里会有一行 `id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`，把它填进 `wrangler.toml`
的 `[[kv_namespaces]]`：

```toml
[[kv_namespaces]]
binding = "KV"
id = "上一步拿到的 id"
```

> `preview_id` 只影响 `wrangler dev` 的本地模拟，可以删掉那一行，也可以再建一个
> 预览命名空间（`--preview`）填进去。

```bash
npx wrangler r2 bucket create cloudreve-worker
```

桶名要和 `wrangler.toml` 里 `[[r2_buckets]] bucket_name` 一致（默认就是
`cloudreve-worker`）。**不需要改绑定的名称** `binding = "R2"`，代码按这个名字取。

---

## 3. 建 Neon 数据库并导出连接串

1. 在 Neon 控制台新建一个项目（区域选离用户近的）。
2. 进项目的 **Connection Details**，把 **Connection string** 复制出来，
   形如：

   ```
   postgresql://neondb_owner:xxxxxxx
   ```

   > 用 **Pooler** 的连接串也可以，Worker 走的是 HTTP 驱动，不占连接数。
   > 但**不要**去掉 `sslmode=require`。

3. 存成 Worker 机密（**不要**写进 `wrangler.toml`，那会被提交到仓库）：

   ```bash
   npx wrangler secret put DATABASE_URL
   # 粘贴上一步的连接串，回车
   ```

4. 顺便生成一个 JWT 密钥（可选但推荐）：

   ```bash
   npx wrangler secret put JWT_SECRET
   # 粘贴一串 32 位以上的随机字符串
   ```

   > 不设也能跑：会回退到数据库里 `settings.secret_key` 的值（首次启动自动生成）。
   > 显式设置的好处是刷新/吊销令牌时不完全依赖数据库可读性。

---

## 4. 建表 + 初始化

> **这一步通常可以跳过。** Worker 首次收到请求时会自动建表、播种三个系统用户组
> 和默认存储策略（见 `src/db/provision.ts`），幂等且并发安全。下面的脚本只在
> 想看每条语句的执行结果、或要在本机调试时才有用。
>
> 管理员账号也不再需要 seed：**第一个注册的用户自动进管理员组**。
> 管理员密码丢了？手机部署没有本机 CLI，走环境变量兜底：在 Worker 的
> **设置 → 变量和机密**里加 `ADMIN_EMAIL` + `ADMIN_PASSWORD`（建议存成
> Secret 类型），保存后下一个冷启动 isolate 会自动把这个邮箱设回管理员
> 组并重置成该密码（幂等：变量值不变就不重复落库，网页里改的密码不会被
> 覆盖）。恢复访问后把这对变量删掉即可。

这两步在**本机**跑（连的是同一个 Neon 库），脚本会读取 `DATABASE_URL` 环境变量，
或者 `edge/.dev.vars` 文件。

**方式一：临时环境变量（推荐）**

```bash
export DATABASE_URL="postgresql://...你刚才那条连接串..."

npx tsx --version >/dev/null 2>&1 || true   # 忽略，只是提示 node 版本

node scripts/migrate.mjs
```

**方式二：写 `.dev.vars`（本地调试也用得上）**

```
# edge/.dev.vars  —— 已被 .gitignore 排除，不会提交
DATABASE_URL="postgresql://..."
```

```bash
node scripts/migrate.mjs
```

`migrate.mjs` 会按文件名顺序执行 `migrations/*.sql`，每条语句打印 OK / FAIL。
**遇到 FAIL 会立刻停下**，不会有半套 schema。

预期输出（首次）：

```
>>> 0001_init.sql (N statements)
    [1/N] OK  CREATE TABLE IF NOT EXISTS groups ...
    ...
Migration completed.
```

接着初始化基础数据：

```bash
ADMIN_EMAIL='you@example.com' ADMIN_PASSWORD='换成你自己的强密码' node scripts/seed.mjs
```

它会做四件事（都是幂等的，重复跑安全）：

1. 补齐 `settings` 表缺失的键，并生成 `siteID` / `secret_key` / `hash_id_salt`；
2. 建三个系统用户组：`#1 Admin`、`#2 User`、`#3 Anonymous`
   （组 ID 与原版约定一致，**不能改**，`default_group = 2` 指的就是 #2）；
3. 建默认存储策略 `R2 Default`（type = `r2`），并绑到 User 组；
4. 建管理员账号（邮件 + 密码），密码摘要是 `<salt>:<sha256hex(password+salt)>`。

> ⚠️ **不传 `ADMIN_PASSWORD` 就不会建管理员**，脚本只打印一句提示。
> 建完一定要能登进去 —— 否则后面没法进管理后台。

### 如果你的库是从原版 Cloudreve 迁过来的

**不支持。** 边缘版用的是自建的等价 schema（列名/索引一致，但少了 6 张表、
JSON 列类型不同、没有 ent 的 migration 记录表）。请用全新的库。

---

## 5. 接官方前端

前端**只能用官方的**（<https://github.com/cloudreve/frontend>），本仓库不含任何前端代码，
但**默认已经帮你接好了**：`npm run build` / `npm run deploy` 会先跑
`scripts/fetch-frontend.mjs`，把官方前端构建产物准备到 `frontend/` 目录（不入库），
`wrangler.toml` 里的 `[assets]` 已启用，静态资源与 SPA 回落由平台资源层直接处理。

获取顺序（自动化，不用手动操作）：

1. `frontend/` 已存在就直接复用；
2. 本仓库 Release（tag `frontend-assets`）里的预构建包，秒级；
3. 都没有就拉上游源码（固定提交 `19da0fe1ecd40971fafa813983d769fdce41573c`，
   与上游 `.gitmodules` 一致），在构建机上 yarn install + vite build，约 3-5 分钟。

想换前端版本：改 `scripts/fetch-frontend.mjs` 顶部的 `COMMIT` 常量。
注意别跟到 `master` 最新 —— 前端可能和 v4.14.0 的后端契约对不上。

> 本机想手动构建也行（方式与上游 `.build/build-assets.sh` 一致）：
> `git clone` 上游仓库 → checkout 到固定提交 → `NODE_OPTIONS="--max-old-space-size=8192" yarn install && yarn run build`
> → 把 `build/` 拷到 `edge/frontend`。用 yarn，不用 npm/pnpm。

### 方案 A：随 Worker 一起发布（默认，推荐）

什么都不用做。`[assets]` 已在 `wrangler.toml` 里启用：

```toml
[assets]
directory = "./frontend"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/s/*", "/f/*"]
```

方案 A 不需要配 `FRONTEND_URL`，请求全走随 Worker 发布的静态资源。

> `run_worker_first` 是关键：它保证 `/api/*`、`/s/*`（分享短链）、`/f/*`（文件直链）
> 优先交给 Worker，其余路径走静态资源与 SPA 回落。漏了它前端路由会 404。

### 方案 B：前端单独部署

前端部署到 Cloudflare Pages（或任何静态托管）后，在面板环境变量（或 `wrangler.toml`
的 `[vars]`）里加：

```toml
[vars]
FRONTEND_URL = "https://your-frontend.pages.dev"
```

`FRONTEND_URL` 的优先级高于内置静态资源，非 `/api` 请求会原样反代过去。
后端代码同样不需要改。

> 前端构建时要让它自己的 API 基址为空（默认就是同源相对路径），否则会指向错误的域名。

---

## 6. 发布

```bash
npm run typecheck    # 可选，确认没有类型错误
npm run deploy
```

成功后设置 `SITE_URL` 再 `npm run deploy` 一次（两种加法任选：面板 →
环境变量里加；或 wrangler.toml 里加一段 `[vars]`）：

```toml
[vars]
SITE_URL = "https://你的域名"
```

> `SITE_URL` 参与生成分享短链、下载直链、OneDrive OAuth 回调地址。
> 留成 `example.workers.dev` 会让所有生成的链接都指向错误的主机。

如果配了自定义域名，在 Cloudflare 后台 **Workers → 你的 Worker → Settings → Domains & Routes**
里添加，然后在 `settings` 表里把 `siteURL` 也设成同一个域名
（`siteURL` 优先于 `SITE_URL`，见 `src/settings/provider.ts` 的 `siteUrl`）。

---

## 7. 定时任务

`wrangler.toml` 里已经有：

```toml
[triggers]
crons = ["0 * * * *"]
```

每小时跑一次回收站清理（对应上游的 `trash_collector` 队列任务）。
`npm run deploy` 会自动注册，不需要额外操作。

---

## 8. 验收清单

按顺序验一遍，任何一步不对都别再往下走：

1. `curl https://你的域名/api/v4/site/ping` → `{"code":0,...}`
2. 打开首页，能看到官方前端的登录页（不是纯文本的「后端已就绪」提示）
3. 用第 4 步建的管理员账号登录成功
4. 新建一个文件夹、上传一个小文件、下载回来 —— 校验内容一致
5. 建立分享链接（带密码），用一个浏览器隐身窗口打开，输入密码能访问
6. 把文件删掉 → 回收站里能看到（显示的是原文件名，不是一串随机字符）→ 恢复成功
7. 进管理后台，能看到用户列表与存储策略

> 第 6 步特意提「原文件名」：回收站项的 `files.name` 会被改成随机 UUID，
> 显示名靠 `sys:restore_uri` 元数据回落。如果看到随机字符，说明软删除的元数据没写进去。

---

## 9. 配置存储策略

### 用 R2（第 2 步建好的那个桶）

管理后台 → 存储策略 → 编辑 `R2 Default`：

- 类型：`r2`（边缘版内置，不需要填 server / ak / sk）
- 桶名：留空即可（绑定已经指明了桶）

想让 R2 直链不走 Worker 中转，需要一个便宜甚至免费的公共访问域名：

- 在 Cloudflare 给桶配一个自定义域（R2 → 你的桶 → Settings → Public access）
- 然后把 `R2_PUBLIC_BASE` 加到 `wrangler.toml` 的 `[vars]`：

  ```toml
  [vars]
  R2_PUBLIC_BASE = "https://files.example.com"
  ```

配了之后 `POST /file/url` 会返回不带签名的直链；不配则返回
`/api/v4/file/content/:id/:speed/:name?sign=...` 由 Worker 流式代理。

### 用 OneDrive

管理后台 → 存储策略 → 新建，类型选 `onedrive`，字段对应关系：

| 策略字段 | 填什么 |
|---|---|
| `server` | `https://graph.microsoft.com/v1.0`（**决定了 OAuth 端点**：host 是 `microsoftgraph.chinacloudapi.cn` 时走世纪互联，否则走全球版） |
| `bucket_name` | Azure 应用的 **client_id** |
| `secret_key` | Azure 应用的 **client_secret** |
| `access_key` | **refresh_token**（原版就把 refresh token 存在这个字段） |
| `settings.od_driver` | `me/drive` 或 `sites/<站点ID>/drive`，默认 `me/drive` |
| `settings.od_redirect` | OAuth 回调地址。**必须和 Azure 应用里登记的重定向 URI 完全一致** |

然后在策略编辑页点「获取授权链接」，走完微软的授权流程，把回调到的
refresh_token 填回 `access_key`。

> OneDrive 的**上传走客户端直传**：Worker 调 `createUploadSession` 拿到 `uploadUrl`
> 交给浏览器，分片由浏览器直接 PUT 给微软，不经过 Worker。
> 云端限速（`speed`）在 Workers 上无法实现，URL 里的 speed 段只是协议占位。

---

## 10. 配置邮件（可选）

不配也能跑 —— 注册、登录、文件操作都不依赖它。配了才有：**注册邮件激活、
找回密码、后台测试发信**。

**邮件配置在管理后台，不在 `wrangler.toml`，也不需要 `wrangler secret`。**

进 **管理后台 → 设置 → 邮件**，按你的服务商填：

| 字段 | 填什么 |
|---|---|
| 发件人名称 | 收件人看到的名字，如 `Cloudreve` |
| 发件人地址 | 必须是服务商**已验证域名**下的邮箱 |
| SMTP 服务器 | 服务商的 SMTP 主机 |
| SMTP 端口 | **465 或 587**（见下方警告） |
| SMTP 用户名 / 密码 | 服务商给的凭据 |
| 回复地址 | 可不填 |
| 强制 SSL | 一般不用开；开了就要求 TLS 必须成功 |

以 Resend 为例：

| 字段 | 值 |
|---|---|
| SMTP 服务器 | `smtp.resend.com` |
| SMTP 端口 | `465` |
| SMTP 用户名 | `resend` |
| SMTP 密码 | API Key（`re_` 开头） |
| 发件人地址 | `no-reply@你的已验证域名` |

填完点「发送测试邮件」，收件人填你自己的邮箱。收到就说明通了。

> ⚠️ **端口 25 用不了，这是最容易踩的坑。**
> Cloudflare Workers 禁止出站连接 25 端口（反滥用策略，官方文档原文：
> `Connections to port 25 are prohibited`）。而上游 Cloudreve 的默认 SMTP 端口
> 恰好就是 25 —— 所以**刚部署完什么都不改，直接发信必然失败**。
> 报错信息里会明确让你改成 465 或 587。

### 打开「注册需邮件激活」

设置项 `email_active` 默认是 `0`（关闭）。打开后新注册用户状态为 `inactive`，
必须点邮件里的链接才能登录。

**打开前先确认上面的测试发信是通的。** 否则新用户注册完就卡住进不来 ——
真遇到了也不至于丢账号：到管理后台的用户列表里把该用户状态手动改成 `active` 即可。

---

## 11. 已知限制与排错

### 「前端显示后端已就绪」的纯文本页

说明既没配 `[assets]` 也没配 `FRONTEND_URL`。回第 5 步。

### 登录后立刻被登出 / 刷新令牌失败

`hash_id_salt` 或 `secret_key` 被改过（比如重复跑了 `ensureSettings` 之外的手工
UPDATE）。这两个键一旦生成就**不能再变** —— hashid 是哈希出来的用户/文件 ID，
salt 变了所有旧 ID 全部失效。要换就接受所有链接与令牌作废。

### 上传到某个大小就失败

- R2 策略：检查策略的「最大文件大小」（`max_size`，0 = 不限）。
- OneDrive 策略：单文件超过 4MB 会走分片上传，分片大小必须是 320KiB 的整数倍
  （驱动已处理）。失败先看 Graph API 返回的 `error.message`。

### 大文件下载中断

`GET /api/v4/file/content/*` 会把整个对象**流式**转发出去，Worker 有 CPU 时间
与内存上限，但流式转发不占 CPU。真正的限制是客户端的超时设置。

### 定时任务没跑

`wrangler.toml` 的 `[triggers] crons` 只在**发布后**生效，`wrangler dev` 不会触发。
手动验证：

```bash
npx wrangler tail          # 另开一个终端
# 等整点，或到 Cloudflare 后台手动触发一次 Cron
```

### 想清空重来

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
```

然后在 Neon 控制台重新授权，再跑一遍第 4 步。
**R2 里的对象不会跟着删**，需要单独清桶。

---

## 12. 官方桌面客户端接入

官方 [Cloudreve Desktop](https://www.cloudreve.org)（Windows 桌面端，MSIX 安装）用
OAuth 2.0 授权码 + PKCE 登录，client_id 编译在客户端里。边缘版从 v4.14 起支持
**未知客户端自动注册**：桌面端第一次发起登录时，带着它内置的 client_id 打开网页
授权页，后端发现该 client_id 不在库里会自动登记（名字形如 `Client xxxxxxxx`，
scope 放开常用全集，回调接受任意 URI —— 包括 `cloudreve://` 自定义协议），
无需管理员预先建应用。

使用步骤：

1. 桌面端填入站点地址（就是 Worker 的地址），点登录 —— 浏览器弹出官方授权页。
2. 登录并点「授权」，浏览器把授权码交回桌面端，完成。
3. 管理后台 → OAuth 应用，可以看到自动登记的客户端，可改名、收紧 scope、
   或直接停用。

排错：

| 现象 | 原因 |
|---|---|
| 「应用不存在 / no such application」 | 部署的版本低于本节所述功能，更新到最新 main |
| 授权页打开但报 redirect 错误 | 手工建的应用必须把回调 URI 精确填进「重定向 URI」（每行一个）；自动登记的客户端无此限制 |
| 授权成功但桌面端仍提示失败 | 确认 `SITE_URL` 与桌面端填的地址完全一致（含 https），否则 cookie 域对不上 |

第三方应用（自己写的脚本、App）同理：把你的 client_id 随便编成一个 UUID 形态，
直接走 `GET /session/authorize?...&client_id=<你的UUID>` 即可自动登记。

---

## 13. 安全提醒

- `.dev.vars` 与 `wrangler secret` 里的东西**永远不要提交**。`.gitignore` 已经挡了
  `.dev.vars`，但别把它复制成别的文件名。
- 管理后台的默认账号是第 4 步自己建的，**没有默认密码这回事** —— 如果忘了，
  重新跑一次 `seed.mjs` 换一个邮箱建新管理员，或者直接改库里的 `users.password`。
- 上生产前确认 `siteURL` / `SITE_URL` 是 https 域名。
- 跨域默认关闭。除非官方前端部署在别的域，否则不要开 `CORS_ALLOW_ORIGINS`。
