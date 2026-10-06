# 同步异常

status 返回操作的 project、memory_id、kind、status，不返回正文。

- pending：网络不可用或临时故障。恢复后 sync；运行中的 MCP 每 30 秒重试一批。
- conflict：其他 agent 更新/删除该 ID。客户端优先展示未解决的本地修改，即使 refresh=true。先保留本地正文供用户审阅，经用户选择 discard_pending 后再刷新云端；也可用另一个授权客户端比较云端事实。
- blocked：认证/项目权限失败。修复权限后 sync(retryFailed=true)，保留并重试原操作。不会自动反复请求被拒绝的权限。
- rejected：输入被云端拒绝。检查限制；若服务器规则已修正，可 sync(retryFailed=true)。必须改正文时先让用户审阅原内容，明确选择 discard_pending 后重新提交。

同一记忆最多一个未确认本地操作。更新：刷新详情 → 使用相同 ID、完整新正文、来源和当前 expectedVersion → 检查 syncStatus。冲突不通过提高版本强行覆盖。

forget 本地立即隐藏并排队版本检查删除；pending 尚未从云端删除。云确认后清除正文与回执正文，保留 ID/版本墓碑防止旧客户端复活。其他 agent 的 TTL 缓存可能暂时保留内容，refresh 可刷新；备份和聊天上下文不自动清除。

缓存绑定 URL、namespace 和 agent；同身份轮换 token 保留待同步内容并清除旧已同步缓存。不同身份复用路径会拒绝启动。0.1.0 的旧缓存按项目升级指南迁移，不能直接删除。discard_pending 不刷新云端，之后调用 get_memories(refresh=true)。
