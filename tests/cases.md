# 规范逐项用例映射

这里的脚本均向本仓库模拟服务发起 HTTP 请求；Gateway 合同脚本另外检查模拟器的 SSE 帧。`agent/pipeline-cases.sh` 使用可控 Agent 故障服务，`frontend/playwright-cases.sh` 使用 Chromium。每条用例的断言失败都会使脚本退出非零。这些用例不验证真实外部网关用户；结果报告须遵守 [AGENTS.md](../AGENTS.md)。

| 规范 | 断言与故障注入 | 脚本 |
| --- | --- | --- |
| A0 迁移与启动 | 隔离 schema 连续迁移两次，seed 数保持 5；删除当前版本标记后 Backend 非零退出 | `backend/migration-cases.mjs` |
| A1 完整状态表 | 对 6×6 共 36 种转移逐项断言，包括终态和同态拒绝 | `backend/state-table-cases.mjs` |
| A1 CAS 与终态 | 非法转移、过期 expectedFrom、两个并发更新恰好一个成功；重复终态、成员移除、排队消息取消 | `backend/integration-cases.sh` |
| A2 多实例发送 | 两个 Backend 共享数据库；延迟首条网关响应，次条保持 queued；两条按顺序仅发送一次 | `backend/integration-cases.sh` |
| B1 限流账号选择 | admin 账号限流、creator 在线时，admin 角色步骤由在线 creator 发出 | `backend/integration-cases.sh` |
| C1 媒体保留 | Backend 下载附件并由同源 API 提供；过期清除后不重复下载 | `backend/integration-cases.sh` |
| 2.1 账号和网关各端点 | idle/connect 同 ID/disconnect/终态/限流、建群/邀请就绪与过期/join/promote/kick/leave/send/by-client-id/media、HTTP 错误与 SSE 补发和乱序，154 个针对模拟 Gateway 的 curl case | `gateway/contract-cases.sh` |
| 2.2 工具集合与 schema | 恰好四个工具、required 覆盖、非法 JSON Schema、参数类型错误均为 `TOOLS_INVALID`；相同 runId 上下文冲突 | `agent/contract-cases.sh` |
| 2.2 Anthropic 消息历史 | 首轮 `tool_use`、后续 assistant tool_use 与 user tool_result、同 runId 继续会话；触发上下文和 audit 均使用 Backend 群组 ID；audit pass/fail/非法入参 | `agent/contract-cases.sh`、`agent/pipeline-cases.sh` |
| 2.2 坏响应 | Markdown 包裹、块类型错误、块数错误、非 2xx 均成为 `BAD_JSON`，第三次协议错误结束；多字节原始响应不超过 2KB | `agent/pipeline-cases.sh` |
| 2.2 重复 ID 与工具错误 | 重复 tool_use.id 为协议错误；未知工具和非法入参为可见 tool_use 错误步骤 | `agent/pipeline-cases.sh` |
| 2.2/ A5 超时与步数 | 11 秒迟到的 turn 记录 `TURN_TIMEOUT`；连续 3 次结束；重复读取走满 12 步并以 `budget_exhausted` 结束 | `agent/pipeline-cases.sh` |
| A5 最近消息 | `limit: 100000` 最多返回 50 条；700 字触发消息截为 500 字并置 `truncated`；数据库内 tool_result 实测不超过 8KB，步骤摘要不超过 200 字 | `agent/pipeline-cases.sh` |
| A5 审计 | fail 不发送；500、无效 JSON、缺 verdict、未知 verdict、超过 5 秒的 audit 各尝试 3 次后 `audit_blocked` | `agent/pipeline-cases.sh` |
| A5 发送和 S5 | 第一次网关 send 返回 504 且 1.5 秒后落地；新 tool_use.id 重用同一 key 时无第二次审计/发送；网关仅一条消息 | `agent/pipeline-cases.sh` |
| A5 踢人 | 自动移除关闭时 `POLICY_DENIED`；开启后网关首次 kick 返回 504、500ms 后成员移除，恢复时按成员列表确认；同一目标的新 ID 重试只审计一次 | `agent/pipeline-cases.sh` |
| A5 账号与群状态 | 无在线群成员返回 `NO_AVAILABLE_ACCOUNT`；执行中关闭 Agent 则 run `cancelled`；群禁言后发送为 `GROUP_UNREACHABLE` 且 run `cancelled` | `agent/pipeline-cases.sh` |
| A5 触发队列 | 运行中再到消息会在前一个 run 完成后产生下一个 run | `agent/pipeline-cases.sh` |
| A5 运行恢复 | `/agent/turn` 等待中强制终止 Backend，重启后沿用同一 runId；发送工具的幂等记录写入后再次强制终止，恢复后仅一次审计和一次网关消息 | `agent/pipeline-cases.sh` |
| 2.3 登录与权限 | admin/viewer 登录、refresh 轮换、旧 refresh 失效、viewer 写操作 403、标准错误体 | `backend/integration-cases.sh`、`frontend/playwright-cases.sh` |
| 2.3 账号/群/作业 API | connect/transition、建群作业、邀请/申请审批/join/promote/kick/leave/leave-all、群组字段和终态 | `backend/integration-cases.sh`、`frontend/playwright-cases.sh` |
| 2.3 消息 API | queued/accepted/sent、分页和回流去重、504 查询重试、503、异步失败与终态、附件 | `backend/integration-cases.sh` |
| 2.3 Agent 查询 API | 最近 run 列表、单次 run 的步骤、原始响应、审计结果、状态和结束原因 | `agent/pipeline-cases.sh`、`frontend/playwright-cases.sh` |
| A6 群组页 Agent 展示 | 群组详情加载 `/api/groups/:id/agent-runs`，展示历史运行、状态、步骤、trace_id，并用 Chromium 截图验证模拟环境的页面 | `scripts/e2e-local.mjs` |
| C3 Agent Run 浏览器链路 | Playwright 登录、打开模拟 Gateway 对应群组、展开 mock Agent run；断言 trace_id、全部步骤、kind、工具名、结果摘要、审计结论与错误码，并生成 HTML 报告和截图 | `frontend/c3-agent-run.sh`、`frontend/c3-agent-run.spec.mjs` |
| 2.3 序列 API / S7 | 同组并发启动恰好一个 201、一个 409；运行步骤结束 | `backend/integration-cases.sh` |
| 2.3 序列预检 / S8 | 预检不写入消息；缺变量返回 422、stepIndex/key；合法预检返回最终文本与每个变量来源 | `backend/integration-cases.sh`、`frontend/playwright-cases.sh` |
| 2.3 WS 与 B4 | WS 授权、序号和断线 sinceSeq 补发；浏览器收到消息刷新页面；打开 Agent 运行详情查看步骤和 trace_id | `backend/integration-cases.sh`、`frontend/playwright-cases.sh` |
| B4 序列前端 | 选择序列、编辑 vars/stepVars、打开服务端预检确认弹窗、确认后启动、显示进度 | `frontend/playwright-cases.sh` |
| 前端服务边界 | 平台页面仅访问 Backend `/api` 和 `/ws`；独立 Gateway 调试页直接访问 Gateway 模拟器 | `frontend/playwright-cases.sh`、`npm run check:boundary` |
