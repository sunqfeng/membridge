# MemBridge v0.1

已确认方向：本地有效缓存优先，缓存缺失或过期查询云端，知识不足由工作 agent 研究，结构化写入本地并同步。云端为共享权威，MySQL 存储，本地 SQLite 缓存与持久待同步队列。

首版范围：REST 云服务 + 本地 stdio MCP + 共享 skill；中文片段检索；search → timeline → get_memories；按 namespace/project 授权；每 agent 独立令牌；幂等操作；乐观版本冲突；删除墓碑；脱敏；腾讯云 Docker 部署资料；GitHub 发布。

本版本通过 skill 引导显式提炼知识，不自动监听聊天文件、不自动调用付费模型。全文向量召回、推送、团队账号和 UI 不属于首版。

接口用 zod 验证。每条记忆包含 UUID、项目、标题、正文、类型、来源、证据日期、有效期、agent 作者、版本和时间。研究结论与个人偏好都要求来源；个人偏好必须来自明确表达。共享项目用稳定 slug，避免不同机器路径造成隔离。

客户端 freshness 指的是 TTL 内本地查询快照，不保证实时一致；删除在其他离线客户端可能残留至下一次云端刷新。待同步修改独立标记，云端冲突保留，不自动覆盖。无云凭据不能标记“已同步”。

命令：`bun install --frozen-lockfile`、`bun test`、`bun run typecheck`、`bun run server`、`bun run mcp`。目录：src 核心/协议、tests 行为测试、skills/membridge 共享技能、deploy 云端配置、docs 设计与归属。

验收：重启保留待同步；两个 agent 共享同项目；隔离读写；中文召回；重复上传幂等；更新版本冲突可见；墓碑防止旧客户端复活；TTL 刷新；云故障不伪装空结果；脱敏前置；MCP 协议流程；真实 MySQL 集成测试。

GitHub 默认私有，等待用户可见性选择；只发布源码、合成测试与配置样例。腾讯云部署需服务器访问资料，本次不连接或改动用户的现有数据库。
