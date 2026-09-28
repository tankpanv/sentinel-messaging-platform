# Agent 控制台手动验证

在本仓库运行 `bash scripts/dev-local.sh restart`，使用 `admin/admin` 登录。Gateway 消息服务页是独立调试页，直接请求 Gateway；群组与消息页通过 Backend 管理平台群和 Agent Run。两页通过 Gateway 群 ID 对应同一个群。

1. 在「账号管理」连接至少两个服务账号，创建包含这两个账号的群。在「群组与消息」展开该群，开启 Agent，确认 Agent 列表目前为空。
2. 打开「Gateway 消息服务」，选择对应的「群组」。先在「用户」页添加一个测试用户并加入该群，然后回到「会话」，从「消息发送」用户下拉框选择它，发送 `你好，请回复我`。回到「群组与消息」，展开同一群并刷新 Agent 运行。预期出现一个新 Run，依次显示 `get_recent_messages`、`send_message`、`finish`；发送步骤审计结论为 `pass`，回复最终为 `sent`。
3. 在同一个「消息发送」下拉框选择 `acc-*` 用户发送 `服务账号测试`。预期消息进入时间线、Backend 记录 `isOwn=true`，Agent 运行数量不增加。`acc-*` 即使在群里的角色是 `member`，仍是平台托管用户。
4. 在「群组与消息」展开该群并开启自动移除。回到 Gateway 页，在「消息发送」用户下拉框选择该测试用户，发送 `spam 广告`。预期新 Run 显示 `get_recent_messages`、`kick_user`、`finish`；踢人步骤入参包含该用户的 platform ID，审计结论 `pass`，结果摘要包含 `kicked:true`。再次发送前先在「用户」页把该用户重新加入群。
5. 关闭自动移除后，再选择该用户发送 `spam 广告`。预期 Agent 仍会触发；若 Agent 调用 `kick_user`，步骤里应出现 `POLICY_DENIED`，群成员不变。
6. 用 `viewer/viewer` 登录。预期 Gateway 页没有可用发送或群管理操作，平台页没有开启 Agent 或自动移除按钮；直接调用平台写接口返回 `403 FORBIDDEN`。Gateway 调试接口是独立服务，不由平台登录权限保护。
7. 在 Agent 运行详情检查每步的 `kind`、工具名、入参、结果摘要、审计结论和错误码。自动化故障测试 `bash tests/agent/pipeline-cases.sh` 会构造坏 JSON、超时、重复 ID、未知工具等响应；其中协议错误步必须显示原始响应体（最多 2 KB）。

对应自动化覆盖：`tests/agent/contract-cases.sh` 校验 mock Agent 协议；`tests/agent/pipeline-cases.sh` 校验模拟故障、审计、幂等、重启和持久化；`scripts/integration-local.mjs` 校验 Backend→模拟 Gateway→mock Agent 的读取、回复、踢人以及权限；`scripts/e2e-local.mjs` 校验浏览器操作与步骤详情。这些用例均未验证真实外部用户或真实 LLM。
