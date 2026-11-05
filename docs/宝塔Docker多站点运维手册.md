# 宝塔 Docker 多站点部署与运维手册

> 项目：`beishan-mall` 多租户商城系统
> 服务器：`[服务器标识已脱敏]`
> 手册版本：v3（对应更新脚本 V3）
> 更新日期：2026-11-05

---

## 零、一分钟速查

| 我要做什么 | 命令 |
|---|---|
| 更新所有站点 | `bash /root/update-beishan.sh` |
| 看站点是否正常 | `docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'` |
| 看某个站点日志 | `docker logs -f --tail 50 mall-tanhui` |
| 重启某个站点 | `docker restart mall-tanhui` |
| 回滚到上一版本 | 见第六节 |
| 从备份恢复数据 | 见第七节 |

**最常用的一条：改完源码后跑 `bash /root/update-beishan.sh`，别的都不用管。**

---

## 一、系统概览

一套 `beishan-mall` 镜像，通过「一容器一站点」的方式跑多个独立商城。每个站点的数据完全隔离，互不影响。

| 站点 | 容器名 | 端口映射 | 数据目录（宿主机） |
|---|---|---|---|
| 富闽商贸城 | `mall-fumin` | `32771 → 3300` | `/www/wwwroot/beishan-mall-main/data` |
| 探汇商城 | `mall-tanhui` | `32769 → 3300` | `/www/wwwroot/beishan/sites/tanhui` |

**镜像**：`beishan-mall:latest` —— 本地构建的镜像，**不存在于任何远程仓库**

**源码目录**：`/www/wwwroot/beishan-mall-main/`（含 `Dockerfile`、`docker-compose.yml`、`server/`、`h5/`、`admin/`、`shared/`、`scripts/`）

**更新脚本**：`/root/update-beishan.sh`（V3）

> ⚠️ `docker pull beishan-mall:latest` 一定失败，报 `pull access denied … repository does not exist`。这个镜像从来没有被推到仓库，只存在于本机。更新只能靠 `docker build` 重新构建。

---

## 二、应用的关键参数

新建站点时照抄这些环境变量，只改端口和挂载路径。

| 变量 | 值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `3300` | 容器内端口，**不要改**，改宿主机映射端口即可 |
| `NODE_ENV` | `production` | 生产模式 |
| `TZ` | `Asia/Shanghai` | **必须保留**，丢了订单时间会变 UTC，差 8 小时 |
| `MALL_DB` | `/app/data/mall.db` | SQLite 数据库路径 |
| `UPLOAD_DIR` | `/app/data/uploads` | 用户上传目录（商品图等） |
| `PUBLIC_DIR` | `/app/public` | 前端静态资源目录 |
| `ADMIN_USER` | `site_admin` | 内置管理员账号 |
| `ADMIN_PASSWORD` | `CHANGE_ME_TO_A_STRONG_PASSWORD` | 内置管理员密码，**建议尽快修改** |
| `JWT_SECRET` | `CHANGE_ME_TO_A_UNIQUE_RANDOM_SECRET` | 登录令牌签名密钥，**建议每站独立设置** |
| `ADMIN_PASSWORD_RESET` | `0` | 设为 `1` 重启可强制重置密码，用完改回 `0` |

### 两个反直觉的规矩

**① `/app/public` 绝对不能挂载。**
它只是镜像内的前端静态资源（`h5` + `admin` 两个目录），本来就该随镜像更新。一旦挂载宿主机目录，新版本的前端会被旧文件盖住，结果就是「后端更新了、页面还是旧的」。之前排查问题时差点踩这个坑。

**② 真正的用户数据只有两处：** `/app/data/mall.db*` 和 `/app/data/uploads/`。全部通过 `/app/data` 这一个挂载点暴露，所以只要挂好这一个目录，数据就完整。

**健康检查**：镜像内置 `healthcheck`，每 30 秒请求一次 `http://127.0.0.1:3300/api/health`。`docker ps` 里的 `(healthy)` 就是它给的结论，这是判断站点是否正常的**最可靠依据**。

---

## 三、数据架构

每个站点的 `/app/data` 挂载到独立的宿主机目录，结构如下：

```
data/
├── mall.db          SQLite 主库
├── mall.db-wal      WAL 日志（写前日志）
├── mall.db-shm      共享内存索引
├── uploads/         用户上传文件（商品图等）
└── backup/          应用自带的定时备份
```

### SQLite 的三条铁律

**① WAL 模式下，主库文件可能是过期的。**
`mall.db` 只有 434KB，而 `mall.db-wal` 有 3.8MB——最新数据全在 WAL 里。**迁移或备份时必须 db + wal + shm 三个文件一起动**，单独拷 `mall.db` 会拿到几天前的数据，而且毫无报错提示。

**② 绝不能让两个容器同时挂载同一个数据目录。**
两个进程并发写同一个 SQLite 文件会直接损坏数据库。所以重建容器前必须先停旧的，顺序不能反。脚本里做的就是「先 stop，再 rm，再 run」。

**③ WAL 需要定期整理。**
如果 `mall.db-wal` 长期是主库的 8 倍以上，说明 checkpoint 没生效（通常有长事务占用读锁）。低峰期手动整理：

```bash
sqlite3 /www/wwwroot/beishan/sites/tanhui/mall.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

---

## 四、部署方式

因为宝塔面板的 compose 模板编辑器会丢失 YAML 缩进（实测反复踩坑），最终采用 `docker run` 单行命令部署，配合更新脚本统一管理。

### 富闽商贸城

```bash
docker run -d --name mall-fumin --restart unless-stopped -p 32771:3300 -v /www/wwwroot/beishan-mall-main/data:/app/data -e HOST=0.0.0.0 -e PORT=3300 -e NODE_ENV=production -e TZ=Asia/Shanghai -e MALL_DB=/app/data/mall.db -e UPLOAD_DIR=/app/data/uploads -e PUBLIC_DIR=/app/public -e ADMIN_USER=site_admin -e ADMIN_PASSWORD=CHANGE_ME_TO_A_STRONG_PASSWORD -e JWT_SECRET=CHANGE_ME_TO_A_UNIQUE_RANDOM_SECRET beishan-mall:latest
```

### 探汇商城

```bash
docker run -d --name mall-tanhui --restart unless-stopped -p 32769:3300 -v /www/wwwroot/beishan/sites/tanhui:/app/data -e HOST=0.0.0.0 -e PORT=3300 -e NODE_ENV=production -e TZ=Asia/Shanghai -e MALL_DB=/app/data/mall.db -e UPLOAD_DIR=/app/data/uploads -e PUBLIC_DIR=/app/public -e ADMIN_USER=site_admin -e ADMIN_PASSWORD=CHANGE_ME_TO_A_STRONG_PASSWORD -e JWT_SECRET=CHANGE_ME_TO_A_UNIQUE_RANDOM_SECRET beishan-mall:latest
```

### 新增站点（三步）

**第一步：建数据目录**

```bash
mkdir -p /www/wwwroot/beishan/sites/站点名
```

**第二步：改脚本的 `SITES` 变量**

编辑 `/root/update-beishan.sh`，在里面加一行（格式：`容器名:端口:数据目录`）：

```
SITES="mall-fumin:32771:/www/wwwroot/beishan-mall-main/data
mall-tanhui:32769:/www/wwwroot/beishan/sites/tanhui
mall-xinhuo:32770:/www/wwwroot/beishan/sites/xinhuo"
```

**第三步：启动一次**

```bash
docker run -d --name mall-xinhuo --restart unless-stopped -p 32770:3300 -v /www/wwwroot/beishan/sites/xinhuo:/app/data -e HOST=0.0.0.0 -e PORT=3300 -e NODE_ENV=production -e TZ=Asia/Shanghai -e MALL_DB=/app/data/mall.db -e UPLOAD_DIR=/app/data/uploads -e PUBLIC_DIR=/app/public -e ADMIN_USER=site_admin -e ADMIN_PASSWORD=CHANGE_ME_TO_A_STRONG_PASSWORD -e JWT_SECRET=独立密钥 beishan-mall:latest
```

空目录启动时会自动初始化一份新数据库，进后台从头配置即可。**新站点建议配独立的 `JWT_SECRET`**，避免和别的站点共用。

> 以后加站点，只要脚本的 `SITES` 里有它，`bash /root/update-beishan.sh` 就会自动带上它一起更新。

---

## 五、日常更新（核心流程）

### 标准操作：三步

```
① 上传新源码，覆盖到 /www/wwwroot/beishan-mall-main/
② bash /root/update-beishan.sh
③ 浏览器 Ctrl + F5，进后台验收
```

**不需要手动 `docker build`**——脚本第 2 步就是构建，重复构建只是浪费时间。

### 源码怎么传

项目目录**不是 git 仓库**（没有 `.git`），所以代码靠上传覆盖。用宝塔「文件」管理器：

| 要覆盖 | 千万不要动 |
|---|---|
| `server/` `h5/` `admin/` `shared/` | `data/` ← 富闽的数据库 |
| `package.json` `package-lock.json` | `.env` ← 服务器上的实际配置 |
| `Dockerfile` `.dockerignore` | `scripts/` ← 除非新版明确要求 |

传完扫一眼时间戳，确认真的传上去了：

```bash
ls -la /www/wwwroot/beishan-mall-main/server/
```

### 脚本做了什么（V3 完整流程）

| 步骤 | 动作 | 说明 |
|---|---|---|
| 1/5 | 记录当前镜像 ID，打 `beishan-mall:prev` 标签 | 回滚用的退路 |
| 2/5 | `cd 源码目录` → `docker build -t beishan-mall:latest .` | 通常 2–5 分钟 |
| — | 对比新旧镜像 ID | **相同则直接退出，站点不停机** |
| 3/5 | 停两个容器 → 数据打包到 `/root/mall-backup/` → 清理 7 天前的备份 | 一致性快照 |
| 4/5 | 用新镜像重建两个容器 | 自动带上所有站点 |
| 5/5 | 每 5 秒轮询健康状态，最长 150 秒 | 任一不是 `healthy` → **自动回滚到 `prev`** |

**时间成本**：构建 2–5 分钟（站点照常运行）+ 切换 10–15 秒（短暂中断）。

### 跑的时候怎么看

```
==> 1/5 记录当前版本
    beishan-mall:latest = sha256:4a4977f53a80...
==> 2/5 从源码构建（通常 2-5 分钟）
...
    新镜像 = sha256:xxxxxxx...
==> 3/5 停容器并备份数据
    /root/mall-backup/mall-fumin-20261105-142800.tgz  (2.1M)
==> 4/5 用新镜像重建容器
==> 5/5 等待健康检查（最长 150 秒）
    mall-fumin  ->  healthy
    mall-tanhui  ->  healthy
```

**关键判断点：**
- 第 1 步和第 2 步的镜像 ID **不一样** = 代码确实进镜像了
- 两个 ID **一样** = 源码没变化（多半是上传失败或传错目录），脚本会自动跳过
- 最后两个 `healthy` = 成功

### 构建失败怎么办

脚本有 `set -euo pipefail` + `trap ERR`：**构建阶段失败时，旧容器根本没被删，站点继续正常运行**。修复源码后重跑即可。

只有「容器已替换但起不来」才会触发自动回滚——那时脚本会用 `beishan-mall:prev` 把站点拉回来。

---

## 六、回滚

### 情况一：脚本已自动回滚

看输出最后有 `!! 出错了，正在回滚到 beishan-mall:prev` 就是自动回滚了。站点此时跑的是上一版本，可用状态。

修复问题后重跑脚本即可。

### 情况二：手动回滚（脚本跑完才发现问题）

**不要用脚本回滚**——脚本会重新构建，把 `prev` 也覆盖成新版本，等于白回滚。直接手动换镜像：

```bash
docker rm -f mall-fumin mall-tanhui

ENVS="-e HOST=0.0.0.0 -e PORT=3300 -e NODE_ENV=production -e TZ=Asia/Shanghai -e MALL_DB=/app/data/mall.db -e UPLOAD_DIR=/app/data/uploads -e PUBLIC_DIR=/app/public -e ADMIN_USER=site_admin -e ADMIN_PASSWORD=CHANGE_ME_TO_A_STRONG_PASSWORD -e JWT_SECRET=CHANGE_ME_TO_A_UNIQUE_RANDOM_SECRET"

docker run -d --name mall-fumin --restart unless-stopped -p 32771:3300 \
  -v /www/wwwroot/beishan-mall-main/data:/app/data $ENVS beishan-mall:prev

docker run -d --name mall-tanhui --restart unless-stopped -p 32769:3300 \
  -v /www/wwwroot/beishan/sites/tanhui:/app/data $ENVS beishan-mall:prev
```

注意最后是 `beishan-mall:prev` 而不是 `latest`。**回滚只换镜像，不动数据。**

### 情况三：数据也要退回去

如果新版本跑过数据库迁移、把表结构改坏了，光回滚镜像不够，还要回滚数据：

```bash
# 1. 停容器
docker stop mall-fumin mall-tanhui

# 2. 先把当前数据挪开（别直接删，可能还要分析）
mv /www/wwwroot/beishan/sites/tanhui /www/wwwroot/beishan/sites/tanhui.bad

# 3. 从备份还原
mkdir -p /www/wwwroot/beishan/sites/tanhui
tar xzf /root/mall-backup/mall-tanhui-20261105-142800.tgz -C /www/wwwroot/beishan/sites/tanhui

# 4. 用 prev 镜像启动
docker rm -f mall-tanhui
docker run -d --name mall-tanhui --restart unless-stopped -p 32769:3300 \
  -v /www/wwwroot/beishan/sites/tanhui:/app/data $ENVS beishan-mall:prev
```

备份文件名带时间戳，挑更新前的那个（`ls -lt /root/mall-backup/` 按时间排序）。

---

## 七、备份与恢复

### 自动备份

每次跑更新脚本都会自动备份到 `/root/mall-backup/`，文件名格式 `mall-站点名-YYYYMMDD-HHMMSS.tgz`，自动保留 7 天。

**注意：只在跑更新脚本时才备份。** 平时不会自动备份，所以还需要下面的定时备份。

### 定时备份（推荐配置）

宝塔 → 计划任务 → 添加 → 类型「Shell 脚本」→ 每天凌晨 3 点：

```bash
#!/bin/bash
D=$(date +%F)
docker stop mall-fumin mall-tanhui
mkdir -p /www/backup
tar czf /www/backup/beishan-$D.tgz -C /www/wwwroot \
  beishan-mall-main/data beishan/sites/tanhui
docker start mall-fumin mall-tanhui
find /www/backup -name 'beishan-*.tgz' -mtime +14 -delete
```

先停容器再打包，保证 WAL 已落盘、数据一致。全程只停几秒钟。

### 手动备份单个站点

```bash
docker stop mall-tanhui
tar czf /root/backup-tanhui-$(date +%F).tgz -C /www/wwwroot/beishan/sites tanhui
docker start mall-tanhui
ls -lh /root/backup-tanhui-*.tgz
```

### 从备份恢复

```bash
# 停容器
docker stop mall-tanhui

# 当前数据先挪开，不直接删
mv /www/wwwroot/beishan/sites/tanhui /www/wwwroot/beishan/sites/tanhui.broken

# 解包还原
mkdir -p /www/wwwroot/beishan/sites/tanhui
tar xzf /root/backup-tanhui-2026-11-05.tgz -C /www/wwwroot/beishan/sites/tanhui

# 核对文件齐全
ls -la /www/wwwroot/beishan/sites/tanhui

# 启动
docker start mall-tanhui
```

`ls` 那步必须看到 `mall.db`、`mall.db-wal`、`uploads/` 三个都在再启动。

---

## 八、日常检查

### 每天看一眼（10 秒）

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

两个都 `Up (healthy)` 就是正常。出现 `Restarting`、`Exited`、`unhealthy` 就要处理。

### 每周看一眼

```bash
# 磁盘占用
docker system df
df -h /

# 数据目录体积（涨太快说明 uploads 在膨胀）
du -sh /www/wwwroot/beishan-mall-main/data /www/wwwroot/beishan/sites/tanhui

# 备份是否在正常生成
ls -lt /root/mall-backup/ | head -5
```

### 查看详情

```bash
# 实时日志
docker logs -f --tail 50 mall-tanhui

# 确认挂载对不对
docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' mall-tanhui

# 确认容器内能看到数据文件
docker exec mall-tanhui ls -la /app/data

# 确认容器用的是哪个镜像
docker inspect -f '{{.Config.Image}} / {{.Image}}' mall-tanhui
```

---

## 九、故障排查

| 现象 | 排查方向 |
|---|---|
| 容器 `Restarting` / `Exited` | `docker logs --tail 50 容器名` 看报错 |
| 报 `port is already allocated` | 有容器占着端口，`docker ps` 查出后 `docker stop` 停掉 |
| 页面能打开但数据是空的 | 挂载路径错了，用 `docker inspect -f '{{range .Mounts}}...'` 确认 |
| 报 `database is locked` | 多个容器挂了同一目录，或旧容器没停干净 |
| 权限报错 | `chown -R 1000:1000 数据目录` |
| 商品图片 404 | `uploads/` 没挂上，检查 `/app/data/uploads` 是否存在 |
| 后台登录不了 | 环境变量缺 `ADMIN_USER` / `ADMIN_PASSWORD` |
| 订单时间是 UTC | 环境变量缺 `TZ=Asia/Shanghai` |
| 更新后前端还是旧界面 | 浏览器缓存，`Ctrl + F5`；仍不行则检查 `.dockerignore` 是否排除了 `h5/`、`admin/` |
| 脚本报 `pull access denied` | 用了旧版（V1）脚本，需换成 V3 |
| 脚本说「源码无变更，跳过重建」 | 源码没传上去，检查目录时间戳 |
| 构建成功但健康检查失败 | 脚本会自动回滚；看 `docker logs` 确认新版本问题 |

---

## 十、历史复盘

### 10.1 根因：为什么一个站点不更新

**现象**：两个站点用同一套镜像，富闽能正常更新代码，探汇始终不更新。

**原因**：探汇的容器创建时，镜像字段记录的不是标签，而是镜像 ID。

| 容器 | 镜像字段 | 结果 |
|---|---|---|
| 富闽 | `beishan-mall:latest` | 跟随标签，重建容器即用上新代码 |
| 探汇 | `sha256:b242d08287…` | 固化在某个镜像快照上，永远不变 |

`docker build -t xxx:latest .` 只是把新构建的镜像挂到标签上，正在运行的容器不会自动切换。而容器一旦用 image ID 引用镜像，连重建都不会变——它压根不知道有标签这回事。原标签被移走后，旧镜像变成 `<none>` 悬空镜像，面板的「更新」按钮也找不到可拉取的仓库名，所以点了没反应。

**教训**：
- 容器必须用**标签**引用镜像，不能是 ID 或摘要
- 出现 `sha256:...` 的镜像字段，说明创建方式有问题（`docker run $(docker images -q xxx)`、面板锁定版本、或先起容器后打标签）
- 多站点必须统一管理方式，散装 `docker run` 迟早和标签漂移脱钩

### 10.2 事故：误删容器后如何无损恢复

迁移过程中误删了探汇容器，最终数据完整恢复。

**数据为什么没丢**：`docker rm` 默认不删数据卷。探汇的数据当时挂在一个匿名卷上：

```
卷名：8107e9f1df616b8a3f8525ce1456060fb070f7813d583856b8a2375bb1c760f7
挂载：/var/lib/docker/volumes/8107e9f1.../_data  →  /app/data
```

容器没了，卷还在。恢复步骤：

```bash
# 1. 确认卷是否存在
docker volume inspect 8107e9f1df616b8a3f8525ce1456060fb070f7813d583856b8a2375bb1c760f7

# 2. 直接看卷内容（不需要启动容器）
ls -la /var/lib/docker/volumes/8107e9f1df616b8a3f8525ce1456060fb070f7813d583856b8a2375bb1c760f7/_data

# 3. 整目录备份
docker run --rm -v 8107e9f1df61...:/data -v /root:/backup \
  alpine tar czf /backup/probehui-data.tgz -C /data .

# 4. 迁移到宿主机目录
mkdir -p /www/wwwroot/beishan/sites/tanhui
docker run --rm -v 8107e9f1df61...:/from \
  -v /www/wwwroot/beishan/sites/tanhui:/to alpine sh -c 'cp -a /from/. /to/'

# 5. 用新容器挂载这个宿主机目录（见第四节）
```

**关键教训**：
- **删除容器时绝对不要勾「同时删除关联数据卷」**，那是唯一会真正丢数据的操作
- 不要执行 `docker volume prune` / `docker system prune`，会清掉悬空卷
- 迁移前先备份，备份文件留在 `/root/` 下别急着删

---

## 十一、待办与优化建议

按优先级排列，不影响当前运行：

1. **修改默认密码和密钥**（安全，优先）
   - `ADMIN_PASSWORD` 目前是 `CHANGE_ME_TO_A_STRONG_PASSWORD`，两个站点共用
   - `JWT_SECRET` 是默认值 `CHANGE_ME_TO_A_UNIQUE_RANDOM_SECRET`，两站共用意味着令牌可跨站使用
   - 建议给探汇配独立的 `JWT_SECRET` 和强密码，改完重建容器即可，不影响数据

2. **绑定域名 + Nginx 反向代理**（体验）
   - 目前是 `IP:32769` 裸端口访问，站点一多就乱
   - 宝塔「网站 → 添加站点」→「反向代理」指向 `http://127.0.0.1:32769`
   - 配好后可删掉宝塔「安全」里的 32769/32771 放行规则，只留 443

3. **启用定时备份**（数据安全）
   - 按第七节的脚本配到宝塔计划任务

4. **清理废旧资源**（整洁）
   - 旧匿名卷 `8107e9f1df61…` 确认不再需要后可删
   - `/root/probehui-data.tgz`、`/opt/probehui/data` 保留一段时间再清

5. **监控 WAL 增长**（稳定性）
   - 当前 `mall.db-wal` 约为主库的 8 倍，偏大
   - 排查是否有长事务占用读锁，必要时手动 checkpoint

---

## 附录 A：更新脚本全文

路径：`/root/update-beishan.sh`（V3）

```bash
#!/bin/bash
set -euo pipefail

SRC="/www/wwwroot/beishan-mall-main"
IMG="beishan-mall:latest"
PREV="beishan-mall:prev"
BK="/root/mall-backup"
STAMP=$(date +%Y%m%d-%H%M%S)

ENVS="-e HOST=0.0.0.0 -e PORT=3300 -e NODE_ENV=production -e TZ=Asia/Shanghai -e MALL_DB=/app/data/mall.db -e UPLOAD_DIR=/app/data/uploads -e PUBLIC_DIR=/app/public -e ADMIN_USER=site_admin -e ADMIN_PASSWORD=CHANGE_ME_TO_A_STRONG_PASSWORD -e JWT_SECRET=CHANGE_ME_TO_A_UNIQUE_RANDOM_SECRET"

SITES="mall-fumin:32771:/www/wwwroot/beishan-mall-main/data
mall-tanhui:32769:/www/wwwroot/beishan/sites/tanhui"

run_sites() {
  local img="$1"
  while IFS=':' read -r name port dir; do
    [ -z "$name" ] && continue
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" --restart unless-stopped \
      -p "$port":3300 -v "$dir":/app/data $ENVS "$img" >/dev/null
    echo "    $name  <-  $img  ($port)"
  done <<< "$SITES"
}

health_of() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing
}

rollback() {
  echo ""
  echo "!! 出错了，正在回滚到 $PREV"
  run_sites "$PREV" || true
  echo ""
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
  exit 1
}
trap rollback ERR

echo "==> 1/5 记录当前版本"
OLD_ID=$(docker image inspect -f '{{.Id}}' "$IMG" 2>/dev/null || echo none)
docker tag "$IMG" "$PREV" 2>/dev/null || true
echo "    $IMG = ${OLD_ID:0:19}"

echo "==> 2/5 从源码构建（通常 2-5 分钟）"
cd "$SRC"
docker build -t "$IMG" .

NEW_ID=$(docker image inspect -f '{{.Id}}' "$IMG")
if [ "$OLD_ID" = "$NEW_ID" ]; then
  echo "    源码无变更，镜像未更新，跳过重建。站点保持运行。"
  trap - ERR
  exit 0
fi
echo "    新镜像 = ${NEW_ID:0:19}"

echo "==> 3/5 停容器并备份数据"
mkdir -p "$BK"
while IFS=':' read -r name port dir; do
  [ -z "$name" ] && continue
  docker stop "$name" >/dev/null 2>&1 || true
  tar czf "$BK/$name-$STAMP.tgz" -C "$dir" .
  echo "    $BK/$name-$STAMP.tgz  ($(du -h "$BK/$name-$STAMP.tgz" | cut -f1))"
done <<< "$SITES"
find "$BK" -name '*.tgz' -mtime +7 -delete 2>/dev/null || true

echo "==> 4/5 用新镜像重建容器"
run_sites "$IMG"

echo "==> 5/5 等待健康检查（最长 150 秒）"
for i in $(seq 1 30); do
  allok=1
  while IFS=':' read -r name port dir; do
    [ -z "$name" ] && continue
    [ "$(health_of "$name")" = "healthy" ] || allok=0
  done <<< "$SITES"
  [ "$allok" = "1" ] && break
  sleep 5
done

failed=0
while IFS=':' read -r name port dir; do
  [ -z "$name" ] && continue
  st=$(health_of "$name")
  [ "$st" = "healthy" ] || failed=1
  echo "    $name  ->  $st"
done <<< "$SITES"

if [ "$failed" = "1" ]; then
  rollback
fi

trap - ERR
echo ""
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo ""
echo "更新完成。备份在 $BK/*-$STAMP.tgz"
echo "手动回滚：docker rm -f mall-fumin mall-tanhui 后用 $PREV 重新 docker run"
```

### 脚本里三个可改的地方

| 位置 | 变量 | 用途 |
|---|---|---|
| 顶部 | `SRC` | 源码目录，换项目时改这里 |
| 顶部 | `ENVS` | 环境变量，改密码/密钥时改这里 |
| 中部 | `SITES` | 站点清单，格式 `容器名:端口:数据目录`，加站点在这里加一行 |

改完保存即可，不用重新安装。

### 检查脚本版本

```bash
head -2 /root/update-beishan.sh
```

第二行是 `set -euo pipefail` = V3；如果是 `set -e` = V2（缺少备份和自动回滚）。

---

## 附录 B：命令速查

```bash
# ===== 状态 =====
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker images | grep beishan-mall

# ===== 启停 =====
docker stop mall-tanhui
docker start mall-tanhui
docker restart mall-tanhui

# ===== 日志与排障 =====
docker logs -f --tail 50 mall-tanhui
docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' mall-tanhui
docker inspect -f '{{.Config.Image}} / {{.Image}}' mall-tanhui
docker exec -it mall-tanhui sh
docker exec mall-tanhui ls -la /app/data

# ===== 更新 =====
bash /root/update-beishan.sh

# ===== 手动构建（不用脚本时）=====
cd /www/wwwroot/beishan-mall-main
docker build -t beishan-mall:latest .

# ===== 备份 =====
docker stop mall-tanhui
tar czf /root/backup-tanhui-$(date +%F).tgz -C /www/wwwroot/beishan/sites tanhui
docker start mall-tanhui

# ===== 磁盘 =====
docker system df
df -h /
du -sh /www/wwwroot/beishan-mall-main/data /www/wwwroot/beishan/sites/tanhui
```

---

*文档结束 · 最后更新 2026-11-05*
