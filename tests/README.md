# 合同与端到端用例

在仓库根目录运行 `bash tests/run-all.sh`。脚本先构建，再依次执行模拟 Gateway 的 curl/SSE 协议测试、mock Agent HTTP 协议测试、Agent 故障链路、Backend 集成和 Playwright 浏览器用例。每个 Backend/浏览器脚本创建独立 PostgreSQL schema 和独立模拟 Gateway/Agent 状态文件，结束后清理其测试数据；运行前需要本地 PostgreSQL、Node 依赖和 Chromium。

**验证边界：**这些用例会向本仓库的 Gateway 模拟器注入外部用户消息，并验证 Backend、数据库、Agent 和页面的后续链路。它们没有真实外部消息平台账号，也没有证明真实外部用户能够向群发消息。默认 Agent provider 是 mock。不得把这些测试的通过结果写成“真实外部用户/真实网关/真实 LLM 已验证”；仓库强制规则见 [AGENTS.md](../AGENTS.md)。

单独运行：

```bash
bash tests/gateway/contract-cases.sh
bash tests/agent/contract-cases.sh
bash tests/agent/pipeline-cases.sh
bash tests/backend/integration-cases.sh
bash tests/frontend/playwright-cases.sh
npm run test:c3
```

其中 `npm run test:c3` 等价于直接运行 `bash tests/frontend/c3-agent-run.sh`。

Gateway 用例打印向模拟器发出的 curl 请求、HTTP 状态与响应。Agent 故障链路打印每个 run 的状态、结束原因、步骤、审计和错误码。Backend 集成断言数据库、模拟网关事件、WebSocket 补发与 HTTP 响应。Playwright 在浏览器中走登录、群组、消息、Agent 步骤、序列预检和只读权限；平台页面只访问 Backend，独立 Gateway 调试页会直连模拟 Gateway。

## C3：Agent Run 步骤

`npm run test:c3` 是 C3 的一键入口，场景只聚焦“登录 → 打开目标群 → 展开最新 Agent Run → 核对所有步骤及结果字段”。fixture 使用 Backend 的测试端点向本仓库 Gateway 模拟器注入 `external-c3-browser` 消息，Agent provider 固定为 `mock`。用例断言运行状态、`trace_id`、步骤数量、kind、工具名、结果摘要、审计结论和错误码，并在 HTML 报告中附上成功页面截图。

```bash
npm run test:c3
npm run test:c3:report
```

报告固定生成到 `test-results/c3-agent-run/html/index.html`，原始附件位于 `test-results/c3-agent-run/artifacts/`。失败时可以从 HTML 报告打开 screenshot、video 和 trace；也可以执行 `npx playwright show-trace <trace.zip>`。只在项目已经完成构建时，可用 `npm run test:c3:only` 跳过重复构建。

## 全部测试与输出

| 测试层 | 命令 | 结果证据 |
| --- | --- | --- |
| Backend 单元 | `npm --prefix backend test` | 终端 TAP 输出 |
| 状态表 | `node tests/backend/state-table-cases.mjs` | 终端断言，失败退出非零 |
| 迁移 | `node tests/backend/migration-cases.mjs` | 终端迁移/启动断言 |
| Gateway 合同 | `bash tests/gateway/contract-cases.sh` | curl 请求、状态码与响应正文 |
| Gateway 用户模型 | `bash tests/gateway/unified-users-cases.sh` | 终端 CRUD 与群成员断言 |
| Agent 合同 | `bash tests/agent/contract-cases.sh` | 终端 HTTP 协议断言 |
| Agent pipeline | `bash tests/agent/pipeline-cases.sh` | run、步骤、审计、恢复和错误码 |
| Backend 集成 | `bash tests/backend/integration-cases.sh` 或 `npm run integration` | 数据库、HTTP、SSE、WS 与副作用断言 |
| 综合浏览器 | `bash tests/frontend/playwright-cases.sh` 或 `npm run e2e` | 终端断言及 `/tmp/*-e2e.png` 截图 |
| C3 浏览器 | `npm run test:c3` | HTML 报告与 Playwright 附件 |
| 全部用例 | `npm run test:all` | 各组终端输出和 C3 HTML 报告 |

逐项映射见 [cases.md](cases.md)。
