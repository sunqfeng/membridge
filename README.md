# MemBridge

**让多个 Agent 共用你自己的云记忆。** 本地有效缓存优先，缺失/过期查询云端，研究所得先持久化到本地，再同步。

基于 [Claude-Mem](https://github.com/thedotmack/claude-mem) 的分层回忆与部分脱敏代码改造。0.1.2 是可运行的自托管原型：MySQL 云服务、SQLite 本地客户端、MCP、共享 skill。0.1.0 安装先读 [缓存升级说明](docs/upgrade-0.1.1.md)，本批改动见 [使用体验升级](docs/usability.md)。

```mermaid
flowchart LR
    A[Codex / Claude / 其他 Agent] --> B[Skill + 本地 MCP]
    B --> C[SQLite 缓存和待同步]
    B -->|HTTPS + 各自令牌| D[云记忆 API]
    D --> E[腾讯云 MySQL]
```

## 开始

Bun 1.4.2+，云端 MySQL 8.0+；本地支持 Windows/Linux，Docker 部署示例针对 Linux 腾讯云 CVM。

```sh
git clone https://github.com/sunqfeng/membridge.git
cd membridge
bun install --frozen-lockfile
bun test
bun run typecheck
```

无云配置时 `bun run mcp` 可运行本地模式，记录保存到 `~/.membridge/`、状态 pending，尚不能跨机器共享。

## 接入

按 [部署指南](docs/deployment.md) 建立独立数据库和 agent 令牌，配置 MYSQL_URL、MEMBRIDGE_TOKENS_FILE 后 `bun run server`。客户端只访问 HTTPS，MySQL 保持内网/本机访问。令牌绑定 namespace、agent、项目白名单；相同 namespace/project 才共享。

```sh
bun scripts/install-skill.ts codex
# 或 bun scripts/install-skill.ts claude
```

再按 [客户端配置](docs/clients.md) 添加本地 stdio MCP。skill 指导何时读写，MCP 执行存储；只装其中一个不能形成完整体验。安装器遇到已有 skill 会停止。

| 工具 | 功能 |
|---|---|
| search | 有效查询快照优先，再查云端；返回索引 |
| recent | 无需关键词，按项目/类型查看最近记忆 |
| get_memories | 批量详情、来源、版本，重分配正文预算；offset/nextOffset 分页 |
| timeline | 云端时间线索引 |
| remember | 本地保存并尝试同步，更新要求当前版本 |
| forget | 本地隐藏并排队云端删除 |
| sync / status | 重试 pending；retryFailed=true 重试 blocked/rejected；报告冲突 |
| discard_pending | 经用户选择丢弃本地操作，不删除云端 |
| rebase_pending | 预览本地/云端冲突；确认版本后保留本地正文重投 |

同项目用稳定 slug，例如 investment-research，不用机器路径。同事实更新复用 ID 和 version，独立事实新 ID。来源、证据日期和有效期由 agent 提供。

## 行为边界

- 队列跨重启，启动立即同步，每 30 秒重试最多 50 项；并发请求会补跑；幂等上传，冲突保留，不强行覆盖。
- TTL 默认 60 秒，最高 1 小时；refresh=true 强制查询。TTL 内不是实时一致。
- 云故障和零命中分开；旧缓存标明 stale；timeline 需要网络。
- 中文片段匹配，只查询标题和正文的生成列，分页到足够有效结果或穷尽，返回最多 30 项，按最近更新排序。引号/换行可匹配；尚无全文索引和向量语义检索，大库扫描可能较慢。
- 删除清正文与回执正文、保留墓碑；其他离线缓存、聊天上下文、用户备份不立即清除。
- 脱敏在本地及云端写入前执行，不保证覆盖所有秘密。
- 令牌支持 ro/rw（默认 rw）及服务端 tokenSha256；MCP 返回标为 untrusted_evidence，记忆包含作者 agent。
- 不自动监听私人聊天、不调用后台付费模型、不自动注入全部新聊天；通过 skill 引导显式提炼。
- 服务为单实例原型，每 agent 每分钟 120 请求，内存限流重启重置。暂无控制台、分布式限流和高可用部署。

## 验证

```sh
bun test
bun run typecheck
bun audit
# 专用临时数据库名称必须以 membridge_test 开头：
MEMBRIDGE_TEST_MYSQL_URL='mysql://test:password@127.0.0.1:3306/membridge_test' bun run test:mysql
```

覆盖中文、隔离、幂等、版本冲突、墓碑、脱敏、离线重启、跨 agent、缓存、HTTP、MCP。未配置测试 MySQL 时集成测试明确跳过；CI 使用独立 MySQL。

Apache-2.0；归属见 [NOTICE](NOTICE)，改造见 [上游说明](docs/upstream.md)。不代表 Claude-Mem 官方，未复用私有商业实现。
