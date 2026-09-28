# Sentinel Messaging Platform

多账号群组消息平台。`backend` 是 Node.js/TypeScript/PostgreSQL API 与后台任务；`gateway-service` 是模拟外部 HTTP/SSE 消息网关的独立服务；`agent-service` 是遵守工具调用协议的独立决策服务；`frontend` 是 React 18/TypeScript/shadcn/ui 控制台。业务服务在本机作为独立进程运行，直接连接 PostgreSQL。

当前仓库启动的 Gateway 是根据文档api实现 遵守 [AGENTS.md](AGENTS.md)。

## 环境要求

| 依赖                         | 用途                                                |
| ---------------------------- | --------------------------------------------------- |
| Node.js 22+、npm             | 安装并运行四个业务服务                              |
| Docker                       | 一键启动 PostgreSQL 16 容器（推荐）                 |
| `psql` / PostgreSQL 客户端 | 仅在使用本机已有 PostgreSQL、或跑部分集成测试时需要 |
| Chromium（Playwright）       | 仅跑浏览器 E2E / C3 测试时需要                      |

可选：`ss` 或 `lsof`（`scripts/dev-local.sh` 用来检测/清理端口占用）。

## 一键流程（推荐）

在仓库根目录执行：

```bash
# 1. 安装依赖
npm ci
npm --prefix backend ci
npm --prefix gateway-service ci
npm --prefix agent-service ci
npm --prefix frontend ci

# 2. 启动 PostgreSQL 并执行迁移（需要 Docker daemon）
bash scripts/start-postgres.sh

# 3. 一键启动 Backend / Gateway / Agent / Frontend
npm run dev
# 等价于：bash scripts/dev-local.sh start
```

首次 `start-postgres.sh` 若没有 `.env`，会从 `.env.example` 复制一份，并写入 `DATABASE_URL`。请确认 `.env` 中的服务端口与一键脚本一致（默认见下表），否则 Backend 可能连到错误的 Gateway/Agent 地址。

## 安装依赖

四个服务各自有 `package.json`，根目录脚本只覆盖编排、OpenAPI 生成和部分测试：

```bash
npm ci                              # 根目录：OpenTelemetry、openapi-generator、playwright
npm --prefix backend ci             # Backend API 与 worker
npm --prefix gateway-service ci     # Gateway 模拟器
npm --prefix agent-service ci       # Agent 决策服务
npm --prefix frontend ci            # 控制台
```

修改 `openapi/openapi.yaml` 后重新生成前端客户端：

```bash
npm run api:generate
```

生成代码在 `frontend/src/generated`。`npm run check:boundary` 检查只有 Gateway 管理页可直连模拟网关。

## 安装并启动 PostgreSQL

业务进程不进容器，只把数据库放进 Docker（或使用你本机已有的 PostgreSQL）。设计说明见 [ADR 0001](docs/adr/0001-local-development.md)。

### 方式 A：Docker 一键（推荐）

```bash
bash scripts/start-postgres.sh
```

脚本会：

1. 拉取 `postgres:16-alpine`（可用 `POSTGRES_IMAGE` 覆盖）。
2. 创建持久卷 `sentinel-postgres-data`（可用 `POSTGRES_VOLUME` 覆盖）。
3. 启动容器 `sentinel-postgres-local`，映射宿主 `5432`。若该端口已被另一个 PostgreSQL 容器占用，会复用该容器。
4. 创建应用库与用户（默认库/用户/密码均为 `sentinel`）。
5. 用应用账号验证连接，并执行 `backend` 迁移。
6. 把 `DATABASE_URL` 写进 `.env`。

可重复执行：已有容器会 `docker start`，已有角色会更新密码，已有库不会重建。

常用覆盖（写在 `.env` 或命令前导出）：

| 变量                                                                | 默认                        | 含义         |
| ------------------------------------------------------------------- | --------------------------- | ------------ |
| `POSTGRES_CONTAINER_NAME`                                         | `sentinel-postgres-local` | 容器名       |
| `POSTGRES_PORT`                                                   | `5432`                    | 宿主端口     |
| `POSTGRES_ADMIN_USER` / `POSTGRES_ADMIN_PASSWORD`               | `postgres` / `postgres` | 容器超级用户 |
| `POSTGRES_DB` / `POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD` | `sentinel`                | 应用库与账号 |
| `POSTGRES_VOLUME`                                                 | `sentinel-postgres-data`  | 数据卷       |

默认连接串：

```text
postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel
```

停止/查看容器（可选，不影响业务代码）：

```bash
docker ps --filter name=sentinel-postgres-local
docker stop sentinel-postgres-local    # 暂停数据库
docker start sentinel-postgres-local   # 再次启动
```

不要用 `docker rm -v` 删除带数据卷的容器，除非你明确要清空本地数据。

### 方式 B：本机已有 PostgreSQL

需要已安装 `psql`，并在 `.env` 中配置管理员连接与应用库：

```bash
# .env 中例如：
# PGHOST=127.0.0.1  PGPORT=5432  PGUSER=postgres  PGPASSWORD=postgres
# APP_DB_NAME=sentinel  APP_DB_USER=sentinel  APP_DB_PASSWORD=sentinel

bash scripts/setup-local-db.sh
```

脚本创建应用角色与数据库，再跑迁移。之后把 `DATABASE_URL` 设为：

```text
postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel
```

仅补跑迁移（库已存在时）：

```bash
npm run migrate
# 等价于：bash scripts/migrate-local.sh
```

Backend 启动时会检查 schema 版本；版本落后则拒绝启动。

## 一键启动业务服务：`scripts/dev-local.sh`

`npm run dev` 调用该脚本，默认子命令是 `start`。

```bash
bash scripts/dev-local.sh start      # 迁移 → 后台拉起四服务 → 等待健康检查
bash scripts/dev-local.sh status     # 是否在跑、打印访问地址
bash scripts/dev-local.sh stop       # 停止 supervisor 及其端口上的子进程
bash scripts/dev-local.sh restart    # stop + start
```

`start` 会：

1. 若已有 supervisor（`.dev-local.pid`）则直接打印状态并退出。
2. 检查四个服务端口是否空闲。
3. 执行 `npm --prefix backend run migrate`。
4. 用 `setsid` 后台启动 Gateway、Agent、Backend、Frontend（日志写入 `.dev-local.log`）。
5. 轮询直到以下全部就绪：`GATEWAY_URL/health`、`AGENT_URL/health`、`http://127.0.0.1:$BACKEND_PORT/api/health`、前端首页。失败会自动 `stop` 并提示看日志。

默认端口（可用环境变量或 `.env` 覆盖）：

| 服务           | 变量                            | 默认端口  | 健康检查 / 入口                       |
| -------------- | ------------------------------- | --------- | ------------------------------------- |
| Frontend       | `FRONTEND_PORT`               | `25173` | `http://127.0.0.1:25173/`           |
| Backend        | `BACKEND_PORT`（或 `PORT`） | `28080` | `http://127.0.0.1:28080/api/health` |
| Gateway 模拟器 | `GATEWAY_PORT`                | `28081` | `http://127.0.0.1:28081/health`     |
| Agent          | `AGENT_PORT`                  | `28082` | `http://127.0.0.1:28082/health`     |

相关 URL 变量：`GATEWAY_URL`、`AGENT_URL`、`VITE_BACKEND_URL`、`VITE_GATEWAY_URL`。一键脚本还会设置 `ENABLE_GATEWAY_SIMULATION=true`、`AGENT_PROVIDER=mock`（除非你已在环境中覆盖）。

日志与进程：

- 日志：`.dev-local.log`
- PID：`.dev-local.pid`

排错：端口占用时按提示停止占用进程，或改 `BACKEND_PORT` / `GATEWAY_PORT` / `AGENT_PORT` / `FRONTEND_PORT`。改端口时请同步改 `GATEWAY_URL`、`AGENT_URL`、`VITE_BACKEND_URL`、`CORS_ORIGINS`。

对各服务单独调试（不要与一键脚本抢同一端口）：

```bash
# 需已设置 DATABASE_URL、GATEWAY_URL、AGENT_URL
npm --prefix gateway-service run dev
npm --prefix agent-service run dev
npm --prefix backend run dev
npm --prefix frontend run dev -- --host 0.0.0.0 --port 25173
```

Frontend 开发服务器把 `/api` 和 `/ws` 代理到 `VITE_BACKEND_URL`。

本地冒烟（四服务已在跑时）：

```bash
bash scripts/smoke-local.sh
```

## 如何访问服务

| 用途               | 地址                               |
| ------------------ | ---------------------------------- |
| 控制台（日常操作） | http://127.0.0.1:25173             |
| Backend API        | http://127.0.0.1:28080/api         |
| Backend 健康检查   | http://127.0.0.1:28080/api/health  |
| Prometheus 指标    | http://127.0.0.1:28080/api/metrics |
| Gateway 模拟器     | http://127.0.0.1:28081             |
| Agent              | http://127.0.0.1:28082             |

演示登录（仅本地）：

| 用户       | 密码       | 权限 |
| ---------- | ---------- | ---- |
| `admin`  | `admin`  | 读写 |
| `viewer` | `viewer` | 只读 |

正式环境必须替换用户凭据与 `JWT_SECRET`。Gateway 模拟器的 `/admin/*` **没有鉴权**，只允许隔离开发环境，不要暴露到公网。

**浏览器网络边界：**平台功能只调用同源 Backend `/api/*` 和 `/ws`（OpenAPI 生成客户端）。左侧「Gateway 消息服务」是独立管理页，浏览器经 `frontend/src/api/gateway.ts` 直连 Gateway HTTP/SSE，不走平台群组/消息接口。默认连当前页面主机的 `GATEWAY_PORT`（本地 `28081`），也可用 `VITE_GATEWAY_URL`。平台库里的群记录 ID 与 Gateway 群 ID 是两套命名空间：主标题用 Gateway 群 ID 短形式；群组工作台把平台 UUID 标为「平台记录 ID」。

## 控制台功能操作

侧栏对应 hash 路由：`#overview`、`#accounts`、`#create-group`、`#groups`、`#timeline`、`#message-service`、`#sequence`。只读账号看不到写操作，或按钮为禁用。

### 1. 登录与运营概览

1. 打开 http://127.0.0.1:25173 ，使用 `admin/admin` 或 `viewer/viewer`。
2. 「运营概览」显示群组数量、活跃群、已启用 Agent；可跳转到账号、建群、群组工作台、Gateway 消息服务。
3. 右上角退出登录。

### 2. 账号管理（`#accounts`）

平台托管的服务账号（迁移会预置若干 idle 账号，例如 `acc-1`）。创建账号时会同步注册到 Gateway。

- **添加账号**：填写账号 ID（创建后不可改）和可选显示名称。
- **连接账号**：`idle` / `disconnected` →「连接账号」，状态变为 `online`（或限流时为 `rate_limited`）。
- **标记离线 / 释放**：在线可标为离线；离线可释放回 `idle`。
- **编辑 / 删除**：改显示名称；删除会保留历史消息，**已删除的 ID 不能复用**。
- **所属群组 / 申请**：查看已加入群与待审批申请，点击跳到群组详情。
- **提交入群申请**：账号须为 `online`，选择尚未加入的活跃群后提交。申请先落库为「待审批」，**不会立刻调网关**。到「群组与消息」里由管理员同意后，后台才申请邀请链接、提交入群。拒绝申请不调用网关。网关返回 202 时界面显示「入群中」。申请状态在 PostgreSQL，重启后会继续处理已同意的申请。

### 3. 创建群组（`#create-group`）

仅管理员。群主和成员都必须是 **online** 账号。

1. 选择群主；勾选至少一名成员（列表中第一位会被设为管理员）。
2. 点击「创建群组」。后端先记 job，worker 调模拟网关建群并拉成员入群。
3. 页面轮询 job：`running` → `finished` 后跳到群组工作台；失败显示步骤错误码。任务带 `clientJobId`，重启不会重复建群。

### 4. 群组与消息（`#groups`）

工作台可按状态筛选、搜索群或成员。展开详情后：

- 查看健康状态、平台记录 ID、Gateway 群 ID、成员角色（托管账号 / Gateway 用户）。
- **生成邀请链接**：链接只表示可申请入群，是否入群以成员事件为准；可复制。链接可能有 `readyAfterMs` 延迟。
- **开启 / 关闭 Agent**：开启后，**非平台自身账号**的入站消息会触发 Agent Run（同一群同时只有一个 running run）。
- **开启 / 关闭自动移除**：配合 Agent 审计通过后的踢人副作用。
- **成员操作**（托管成员）：设为管理员、移出、自行退群。非托管 Gateway 用户不能由平台「提升 / 自行退群」。
- **入群申请**：选择 online 账号提交；待审批列表可「同意 / 拒绝」。
- **Agent 运行**：展开最新 run，查看 `trace_id`、步骤 kind、工具名、入参、结果摘要、审计结论、错误码。
- **打开消息**：进入 `#timeline`，读 Backend 持久化消息（分页「加载更早」、WebSocket 实时合并）。自身消息带 `isOwn`；附件走授权的 `/api/media/{id}`。

网关协议本身没有审批接口，审批是本控制台流程。

### 5. Gateway 消息服务（`#message-service`）

直连模拟 Gateway，用于模拟「外部会话」。页面上的用户**不是**真实外部账号。

**会话：**

1. 可选：选一个有 `create_group` 能力的在线用户「新建群」。
2. 点开群，选当前群成员作为发送者；输入文本，或点回形针上传不超过 10 MB 的单个文件，回车或「发送」。
3. 受理中的消息可按 `clientMsgId` 查询是否落地。
4. 「群管理」：邀请、提升、踢出、退群、用邀请链接直接入群、切换群可写状态；侧栏显示该群 SSE 事件。

**用户：**

- 添加用户（名称必填，用户 ID 可留空自动生成，创建后不可改）。
- 详情 / 改名 / 删除（删除会退出所有群，历史消息保留）。
- 加入群（内部先 invite 再 join）、从已加入群退群。

文件先落到 Gateway 的 `GATEWAY_MEDIA_DIR`（默认 `media_gateway/`）；Backend 再下载到 `MEDIA_DIR`（默认 `media/`）。保留天数默认 30。`GATEWAY_PUBLIC_URL` 应是浏览器可访问且与 Backend `GATEWAY_URL` 同源的地址。

可用 `node tests/gateway-direct-page.mjs` 验证浏览器直连链路（会创建并清理专用 Gateway 群和用户）。

### 6. 自动化序列（`#sequence`）

「序列模板」是可复用步骤定义，**保存不会发消息**。「运行」才绑定一个群、填变量并真正发送。同一群同时只能有一个 `running` 运行。

**编模板：**

1. 「创建序列模板」或「编辑模板」。
2. 每步：角色 `admin`（优先群管理员）或 `member`（按账号 ID 字典序选成员）、相对上一步**真实送达**后的等待秒数、可选默认 `senderAccountId`、消息文本。可用 `{变量名}`（字母数字下划线）。
3. 保存。高级模式可直接编辑步骤 JSON。

延迟含义：第 1 步 `10` 秒、第 2 步 `5` 秒 = 启动后等 10 秒发第 1 步，收到网关 `message_sent` 后再等 5 秒发第 2 步。

**跑一次：**

1. 点模板的「运行序列」，选目标**运行中**群组。
2. 可按步覆盖发送账号（须是该群服务账号；不在群或不可用则该步 `skipped`；`rate_limited` 则等待）。
3. 填 `vars`（全局默认）和 `stepVars`（如 `{ "2": { "location": "共享盘" } }` 从第 2 步起覆盖）。
4. 「预检变量与消息」→ 弹窗核对最终文本、发送账号、变量来源 →「确认启动」。任意 `{key}` 无法解析返回 `422 UNRESOLVED_PLACEHOLDER`，**不建运行、不发网关**。
5. 当前运行与历史运行展示每步 `pending` / `accepted` / `sent` / `failed` / `skipped`、计划时间、实际发出时间、账号。群不可用则运行 `stopped`。Backend 重启后只重排当前最早逾期步骤。

### 建议的本地演示路径

1. 登录 `admin`。
2. 账号管理：连接至少两个账号（如 `acc-1`、`acc-2`）。
3. 创建群组：群主 `acc-1`，成员勾选 `acc-2`。
4. 群组工作台展开详情 → 打开消息时间线。
5. Gateway 消息服务：用群内用户发一条模拟外部消息；若已开启 Agent，回到群详情看 Agent Run。
6. 自动化序列：保存示例模板 → 对该群预检并启动，在运行页看步骤状态。

各服务环境变量、加载顺序和仓库模块说明见文末 [各服务环境变量](#各服务环境变量) 与 [项目模块说明](#项目模块说明)。根目录模板为 [.env.example](.env.example)，Agent 密钥模板为 [agent-service/.env.example](agent-service/.env.example)。

## 测试执行与结果查看

测试前需已安装各目录依赖、可访问的 PostgreSQL，并安装 Chromium：

```bash
npx playwright install chromium
```

C3 浏览器用例验证「登录 → 打开群组 → 查看 Agent Run 步骤与结果」。下列命令会先构建，再创建隔离 PostgreSQL schema，启动独立的 Gateway 模拟器、mock Agent、Backend 和 Vite，最后清理：

```bash
npm run test:c3
npm run test:c3:report
```

报告在 `test-results/c3-agent-run/html/index.html`。

| 范围                       | 执行脚本                                 | 查看结果                           |
| -------------------------- | ---------------------------------------- | ---------------------------------- |
| 构建                       | `npm run build`                        | 终端退出码与四服务构建输出         |
| Backend 单元测试           | `npm --prefix backend test`            | 终端 TAP                           |
| 前端访问边界               | `npm run check:boundary`               | 终端逐项结论                       |
| 模拟 Gateway 合同          | `bash tests/gateway/contract-cases.sh` | curl 状态与响应                    |
| mock Agent 合同与故障链路  | `npm run test:agent`                   | run 状态、步骤、审计、错误码       |
| Backend 模拟服务集成       | `npm run integration`                  | 终端断言                           |
| 综合 Playwright E2E        | `npm run e2e`                          | 终端断言；截图在`/tmp/*-e2e.png` |
| C3 Playwright E2E          | `npm run test:c3`                      | `npm run test:c3:report`         |
| 全部合同、集成与浏览器用例 | `npm run test:all`                     | 终端按组显示；C3 另有 HTML 报告    |

更细入口见 [tests/README.md](tests/README.md) 和 [测试矩阵](docs/test-strategy.md)。CI 见 `.github/workflows/ci.yml`。

**测试证据边界：**集成与 E2E 使用本仓库 Gateway 模拟器；C3 与默认 Agent 使用 `AGENT_PROVIDER=mock`，外部用户消息由模拟端点注入。它们验证模拟协议下的处理链路，不验证真实外部用户、真实 Gateway 或真实 LLM。

## 各服务环境变量

配置分两层：

| 文件                   | 谁读取                                                                                                                   | 用途                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 仓库根目录`.env`     | `scripts/dev-local.sh`、`start-postgres.sh`、`setup-local-db.sh`、`migrate-local.sh`；一键启动时导出给四个子进程 | 日常本地开发的主配置                                                    |
| `agent-service/.env` | Agent 进程启动时`process.loadEnvFile`（文件存在才加载）                                                                | Agent 专用，尤其是 LLM 密钥。**不会覆盖进程里已经存在的同名变量** |

一键启动会先 `source` 根目录 `.env`，再套默认值并 `export`。因此根目录里的 `AGENT_PROVIDER=mock` 会进入 Agent 进程；此时即使 `agent-service/.env` 写了 `anthropic`，也**不会**盖过 mock。要用真实模型，请把 `AGENT_PROVIDER` 和密钥写在**根目录 `.env`**，或在执行 `npm run dev` 前 `export`。单独 `cd agent-service && npm run dev` 时才会主要依赖 `agent-service/.env`。

不要把含密钥的 `.env` 提交进 git。生产必须替换 `JWT_SECRET` 与演示账号。

### 根目录 `.env`（编排 + Backend + 端口）

与一键脚本对齐的完整示例见 [.env.example](.env.example)。

**进程端口与互访 URL**（改端口时这些要一起改）

| 变量                          | 一键默认                                                   | 谁用                                                        |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `BACKEND_PORT` / `PORT`   | `28080`                                                  | Backend 监听；脚本优先`BACKEND_PORT`，否则用 `PORT`     |
| `GATEWAY_PORT`              | `28081`                                                  | Gateway 监听（脚本把该值赋给 Gateway 进程的`PORT`）       |
| `AGENT_PORT`                | `28082`                                                  | Agent 监听（同上）                                          |
| `FRONTEND_PORT`             | `25173`                                                  | Vite 开发服务器                                             |
| `DATABASE_URL`              | `postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel` | Backend 与迁移                                              |
| `GATEWAY_URL`               | `http://127.0.0.1:28081`                                 | Backend 调网关                                              |
| `AGENT_URL`                 | `http://127.0.0.1:28082`                                 | Backend 调 Agent`/agent/turn`、`/agent/audit`           |
| `VITE_BACKEND_URL`          | `http://127.0.0.1:28080`                                 | 前端把`/api`、`/ws` 代理到 Backend                      |
| `VITE_GATEWAY_URL`          | 空                                                         | 浏览器直连 Gateway；空则用当前页主机 +`VITE_GATEWAY_PORT` |
| `VITE_GATEWAY_PORT`         | `28081`                                                  | 未设`VITE_GATEWAY_URL` 时拼 Gateway 源                    |
| `CORS_ORIGINS`              | `http://127.0.0.1:25173,http://localhost:25173`          | Backend 允许的控制台 Origin（逗号分隔）                     |
| `JWT_SECRET`                | 本地演示值                                                 | 签发会话；`NODE_ENV=production` 时至少 32 字符            |
| `ENABLE_GATEWAY_SIMULATION` | `true`（一键脚本）                                       | 为`true` 时开放 Backend 测试用模拟外部成员接口            |
| `AGENT_PROVIDER`            | `mock`（一键脚本）                                       | 传给 Agent 进程；见下一节                                   |

**Backend 自身**

| 变量                            | 默认                             | 含义                                                      |
| ------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `MEDIA_DIR`                   | `./media`                      | 从 Gateway 下载后的本地媒体目录                           |
| `MEDIA_RETENTION_DAYS`        | `30`                           | Backend 媒体保留天数；运行中 Agent Run 引用的文件延迟清理 |
| `MEDIA_MAX_BYTES`             | `10485760`                     | 下载大小上限                                              |
| `MEDIA_DOWNLOAD_MAX_ATTEMPTS` | `5`                            | 下载重试次数                                              |
| `AGENT_TURN_TIMEOUT_MS`       | `15000`（限制在 10000–15000） | Backend 等待单轮`/agent/turn` 的超时                    |
| `NODE_ENV`                    | 未设                             | `production` 时收紧 JWT、Cookie `secure`、错误堆栈    |

**Gateway 模拟器**（一键启动时脚本还会设 `HOST=0.0.0.0`、`GATEWAY_STATE_FILE=.../gateway-service/data/state.json`）

| 变量                             | 默认                                      | 含义                                                                    |
| -------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `PORT`                         | 单独跑时`4001`；一键为 `GATEWAY_PORT` | 监听端口                                                                |
| `HOST`                         | `127.0.0.1`；一键为 `0.0.0.0`         | 绑定地址                                                                |
| `GATEWAY_STATE_FILE`           | `gateway-service/data/state.json`       | 用户/群/事件持久化                                                      |
| `GATEWAY_MEDIA_DIR`            | `./media_gateway`                       | 上传文件目录                                                            |
| `GATEWAY_MEDIA_MAX_BYTES`      | `10485760`                              | 上传大小上限                                                            |
| `GATEWAY_MEDIA_RETENTION_DAYS` | `30`                                    | Gateway 侧文件保留天数                                                  |
| `GATEWAY_PUBLIC_URL`           | `http://127.0.0.1:$PORT`                | 写入消息里的媒体 URL，须浏览器可访问且与 Backend 的`GATEWAY_URL` 同源 |
| `INVITE_READY_AFTER_MS`        | `0`                                     | 邀请链接可用延迟                                                        |
| `INVITE_TTL_MS`                | `60000`                                 | 邀请过期                                                                |
| `JOIN_DELAY_MS`                | `100`                                   | 入群事件延迟                                                            |
| `KICK_DELAY_MS`                | `0`                                     | 踢人事件延迟                                                            |
| `SEND_EVENT_DELAY_MS`          | `100`                                   | `message_sent` 事件延迟                                               |
| `SEND_RESPONSE_DELAY_MS`       | `0`                                     | 发送 HTTP 响应额外延迟                                                  |

`/admin/*` 为故障注入（超时、503、重放事件等），无鉴权，仅隔离开发环境。

**Frontend（Vite，构建期/dev 注入）**

| 变量                                         | 默认                                   | 含义                               |
| -------------------------------------------- | -------------------------------------- | ---------------------------------- |
| `FRONTEND_PORT`                            | 单独跑 Vite 时`5173`；一键 `25173` | 开发服务器端口                     |
| `VITE_BACKEND_URL`                         | 代码默认`http://127.0.0.1:4000`      | 代理目标，须与 Backend 一致        |
| `VITE_GATEWAY_URL` / `VITE_GATEWAY_PORT` | 见上                                   | 仅「Gateway 消息服务」页直连模拟器 |

**PostgreSQL 脚本专用**（`start-postgres.sh` / `setup-local-db.sh`）

`POSTGRES_*` 控制 Docker 容器名、镜像、端口、管理员与应用账号、数据卷。`PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`、`APP_DB_*` 用于本机已有 PostgreSQL。含义见 [.env.example](.env.example) 注释段。

**可观测性（四个 Node 服务共用，由 `scripts/otel.mjs` 预载）**

| 变量                                           | 含义                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `NODE_OPTIONS=--import=.../scripts/otel.mjs` | 一键脚本已加；独立跑`node dist` 时需自己设                               |
| `OTEL_SERVICE_NAME`                          | 一键分别为`sentinel-backend` / `sentinel-gateway` / `sentinel-agent` |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                | 如`http://127.0.0.1:4318`；不设则只打日志、不导出 traces                 |
| `OTEL_SDK_DISABLED=true`                     | 关闭 SDK                                                                   |

媒体目录面向单实例；多实例需共享对象存储。

### agent-service（重点）

职责：实现工具调用协议。Backend 对每个 Agent Run 多次 POST `/agent/turn`（带 `runId`、四个工具 schema、会话 messages），副作用执行前再 POST `/agent/audit`。默认 **mock 规则引擎**（读最近消息 → 回复或按关键词踢人 → `finish`），不访问外网 LLM。`GET /health` 探活。会话哈希写在 `AGENT_SESSION_FILE`（默认 `agent-service/data/sessions.json`）。

**切换 provider**

| `AGENT_PROVIDER`    | 行为                                                         |
| --------------------- | ------------------------------------------------------------ |
| 未设或非`anthropic` | mock：确定性工具序列，用于本地与 CI                          |
| `anthropic`         | 把同一套 tools/messages 转发到 Anthropic 兼容的 Messages API |

`anthropic` 模式需要有效密钥、模型名和出网。它仍走同一工具协议；**不能**据此宣称「生产 LLM 已验收」，除非你用真实密钥跑通并单独记录证据。

根目录一键启用真实模型示例（写入根 `.env` 后 `bash scripts/dev-local.sh restart`）：

```bash
AGENT_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
# 可选：
# ANTHROPIC_BASE_URL=https://api.anthropic.com
# ANTHROPIC_MAX_TOKENS=512
# AGENT_MODEL_TIMEOUT_MS=14000
```

兼容 OpenRouter 或其它 Anthropic 风格网关时，用 `agent-service/.env` 模板（单独启动 Agent，或保证根目录**不要**先 export `AGENT_PROVIDER=mock`）：

```bash
# 复制：cp agent-service/.env.example agent-service/.env
AGENT_PROVIDER=anthropic
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-...
ANTHROPIC_API_MODEL=anthropic/claude-sonnet-4
# 必须显式留空，避免误用官方 x-api-key
ANTHROPIC_API_KEY=
```

鉴权规则（`agent-service/src/anthropic.ts`）：`ANTHROPIC_AUTH_TOKEN` 或目标主机为 `openrouter.ai` 时发 `Authorization: Bearer`；否则用 `ANTHROPIC_API_KEY` 发 `x-api-key`。`ANTHROPIC_MODEL` 与 `ANTHROPIC_API_MODEL` 任一即可。缺 token 或 model 会抛错，Backend 收到 `MODEL_UNAVAILABLE`。

| 变量                                          | 默认                                 | 含义                                           |
| --------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| `PORT`                                      | 单独跑`4002`；一键 `AGENT_PORT`  | 监听端口                                       |
| `AGENT_PROVIDER`                            | mock                                 | `anthropic` 才调外部模型                     |
| `AGENT_SESSION_FILE`                        | `agent-service/data/sessions.json` | runId ↔ context 哈希，防同 run 换上下文       |
| `ANTHROPIC_API_KEY`                         | 空                                   | 官方 Anthropic`x-api-key`                    |
| `ANTHROPIC_AUTH_TOKEN`                      | 空                                   | Bearer token（OpenRouter 等）                  |
| `ANTHROPIC_MODEL` / `ANTHROPIC_API_MODEL` | 空                                   | 模型 ID                                        |
| `ANTHROPIC_BASE_URL`                        | `https://api.anthropic.com`        | 可写到`/v1/messages` 的完整 URL，或仅 origin |
| `ANTHROPIC_MAX_TOKENS`                      | `512`（至少 128）                  | 模型输出上限                                   |
| `AGENT_MODEL_TIMEOUT_MS`                    | `14000`（限制 1000–14500）        | 调模型 HTTP 超时                               |
| `ENABLE_FAULT_INJECTION`                    | 未设                                 | `true` 时 turn 前额外等待，供故障测试        |
| `AGENT_TURN_DELAY_MS`                       | `0`                                | 上述注入延迟毫秒                               |

协议约束（mock 与 anthropic 相同）：必须一次提供四个工具 `get_recent_messages`、`send_message`、`kick_user`、`finish`；每轮只返回一个 `tool_use` 或最终文本。Backend 限制约 12 步、约 60 秒有效运行时间。审计 fail 则不会真正发消息或踢人。

单独启动 Agent：

```bash
cd agent-service
cp .env.example .env   # 填入密钥后再改 AGENT_PROVIDER
npm run dev            # 默认监听 4002，请与 Backend 的 AGENT_URL 一致
```

## 项目模块说明

```text
sentinel-messaging-platform/
  backend/                 平台 API、PostgreSQL、后台 worker
  gateway-service/         外部消息网关的本地模拟器（HTTP + SSE）
  agent-service/           Agent 决策进程（mock 或 Anthropic 兼容 API）
  frontend/                运营控制台
  openapi/openapi.yaml     平台 HTTP 契约（生成 frontend/src/generated）
  scripts/                 一键启动、迁移、集成/E2E、OTEL 预载
  tests/                   合同、集成、Playwright
  docs/                    架构、领域、库表、测试矩阵、可观测性
```

数据流：控制台平台页 → Backend REST/WebSocket → PostgreSQL；Backend ↔ Gateway HTTP/SSE；Backend ↔ Agent 工具协议。Gateway 管理页浏览器直连 Gateway，不经过平台群组 API。

### `backend/`

Node/Express，入口 `backend/src/index.ts`。连接 `DATABASE_URL`，消费 Gateway SSE，驱动 outbox/建群 job/入群申请/序列/Agent/媒体 worker，向浏览器推 WS。

| 路径                                 | 职责                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/domains/auth`                 | 登录登出、JWT、admin/viewer、写操作中间件                                                   |
| `src/domains/account`              | 账号 CRUD、连接网关、状态机（`state.ts` CAS + 终态副作用）                                |
| `src/domains/group`                | 群 API、成员、邀请、Agent/自动踢人开关；`jobs.ts` 建群；`joinRequests.ts` 审批后入群    |
| `src/domains/message`              | `outbox.ts` 发送与对账；`media.ts` 下载 Gateway 文件、过期清理、`/api/media`          |
| `src/domains/sequence`             | 模板与运行 API；`prepare.ts` 预检变量；`worker.ts` 按真实送达排期                       |
| `src/domains/agent`                | `processor.ts` 排队、单群单 run、turn/审计/工具副作用；`context.ts` 拼给 Agent 的上下文 |
| `src/infrastructure/db`            | 连接池、`schema.sql` 迁移、`SCHEMA_VERSION`（当前 `1.8.0`）                           |
| `src/infrastructure/events`        | Gateway SSE 游标、去重、失败重试                                                            |
| `src/infrastructure/realtime`      | `/ws` 与 `sinceSeq` 补发                                                                |
| `src/infrastructure/observability` | Prometheus、`trace_events`                                                                |

本地：`npm --prefix backend run dev`（tsx watch）。构建：`npm --prefix backend run build` 后 `npm start`。

### `gateway-service/`

模拟外部 IM：账号连接、用户、建群、邀请/入群/提升/踢人/退群、发消息、媒体、SSE `/events?since=`。状态默认 `data/state.json`。`/groups/:id/external-message` 与 `/external-member` 只用于测试注入，**不是**真实用户。合同说明见 `gateway-service/CONTRACT-TESTS.md`。

### `agent-service/`

| 文件                        | 职责                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `src/index.ts`            | `/agent/turn`、`/agent/audit`、`/health`；校验工具 schema；mock 决策；会话持久化 |
| `src/anthropic.ts`        | `AGENT_PROVIDER=anthropic` 时转发 Messages API                                       |
| `.env` / `.env.example` | 见上一节                                                                               |

不连 PostgreSQL。限制与审计在 Backend 执行。

### `frontend/`

Vite + React 18。平台客户端 `src/api/client.ts`（OpenAPI 生成代码）只打同源 `/api` 与 `/ws`。`src/api/gateway.ts` 仅管理页用。

| 组件 / 入口                           | 对应功能                                       |
| ------------------------------------- | ---------------------------------------------- |
| `src/main.tsx`                      | 登录、侧栏路由、账号页、群组工作台、Agent 详情 |
| `components/GroupCreation.tsx`      | 选在线账号建群并轮询 job                       |
| `components/MessageTimeline.tsx`    | Backend 消息时间线                             |
| `components/MessageServiceLive.tsx` | Gateway 会话                                   |
| `components/GatewayUsers.tsx`       | Gateway 用户                                   |
| `components/SequencePanel.tsx`      | 序列模板与运行                                 |
| `hooks/useEvents.ts`                | WebSocket 业务事件                             |
| `src/generated/`                    | `npm run api:generate` 产物，勿手改          |

### 其它目录

| 路径                                                  | 职责                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `scripts/dev-local.sh`                              | 一键 start/stop/restart/status                                        |
| `scripts/start-postgres.sh`                         | Docker PostgreSQL + 迁移                                              |
| `scripts/setup-local-db.sh`                         | 本机 PostgreSQL 建库                                                  |
| `scripts/migrate-local.sh`                          | 只跑迁移（`npm run migrate`）                                       |
| `scripts/otel.mjs`                                  | Node OTEL 预载                                                        |
| `scripts/integration-local.mjs` / `e2e-local.mjs` | 隔离 schema 的集成与浏览器测试                                        |
| `scripts/check-frontend-boundary.mjs`               | 平台代码不得直连 Gateway                                              |
| `openapi/`                                          | 平台 API 唯一契约源                                                   |
| `tests/`                                            | 分层用例，见[tests/README.md](tests/README.md)                         |
| `docs/`                                             | 架构与设计；协作约定见[docs/ai-development.md](docs/ai-development.md) |
| `AGENTS.md`                                         | 测试证据边界（模拟 vs 真实外部）                                      |

## 文档

- [架构与故障恢复](docs/architecture.md)
- [领域模型](docs/domain-model.md)
- [数据库设计](docs/database-design.md)
- [API 契约](docs/api-contract.md) 与 [OpenAPI](openapi/openapi.yaml)
- [测试矩阵](docs/test-strategy.md)
- [可观测性与告警](docs/observability.md)
- [AI 协作指南](docs/ai-development.md)
- [架构决策：本地开发](docs/adr/0001-local-development.md)
