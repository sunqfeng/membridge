# 客户端安装

每个客户端安装 Bun，克隆仓库并 `bun install --frozen-lockfile`。云服务启动后，每个 agent 使用自己的令牌和相同项目 slug；namespace/项目权限由服务端令牌配置决定。

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
        "MEMBRIDGE_AGENT": "claude-research"
      }
    }
  }
}
```

支持 stdio MCP 的其他 agent 使用同样进程；skill 支持取决于该 harness，不支持 skill 时手动提供项目内 SKILL.md 的工作规则。

## 首次验证

工具发现中应有 search、remember、get_memories、sync、status。让 A 在 shared-project 写一条有来源的测试发现并检查 synced；让 B 查询同项目关键词并读详情。若工具缺失、状态 pending 或 cloudStatus=unavailable，不能声称已跨 agent 共享。

缓存默认 `~/.membridge/<身份散列>.db`，绑定 URL/token/agent，默认 60 秒 TTL。可用 MEMBRIDGE_CACHE_PATH 指定绝对文件路径，同身份的多个会话可复用；不同凭据不共用路径。缓存未经加密，依赖 OS 文件权限，磁盘加密由用户环境管理。

personal 只是独立项目名，不自动授予全 agent；只给需要个人偏好的 agent 权限。假设与草稿不能仅因为工具允许写入就自动公开给其他 agent。
