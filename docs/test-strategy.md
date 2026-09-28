# 测试策略

测试目标是验证状态和外部副作用，而非只检查 HTTP 200。`npm --prefix backend test` 覆盖账号状态机、密码哈希、序列变量解析。`npm run integration` 使用 PostgreSQL、Backend、Gateway 模拟器、mock Agent 服务和 HTTP/SSE/WS 链路；每次在独立 schema 和临时文件中运行，结束即清理。`npm run e2e` 启动 Vite 与这些本地服务，用 Playwright 驱动浏览器。这些测试不验证真实外部消息平台用户或真实 LLM，报告结果时必须遵守 [仓库规则](../AGENTS.md)。

| 场景 | 验证层 | 关键断言 |
|---|---|---|
| RBAC、refresh 轮换/重用、logout | 集成 | viewer 403；旧 refresh 401 且新 access 立即失效 |
| 建群与服务重启 | 集成 | job 恢复完成；成员角色正确；外部群不重复 |
| 出站 202、504 已接收/未接收 | 集成 | 状态经过 unknown 并对账；网关最终恰好一条 |
| SSE 重复、WS 离线补齐 | 集成 | 消息只一行；seq 递增且重连得到遗漏帧 |
| Agent 中途重启 | 集成 | 同一个 run 恢复、步骤可见、完成 |
| 序列预检与并发 | 集成 | 缺值 422；并发恰好一个 201/一个 409 |
| 限流、账号终态 | 集成 | 等待后发送；排队消息取消、成员移除 |
| Gateway 与 Backend 离线 | 集成 | 重启后 SSE 历史补齐并继续触发 Agent |
| Gateway 统一用户资源 | Gateway 合同 + Playwright | 用户 CRUD、群关系、发送、管理操作和重启恢复；页面不请求旧的分类接口 |
| 媒体与 leave-all | 集成 | 下载字节可读；群主最后退群，成员清空 |
| 控制台主流程 | E2E | 登录、连接账号、建群、查看 Agent 步骤、viewer 隐藏写操作 |
| C3 Agent Run 查看 | E2E | 登录、打开群、展开 mock Agent run，核对 trace_id、步骤和结果字段；HTML 报告附截图 |

CI 执行 build、单元、模拟服务集成、综合模拟服务 E2E 和独立 C3 E2E。排查失败时保留测试输出中的 service 前缀日志及 `requestId`；集成环境的固定端口 4310–4312、综合 E2E 端口 4410–4413、C3 端口 4510–4513 需要空闲。C3 报告位于 `test-results/c3-agent-run/`，用 `npm run test:c3:report` 查看。真实外部网关账号与真实 Anthropic 账号均未被这些测试覆盖；须在具备相应服务及凭据的独立环境验证。新增需求必须补充对应失败路径断言。
