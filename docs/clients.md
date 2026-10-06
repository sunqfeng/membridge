# 客户端安装

每个客户端安装 Bun，克隆仓库并 `bun install --frozen-lockfile`。云服务启动后，每个 agent 使用自己的令牌和相同项目 slug；namespace/项目权限由服务端令牌配置决定。

推荐先运行 `bun run doctor`（等价于 `bun src/cli.ts doctor`）。它读取当前 MEMBRIDGE_* 环境变量，检查 URL、授权连通、namespace/agent、缓存身份和 Unix 权限，输出可复制的 Codex TOML/通用 MCP JSON，自动填入本机 Bun 和 CLI 绝对路径。未指定 namespace/agent 时从令牌身份推导，已指定但不匹配则失败；失败退出码 1。

输出不含令牌：启动 Codex/其他 MCP 客户端的环境必须提供 MEMBRIDGE_TOKEN；若使用客户端私有配置保存令牌，则仅在本机加入 env.MEMBRIDGE_TOKEN。合并已有 MCP 配置，不覆盖其他服务。doctor 区分 DNS/TLS/超时/拒绝连接，并从 /health 比对版本、从 /v1/identity 展示 ro/rw。它只读诊断，不导入缓存、同步或改权限。Windows ACL 需在本机确认。没有 URL/token 是本地模式，会明确说明尚不可共享。

## Codex

运行 `bun scripts/install-skill.ts codex`，然后在你的 Codex MCP 配置中添加以下片段（合并已有配置，不覆盖）：

```toml
[mcp_servers.membridge]
command = "bun"
args = ["C:/ABSOLUTE/PATH/membridge/src/mcp.ts"]

[mcp_servers.membridge.env]
MEMBRIDGE_URL = "https://memory.example.com"
MEMBRIDGE_TOKEN = "YOUR_AGENT_TOKEN"
MEMBRIDGE_AGENT = "codex-main"
MEMBRIDGE_NAMESPACE = "owner"
MEMBRIDGE_CACHE_TTL_MS = "60000"
```

Linux 改为实际绝对路径；Bun 不在客户端 PATH 时 command 用可执行文件绝对路径。令牌配置只在本机保存。客户端设置变更后按该客户端要求重载 MCP/重启。实际桌面 UI 接入尚未在用户账户配置中操作。

## Claude Code / 其他 MCP 客户端

运行 `bun scripts/install-skill.ts claude`，在客户端 MCP 配置合并：

```json
{
  "mcpServers": {
    "membridge": {
      "command": "bun",
      "args": ["/ABSOLUTE/PATH/membridge/src/mcp.ts"],
      "env": {
        "MEMBRIDGE_URL": "https://memory.example.com",
        "MEMBRIDGE_TOKEN": "YOUR_DISTINCT_AGENT_TOKEN",
        "MEMBRIDGE_AGENT": "claude-research",
        "MEMBRIDGE_NAMESPACE": "owner"
      }
    }
  }
}
```

支持 stdio MCP 的其他 agent 使用同样进程；skill 支持取决于该 harness，不支持 skill 时手动提供项目内 SKILL.md 的工作规则。

## 首次验证

工具发现中应有 search、remember、get_memories、sync、status。让 A 在 shared-project 写一条有来源的测试发现并检查 synced；让 B 查询同项目关键词并读详情。若工具缺失、状态 pending 或 cloudStatus=unavailable，不能声称已跨 agent 共享。

缓存通常位于 `~/.membridge/<身份散列>.db`，绑定 URL/namespace/agent，与 token 无关，默认 60 秒 TTL。云模式不配置 MEMBRIDGE_NAMESPACE 时尝试自动获取；显式配置必须与令牌一致。首次网络失败或身份请求返回 408/425/429/5xx 时仍启动 MCP，未绑定时 status.namespace=null、access=unknown，记忆可本地保存为 pending；联网验证后自动绑定并同步。首次身份请求最多等待 10 秒。

首次离线创建的缓存使用 `<凭据散列>.unbound.db`，绑定后继续使用原文件，联网重启和同身份令牌轮换不会复制或丢弃队列。离线轮换仅在 URL/agent 对应唯一已绑定缓存时复用；存在多个身份时请显式配置 namespace 和缓存路径。云端身份必须与缓存绑定一致才能上传。令牌轮换清除旧已同步缓存，保留 outbox。本地模式 namespace 默认 owner。旧版迁移见 [升级说明](upgrade-0.1.4.md)。

身份验证请求合并并发调用，临时失败后退避 5 秒；remember 不会在同一次写入中重复等待验证超时。启动和每 30 秒后台同步遵守退避，手动 sync 可立即尝试恢复。401/403 不会降级为首次未绑定模式。可恢复云故障与搜索零命中仍分别返回。

MEMBRIDGE_CACHE_PATH 可指定绝对文件路径。新建私人子目录为 700，DB/WAL/SHM 为 600；现有目录不自动 chmod，Unix 上权限过松或不归当前用户所有则拒绝。不要把缓存直接放在共有目录；可指定其中一个新私人子目录。Windows 依赖用户目录 ACL。缓存未经加密。已同步缓存最多 1000 条/30 天，查询快照最多 500 条/1 天；待同步数据不淘汰。

ro 凭据的 remember/forget/确认 rebase 会在改缓存或入队前失败。首次离线尚未验证权限时，本地写入可为 pending，access=unknown，不能声称已共享；已有待同步内容不会因切换为 ro 被丢弃。

personal 只是独立项目名，不自动授予全 agent；只给需要个人偏好的 agent 权限。假设与草稿不能仅因为工具允许写入就自动公开给其他 agent。
