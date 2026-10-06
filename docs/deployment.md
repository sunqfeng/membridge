# 腾讯云部署

此指南针对 Linux CVM 和已有 MySQL 8.0+。没有用户服务器连接资料，本项目尚未部署到真实腾讯云。请先确认系统、内存、MySQL 版本、域名与已有反向代理。先备份现有数据库；新增专用库和用户，不修改其他业务表。

## 1. 专用数据库

在 MySQL 管理连接执行（替换密码和允许连接的来源，容器 host 网络通常通过 127.0.0.1）：

```sql
CREATE DATABASE membridge CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'membridge'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_STRONG_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON membridge.* TO 'membridge'@'127.0.0.1';
```

服务首次启动自动创建 mb_scopes、mb_memories、mb_operations，并补 search_title/search_body 生成列。迁移需要 ALTER；完成后可撤销 ALTER。保留 CREATE 供启动执行 CREATE TABLE IF NOT EXISTS。不用 root 作为应用连接。密码中的 @、:、/ 等要 URL 编码。

0.1.3 启动还会创建 mb_memories_recent(namespace,project,deleted,updated_at,id)，需要 INDEX 权限；成功建好后可以撤销 INDEX。它支持按项目和更新时间排序，LIKE 子串检索仍可能扫描整个项目，不能替代 FULLTEXT。

## 2. 配置服务与 agent

```sh
git clone https://github.com/sunqfeng/membridge.git
cd membridge
cp .env.example .env
cp deploy/agent-tokens.example.json agent-tokens.json
# 每个 agent 分别运行一次，随机值仅放入自己配置：
openssl rand -hex 32
```

编辑 .env 的 MYSQL_URL；服务端与客户端配置分开管理。agent-tokens.json 替换全部 token，占位值不能用于运行。共同 namespace/project 表示共享，令牌彼此不同。例：codex-main 可访问 shared-project/personal，claude-research 只能访问 shared-project。

每个 (namespace, agent) 必须唯一。access 可设 ro（只读）或 rw（读写删除），省略为 rw。服务端推荐使用 tokenSha256 存令牌 UTF-8 原文的 SHA-256 小写十六进制值；与 token 二选一。客户端仍持有原文。可以通过安全输入生成哈希，勿把原文写入 shell 命令历史。

容器用户 UID/GID 1000。配置文件只读挂载，并确保组 1000 可读：

```sh
sudo chown root:1000 agent-tokens.json
sudo chmod 640 agent-tokens.json
chmod 600 .env
docker compose --env-file .env -f deploy/compose.yaml up -d --build
curl --fail http://127.0.0.1:8787/health
```

compose 使用 Linux host 网络，服务仅监听 127.0.0.1，接入你现有 MySQL；不新建或重启数据库。Docker 需要支持 network_mode: host；Docker 示例未在本 Windows 环境构建。

## 3. HTTPS

使用现有 Nginx/Caddy 将 HTTPS 转发到 127.0.0.1:8787；没有反向代理时，可参考 deploy/Caddyfile，让 MEMBRIDGE_DOMAIN 指向已解析到服务器的域名。若 PORT 更改，也要改反向代理目标端口。

公网只开放必需的 HTTPS/证书验证端口，MySQL 3306 与 API 8787 不公开；SSH 按你的现有管理方式配置。客户端强制 HTTPS，只有本地测试允许 loopback HTTP。

令牌调整后重启服务加载；撤销后远端查询立即被拒绝，但已缓存的资料可能保留至 TTL/用户清理。记忆凭据不要放 Git 仓库、截图或日志。

## 4. 运维与恢复

定期备份专用数据库，测试在独立库恢复；保存 .env 和令牌配置的独立安全备份。mb_operations 是幂等回执，不能随意删除，否则失联重试可能改变语义。墓碑只保留 ID/版本，不保留删除正文；备份中的旧正文需要按你的保留策略单独处理。

初版每 agent 每分钟 120 请求、最大请求体 128KiB。小规模中文子串查询尚无大数据性能保证。出现增长压力后再测量并引入全文/向量索引；应用与数据库同机属于单点，需要更强可用性时再分离。
