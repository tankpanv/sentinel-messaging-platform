# ADR 0001：本地开发使用本机业务进程和独立 PostgreSQL 容器

## 决策

Gateway、Agent、Backend、Frontend 通过 npm 本地启动；PostgreSQL 由 `scripts/start-postgres.sh` 拉取和启动。脚本使用固定数据卷和应用账号，重复执行可恢复。

## 原因

业务服务需要断点调试和热更新，开发环境不应把代码运行在业务容器中；数据库仍需要可复现版本和隔离数据卷。
