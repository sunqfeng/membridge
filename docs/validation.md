# 首版验证

日期：2026-10-06。Windows、Bun 1.4.2、TypeScript 6.0.3，独立本地 MySQL Community 8.4.9。

通过 8 项行为测试，包括实际 MySQL、实际 HTTP 与实际 stdio MCP 子进程：中文检索、项目/namespace 隔离、身份权限、幂等回执、并发版本检查、删除墓碑与重放、有效期、字符转义、脱敏、离线跨重启队列、跨 agent 共享、TTL 刷新、冲突保留。

`bun run typecheck`、`bun audit`、skill-creator 的 quick_validate.py 通过；审计当前锁文件未发现已报告漏洞。此结果不保证代码没有安全缺陷。

测试数据库为隔离 membridge_test；没有连接用户腾讯云或现有 MySQL。Docker 文件已提供，当前机器没有 Docker，未构建容器。Linux CI 配置待 GitHub 运行确认。

客户端账户 MCP/skill 配置未自动改动；实际 Codex/Claude UI 接入仍需按 docs/clients.md 配置并验证。未验证大规模搜索性能、跨地域延迟、高可用和自动 hook 采集。
