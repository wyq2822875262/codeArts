# 码道网关 · CodeArts Gateway

华为云「码道 CodeArts」网页端（`devcloud.cn-north-4.huaweicloud.com/chat`）的账号池管理控制台 + OpenAI 兼容反代网关。

界面与功能形态参考 [ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager)：扫码/贴 Cookie 纳管账号、密钥分组分发、IP 与模型白名单、调用日志与用量统计、模型中心、可视化设置。

## 这是什么

码道网页端把对话能力放在三层接口后面：`/v1/cloudagent/sessions` 建会话、`/codebaseservice/v1/cloudagent/sessions/:id/messages` 发指令（返回 SSE）、`/PromptCenterService/...` 取模型。它只认网页登录态（Cookie + `cftk` 头），没有公网 API Key。

本项目把这套协议包装成标准接口，并把账号、密钥、配额、审计这些运营环节补上：

| 原本要做的 | 现在在面板上 |
|---|---|
| 每个客户端手工带一份 Cookie | 账号池纳管，网关自动轮询选号 |
| 只能直连网页 | `/v1/chat/completions`、`/v1/messages`、`/v1/responses` |
| 无法知道谁用了多少 | 每次调用的模型、Token、首字延迟、来源 IP 全量留痕 |
| 无 IP 防护 | 入站白/黑名单（CIDR）+ 每密钥 IP 上限与白名单 |
| 下游改模型名要改代码 | 模型别名映射，把下游在用的名字映到实际模型 |

## 快速开始

```bash
# Node >= 22.5（需要内置 node:sqlite）
node -v

# 直接启动，零依赖
ADMIN_PASSWORD='你的密码' node src/server.js
```

打开 `http://127.0.0.1:7864`，用密码登录。

也可以写 `.env`（参考 `.env.example`）后 `npm start`。

## 三步用起来

1. **纳管账号**：浏览器登录 `https://devcloud.cn-north-4.huaweicloud.com/chat/home` → F12 → Network 任意 `/chat/` 请求 → 复制整段 `Cookie` 请求头 → 面板「账号管理 → 添加账号」粘贴。保存后会自动校验并拉取可用模型。
2. **发密钥**：「密钥分发 → 新建密钥」，可设额度、有效期、IP 上限、模型白名单、IP 白名单。密钥只明文返回一次。
3. **指下游**：把 `base_url` 指向 `http://<你的地址>:7864/v1`，`api_key` 填刚生成的 `sk-ca-...`。

```bash
curl http://127.0.0.1:7864/v1/chat/completions \
  -H "Authorization: Bearer sk-ca-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"DeepSeek-V3.2","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/v1/chat/completions` | 网关密钥 | OpenAI 兼容对话（流式/非流式），`deepseek` 风格 `reasoning_content` 透出上游思维链 |
| POST | `/v2/chat/completions` | 网关密钥 | 同上（v2 路径） |
| POST | `/v1/responses` | 网关密钥 | OpenAI Responses API |
| POST | `/v1/messages` | 网关密钥 | Anthropic Messages（Claude Code 等），`x-api-key` 亦可 |
| GET | `/v1/models` | 网关密钥 | 模型列表（来自上游 agent detail） |
| GET | `/v1/usage` | 网关密钥 | 密钥自查：已用/剩余额度、有效期、模型范围 |
| GET | `/healthz` | 无 | 存活探测 |

管理面为 `/api/*`（会话 Cookie 鉴权），完整清单见下表。

## 管理面 API

| 方法与路径 | 说明 |
|---|---|
| `POST /api/login` `/api/logout` | 登录 / 登出 |
| `GET /api/me` | 当前用户 |
| `POST /api/password` | 修改密码 |
| `GET /api/stats/overview` | 今日/累计请求、Token、账号与密钥计数 |
| `GET /api/stats/series?days=14` | 按天、按模型、按小时聚合 |
| `GET/POST /api/accounts` | 账号列表 / 新增（`name`、`cookie`、`cftk?`、`note?`） |
| `PATCH/DELETE /api/accounts/{id}` | 改（启停、备注）/ 删 |
| `POST /api/accounts/{id}/test` · `/sync` | 校验登录态 / 同步模型 |
| `GET/POST /api/keys` | 密钥列表 / 新建（`quota`、`max_ips`、`ip_whitelist`、`model_whitelist`） |
| `PATCH/DELETE /api/keys/{id}` | 改 / 删 |
| `GET /api/logs?limit&offset&q&status` | 调用日志分页检索 |
| `GET/POST /api/models` | 模型缓存 / 从上游同步 |
| `GET/POST /api/ip-rules`，`DELETE /api/ip-rules/{id}` | 入站 IP 规则（CIDR） |
| `GET/POST /api/settings` | 默认模型、别名映射、会话复用与 TTL、并发会话上限、超时 |
| `POST /api/sessions/clear` | 只清本地会话表（不动上游） |
| `POST /api/sessions/purge` | 到上游真正删掉该账号所有 ACTIVE 会话，用于 429 后恢复 |
| `GET /api/signin/status` | 签到调度状态、下次执行时间、各账号今日结果 |
| `POST /api/signin/run` | 立即手动跑一轮签到 |
| `GET /api/signin/logs?limit=50` | 签到历史记录 |

## 每日签到

网关会按北京时间每天自动登录福利中心领积分（默认 08:05，可在「每日签到」页改）。

签到的实际协议是**两步**，只做第一步会一直报「尚未到达权益刷新时间」：

1. `POST /PromptCenterService/v1/ops/events/trigger`，body `{triggerEvent:'user.login', channel:'WEB', idempotentKey:'login-YYYYMMDD-xxxxxx'}` —— 触发当天权益投递
2. `GET /PromptCenterService/v1/ops/delivery?channel=WEB` —— 列出全部活动，挑 `status=ELIGIBLE` 的
3. `POST /PromptCenterService/v1/ops/claim`，body `{campaignId, idempotentKey, channel:'WEB'}` —— 领取，随后 `POST /ops/confirm` 确认到账

签到接口和对话链路的区别只在请求头：`Agent-Type` 必须是 `PromptCenter`（对话是 `CodeBase`），路径必须带 `/chat` 前缀。鉴权仍然是同一个 Cookie + `cftk`。

上游把业务错误也放在 HTTP 200 里，必须看 `code`：`0/200` 是成功，`40001` + 「尚未到达权益刷新时间」表示今天已经签过（属正常），其余算失败。实现里按这个语义分类，见 `src/signin.js` 的 `classifyClaimResult`。

调度器（`src/signin-scheduler.js`）的特性：同一天已成功签过就跳过；有账号失败按 10 分钟 / 30 分钟 / 1 小时 / 3 小时退避重试；重试不会重复领积分，因为上游对已领的活动返回 40001。时间按 UTC+8 计算，与服务器时区无关。

## 账号保活

上游登录态是**空闲超时**判定的，不是绝对过期：一段时间不请求就作废。实测有效窗口约 **1~1.5 小时**（样本：有效区间 03:33→04:59，约 98 分钟后被判失效）。超过这个窗口再调，上游会回 `hw-ajax-redirect: https://auth.huaweicloud.com/authui/login`，此时只能人工重导 Cookie。

`src/keepalive.js` 定时打最轻的鉴权接口把计时器推后：

- 心跳端点 `GET /rest/me`，默认每 **900 秒**（15 分钟）一轮，可调到 60 秒，下限 60 秒。
- 刚被真实业务请求用过的账号（`last_used` 在半数间隔内）本轮跳过，不和业务请求抢上游配额。
- 连续 **2 次**探活失败才判死，单次网络抖动不会熔断。判死写 `state='invalid'`，`pickAccount` 不再选中它——否则每个下游请求都会白打一次上游。
- 探活成功会顺手把之前熔断的 `invalid` 拉回 `ok`，不需要手工干预。
- 换 Cookie（`PATCH /api/accounts/:id` 带新 `cookie`）会自动清掉失效标记并重新从新 Cookie 里提取 `cftk`，因为 Cookie 和 cftk 是一体的，只换 Cookie 留旧 cftk 会直接 `csrf validate fail`。

**失效判定不能只看 HTTP 状态码**：上游失效时 `/rest/me` 回的是 `200` + 空 body（或登录页 HTML），cloudagent 端点回 `200` + 空 body + `hw-ajax-redirect` 头。`isAuthError` 同时认 `status`、`code`、`message` 三类信号，`request()` 还会把 `content-type: text/html` 也当失效处理。

全部启用账号都失效时，`/v1/*` 直接短路返回 503 并给出可操作文案（`ALL_ACCOUNTS_INVALID`），不再往上游打空枪。

**签到依赖保活**：签到调度是 24 小时一次，而会话空闲超时只有约 1.5 小时，所以等到 08:05 触发时 Cookie 早已凉了——这也是自动签到从来没成功过的原因。`signin_preheat` 打开时，`runOnce` 会先跑一轮强制保活再签到。

保活设置（「设置」页的「账号保活」卡，或 `POST /api/settings`）：`keepalive_enabled`、`keepalive_interval_sec`、`signin_preheat`。状态与手动触发走 `GET /api/keepalive/status`、`POST /api/keepalive/run`。签到接口轮转出的 `cftk` 也走 `emitCftkRotate` 回写库，不再只活在内存里。

## 界面主题

控制台有深色、浅色两套主题，右上角 `◐` 按钮切换，登录页也有一个。选择存在 `localStorage` 的 `deva-theme` 键里，下次打开沿用；没存过时按系统 `prefers-color-scheme` 决定，首屏在 `<head>` 内联脚本里定好，不会闪白。

两套主题的全部色值都写在 `web/style.css` 的 `:root`（深色）与 `:root[data-theme="light"]`（浅色）里，改主题只改变量。曲线图是 canvas 画的，不能吃 CSS 变量，所以 `app.js` 的 `drawLine` 在每次绘制时用 `getComputedStyle` 读 `--chart-*`，切主题会调 `redrawCharts()` 重绘当前页的图。新增图表时记得把重绘函数登记到 `state.charts`，否则换主题后图形还是旧颜色。

布局断点：1180px 以下统计卡两列，980px 以下侧栏收成 64px 只留图标、双列内容转单列，720px 以下卡片全单列。

静态资源带版本号：`index.html` 里写的是 `/app.js?v={{APP_V}}`、`/style.css?v={{STYLE_V}}`，`src/server.js` 的 `renderHtml` 在每次响应时按文件 mtime 替换成真实版本号，同时所有静态资源走 `Cache-Control: no-cache` + ETag 协商缓存（命中返回 304）。这样改完前端刷新即生效——早先写死 `max-age=3600` 时，改完 CSS/JS 要等一小时才看得到。

## 上游协议

从网页端 SDK（`devcloud-res.hc-cdn.com/CodeArtsWorkWeb/.../index-*.js`）还原，并用真实流量逐条校准（抓包样本见 `test/fixtures/real-capture.json`），落在 `src/upstream.js`：

```
POST /chat/v1/cloudagent/sessions                          -> { status:"ok", result:{ session_id } }
     必带 agent-type: CodeBase，缺则返回 TM.00001001「请求头Agent-Type为空」
POST /chat/codebaseservice/v1/cloudagent/sessions/:id/messages
     body { content, model_id, repos: [] }
     Accept: text/event-stream                              -> event/data 事件流
POST /chat/v1/cloudagent/sessions/:id/messages/stop         -> 中断本轮
POST /chat/v1/cloudagent/sessions/:id/messages/reply        -> 回答 question 工具
GET  /chat/v1/cloudagent/sessions?page_num=1&page_size=20   -> 会话列表
GET  /chat/rest/me                                          -> 账号信息（不受 agent 网关限制）
```

真实请求头（网页端实际发出的，注意 `agent-type` 是小写键）：

```
Content-Type: application/json
Accept: application/json, text/plain, */*
language: zh-cn
x-language: zh-cn
x-requested-with: XMLHttpRequest
x-codearts-doer-scenario-type: web
agent-type: CodeBase
cftk: <取 cookie 里 devclouddevuibjtcftk 的值，缺失返回 csrf validate fail>
x-ot-client-type: CodeArtsWork_Web
x-ot-client-version: 126.11.2.20261113114147
x-mode-type: fastmode
```

`model_id` 用的是短 slug，不是显示名。实测可用：`speed`（智速模式）、`deepseek-v4.1-flash-1017`、`glm-5.3-flash`、`deepseek-v4.1-flash`、`glm-5.3`、`kimi-k3.1-pro`、`kimi-k3`、`glm-5.2`、`glm-5.2-arkts-spark`、`openpangu-2.1-pro`、`openpangu-2.0-pro`、`openpangu-2.0-flash`。

### cftk 轮转

上游每次响应都可能通过 `Set-Cookie` 下发新的 `devclouddevuibjtcftk`（响应头里叫 CSRF token）。网关收到后立即回写账号记录（`accounts.cftk` 与 `accounts.cookie` 同步更新），下一次请求用新值。不回写就会在下一轮拿到 `csrf validate fail`。

### SSE 事件 -> OpenAI 映射

实测事件序列：`status` → `file_diff` → `session_title` → `thought`/`message` → `step_finish` → `done`。

| 上游事件 | 数据字段 | 含义 | 网关输出 |
|---|---|---|---|
| `status` | `status: initializing/processing` | 排队/处理中 | 内部状态，不输出 |
| `file_diff` | `diff[]` | 产物变更 | 忽略（可扩展 artifacts） |
| `session_title` | `title` | 自动标题 | 内部记录 |
| `thought` | `content, index, part_id` | 思维链增量 | `reasoning_content` / Anthropic `thinking_delta` |
| `message` | `content, index, part_id` | 正文增量 | `delta.content` / `text_delta` |
| `step_finish` | `tokens{total,input,output,reasoning,cache}` | token 用量 | `usage` |
| `done` | `tokens, latency_ms, model, credit_cost_for_web` | 本轮结束 | `finish_reason: stop` + `[DONE]` |
| `error` / `stopped` | — | 异常 / 中断 | error 事件 |

注意 `message` 事件只有 `content/index/part_id`，没有 `message_type`；正文与思维链靠事件名区分，不靠字段。

### 关于会话复用

上游是 agent 型接口，`messages` 发的是自然语言指令而非结构化对话。网关这样处理：

- 首轮把 `system + 历史` 拼成完整内容发给新会话；
- 之后同一条对话（以「首条 user 消息 + 模型 + 密钥」为指纹）复用同一个上游 session，此时只补最后一条 user，让上游自己累积上下文；
- 不同密钥、不同模型不会命中共用会话；上游 session 有 TTL，超时或出错即重建。

可在「设置 → 会话复用」关闭，关闭后每轮都是新会话并重新发送完整内容。

## 部署到 VPS

纯 HTTP 直连上游，不需要浏览器，也不需要任何 CDP/无头浏览器。

### 为什么能纯 HTTP 跑

`/v1/cloudagent/*` 早期实测会被 `HW-AJAX-REDIRECT` 挡回登录页，当时换了浏览器带发（CDP）绕。后续定位清楚了根因：**当时那份 cookie 来自定制内核浏览器（Prism），其 `vk` 会与内核指纹绑定**。改用标准 Chrome 的完整 cookie 后，Node 原生 `fetch` 直连 `/v1/cloudagent/sessions` 与 SSE 消息接口都是 200、正文与 usage 正常返回。所以只要 cookie 来自标准浏览器，纯 HTTP 就成立 —— 这也是本项目的默认形态。

`vk` 与浏览器实例绑定这一条仍然有效：cookie 换了浏览器内核就必须重新登录获取。

### 步骤

```bash
# 1) 装 Node 22+（需要内置 node:sqlite）
#    Debian/Ubuntu 用 NodeSource，或直接用官方二进制
node -v   # 需 >= 22.5

# 2) 取代码
git clone <本仓库> /opt/codearts-gateway
cd /opt/codearts-gateway

# 3) 配置
cp .env.example .env
vi .env    # 至少改 ADMIN_PASSWORD，SESSION_SECRET 用 openssl rand -hex 32 生成

# 4) 导入上游账号（在 VPS 上执行，参数是本地浏览器复制来的 cookie）
node tools/import-cookie.js -f cookies.txt 我的账号
#    或直接粘：node tools/import-cookie.js 'SessionID=...; cbc-sid=...; devclouddevuibjtcftk=...'
#    工具会实时校验登录态、拉取模型清单、写入数据库，失败会直接报错退出

# 5) 起服务
node src/server.js
```

`import-cookie.js` 的典型输出：

```
账号：我的账号
cookie：1514 字节，40 项，cftk=有
正在校验上游登录态…
  ✓ 登录态有效：GT-wyq2822875262
  ✓ 可用模型：12 个
  ✓ 已写入 ./data/gateway.db（账号 id=1）
```

同名账号会覆盖更新，所以 cookie 过期后重新导入一次即可。

### 从本地浏览器取 cookie

浏览器登录 `https://devcloud.cn-north-4.huaweicloud.com/chat/home` → F12 → Network → 点任意 `/chat/` 开头的请求 → Request Headers 里整行复制 `Cookie:` 的值。也可以 Application → Cookies → 选中域名后逐条拼成 `k=v; k=v`。

要注意的几项：`SessionID`、`cbc-sid`、`devclouddevuibjtcftk`。后两个里的 `devclouddevuibjtcftk` 就是上游要求的 `cftk` 头，网关会自动取用并在每次响应后轮转回写。

控制台的「账号管理」页有个 **? 如何获取 Cookie** 按钮，展开后是同一套流程的分浏览器图文步骤（Chrome / Edge、Firefox、Safari 各一份，外加 Console 一行取），还列了每个必需 Cookie 键的作用与缺失后果、以及校验失败的排查顺序。展开状态记在 `localStorage`，下次进来保持。

### systemd

```bash
sudo cp deploy/codearts-gateway.service /etc/systemd/system/
sudo useradd -r -s /usr/sbin/nologin codearts
sudo chown -R codearts:codearts /opt/codearts-gateway
sudo systemctl daemon-reload
sudo systemctl enable --now codearts-gateway
sudo journalctl -u codearts-gateway -f
```

改服务文件里的 `User`、`WorkingDirectory` 与 `ExecStart` 的 node 路径以匹配实际环境。

### 反向代理（HTTPS）

`.env` 里默认 `HOST=127.0.0.1`，只监听本机，由 Nginx / Caddy 对外提供 TLS。`deploy/nginx.conf.example` 与 `deploy/Caddyfile.example` 都可直接用，改域名即可。

两个必须注意的点：

- **流式会被代理缓冲**。Nginx 要 `proxy_buffering off;`，Caddy 要 `flush_interval -1`，否则下游看到的是等全部生成完才一次性吐出，`stream: true` 就失去意义了。
- **真实 IP**。设 `TRUST_PROXY=true` 才会采信 `X-Forwarded-For`。出于防伪造考虑，只有来源命中 `TRUSTED_PROXIES` 时才采信（留空表示信任任意对端 —— 在只监听 127.0.0.1 的前提下是安全的）。没设 `TRUST_PROXY` 时一律用对端地址，伪造的 XFF 会被忽略，IP 白名单不会被绕过。

### Docker

```bash
cp .env.example .env && vi .env
docker compose up -d --build
docker compose logs -f
node tools/import-cookie.js -f cookies.txt 我的账号   # 用同一份 DATA_DIR
```

compose 已经把端口绑到 `127.0.0.1`，数据落在 `./data`，容器以非 root 运行，并带健康检查。导入账号要在宿主机执行（`DATA_DIR` 指向同一个 `./data`），或者 `docker compose exec gateway node tools/import-cookie.js ...`。

### 并发会话上限（重要）

上游对**同一账号**同时存在的会话数有硬上限，实测为 **3 个**；超出时建会话仍返回 200，但发消息会直接报：

```
CODEBASE.00014000.429  Insufficient environmental resources. Please try again later.
```

或

```
并发会话数已达上限(3个)，请关闭部分会话后重试。
```

只调 `.../messages/stop` 不会回收 runtime，必须 `DELETE /v1/cloudagent/sessions/{id}` 才算真正释放。网关对此做了三件事：

- `session_pool_max`（默认 3）限制每账号在池会话数，建新会话前先淘汰最久未用的空闲会话，并到上游真正删除；
- 建会话全程串行，避免并发请求同时通过配额检查把上游打穿；
- 账号停用/删除时自动释放它在上游的全部会话。

正常使用一般不会撞到这条。真撞上了（比如历史上手工压测留下的会话），一键恢复：

```bash
curl -X POST http://127.0.0.1:7864/api/sessions/purge -b 'dv_session=<你的管理面会话>'
# => {"ok":true,"removed":17}
```

面板「设置」里也有对应入口。`/api/sessions/clear` 只清本地表、不动上游，排查时注意区分这两个。

### 上线检查清单

- `ADMIN_PASSWORD` 已改掉（启动日志里出现「管理员密码仍是默认值」就是没改）
- `SESSION_SECRET` 已固定，否则每次重启管理面都要重新登录
- 只通过 HTTPS 对外，`HOST` 保持 `127.0.0.1`
- `data/` 已纳入备份 —— 账号 cookie、密钥、日志都在 `gateway.db` 里
- 反向代理已关缓冲，`curl -N` 验证流式是逐块到达而不是最后一次性到达
- 撞到上游 429 时用 `POST /api/sessions/purge` 清掉上游残留会话（见上一节）

## 安全与边界

- 管理面密码 scrypt 加盐哈希存储，会话 Cookie 为 HMAC 签名、HttpOnly、7 天有效。
- 网关密钥仅哈希后用于比对，明文只在创建时返回一次；面板内再次查看需要登录会话。
- 入站 IP 规则支持精确 IP 与 CIDR（v4/v6）；`deny` 始终优先，存在 `allow` 时仅放行白名单。
- 每密钥可设 IP 数量上限、IP 白名单、模型白名单、Token 额度、有效期。
- 请求体默认不留存，只记元数据（模型、状态、Token、延迟、IP）。
- 默认只监听 `0.0.0.0`，公网部署请自行套反向代理与 HTTPS，并先改掉默认密码。

## 目录结构

```
src/
  config.js     配置与环境变量
  db.js         node:sqlite 数据层（账号、密钥、日志、用量、设置）
  auth.js       会话 Cookie、密码哈希、IP/CIDR 匹配
  upstream.js   上游协议客户端（cloudagent + kernel 回退）与 SSE 解析
  signin.js     福利中心协议：签到活动列表、事件触发、领取
  signin-scheduler.js  每日签到调度（北京时间、失败退避重试）
  keepalive.js  账号保活：定时心跳 /rest/me、失效熔断、cftk 回写
  bridge.js     OpenAI 请求 -> 上游会话 -> 中性事件流
  gateway.js    对外出口：chat/completions、messages、responses、models、usage
  admin.js      管理面 API
  server.js     HTTP 入口、真实 IP 解析与静态资源
web/            控制台前端（原生 HTML/CSS/JS，无构建）
  index.html      页面骨架
  style.css       两套主题变量 + 全部样式
  app.js          交互、渲染、图表
tools/
  import-cookie.js   命令行导入上游账号 cookie（VPS 上用）
deploy/
  codearts-gateway.service   systemd 单元
  nginx.conf.example         含流式关缓冲的 Nginx 反代
  Caddyfile.example          Caddy 反代（自动 HTTPS）
test/
  mock-upstream.js      本地 mock 上游（模拟 cloudagent 协议）
  e2e.js                端到端自测
  protocol.js           用真实抓包校验协议解析与事件映射
  probe-events.js       真实 SSE 事件的映射结果直接打印
  fixtures/real-capture.json  2026-11-16 实抓的真实流量样本
```

## 自测

```bash
npm test                 # 协议层 + 端到端
node test/protocol.js    # 用真实抓包校验 SSE 解析、事件映射、cftk 轮转、请求体
node test/e2e.js         # 起 mock 上游跑完整网关链路
```

`test/protocol.js` 用 `test/fixtures/real-capture.json` 里的真实抓包做断言（21 项），协议一改就会立刻报错。

`test/e2e.js` 起 mock 上游 + 网关，覆盖登录、模型同步、密钥鉴权、流式/非流式对话、Anthropic 与 Responses 出口、额度与白名单拦截、多轮会话复用、上游登录态失效识别（31 项断言）。

打真实上游可以这样快速验一条：

```bash
node tools/import-cookie.js -f cookies.txt 测试号
curl -s http://127.0.0.1:7864/v1/chat/completions \
  -H "Authorization: Bearer sk-ca-xxx" -H "Content-Type: application/json" \
  -d '{"model":"speed","messages":[{"role":"user","content":"只用两个字回答：可用"}]}'
```

## 已知限制

- `vk` 与浏览器实例绑定：cookie 从别的浏览器内核搬过来会被服务端覆盖并退回登录页，必须重新登录后重新导出。同类 cookie 请用标准 Chrome 取，纯 HTTP 直连实测可用。
- 上游是 agent 而非纯模型接口，输出会包含 agent 的执行过程；`done.tokens` 的 `input` 含系统提示与工具定义（实测单轮 system_prompts 可达 2.6 万 token），计费口径与纯模型不同。
- `PromptCenterService` 的模型清单接口需要特定 `agent_id` 参数，取不到时回退到实测内置清单（12 个）。
- 上游 cookie 是**空闲超时**（约 1~1.5 小时不请求就失效，见「账号保活」），不是按天过期。开保活后能持续续命，但上游还有一层绝对上限（`SessionID` 本身的 TTL），到点仍然要重新导出导入——网关会把账号标为 `invalid` 并在日志里记 `AUTH_REDIRECT`。
- 不支持图片生成。
- 使用范围限于本人及已获授权的账号；请自行确认符合上游服务条款与当地法规。
