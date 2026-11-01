# Docker 运维手册（构建 / 更新 / 备份 / 排查）

面向在服务器上用 Docker 跑这套商城的人。所有命令都可以直接复制执行，
涉及路径和容器名的地方按实际情况替换。

---

## 0. 一句话记住三件事

1. **代码在镜像里，容器只是运行镜像** —— 更新代码必须重新构建镜像并重建容器。
2. **数据在挂载里，不在容器里** —— 只要挂载参数不变，删容器、重建容器都不影响数据。
3. **构建完先验镜像版本，再动容器** —— 九成的"更新了没生效"是镜像里本来就是旧代码。

---

## 1. 日常发版（最常用）

### 1.1 标准流程

```bash
cd /www/wwwroot/beishan-mall-main      # 源码目录（有 Dockerfile 的那层）

# ① 更新源码
git pull                                # 不是 git 仓库时改为上传/解压覆盖
grep '"version"' h5/package.json        # 记下版本号，后面用来核对

# ② 构建
docker build -t beishan-mall:latest .

# ③ 验证镜像内容（关键，别跳过）
docker run --rm beishan-mall:latest \
  sh -c "grep -o 'V2\.[0-9]*' /app/public/h5/assets/index-*.js | head -1"
```

第 ③ 步输出应当与第 ① 步 `package.json` 里的版本对应（`2.13.0` → `V2.13`）。

- **对得上** → 继续第 ④ 步重建容器
- **对不上** → 源码没更新或构建用错目录，**先解决这个**，重建容器没有任何意义

### 1.2 重建容器

容器创建时就把镜像 ID 钉死了，之后 build 出新镜像它不会自动跟着变，
**重启也没用**，必须删掉重建。

两个站都要重建，下面的循环会自动沿用各自的端口和挂载，不需要手填：

```bash
for N in beishan-mall fixikang; do
  HP=$(docker inspect -f '{{range $p,$c := .NetworkSettings.Ports}}{{if eq $p "3300/tcp"}}{{range $c}}{{.HostPort}}{{end}}{{end}}{{end}}' $N)
  DV=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' $N)
  echo "== $N  端口 $HP  数据 $DV"
  docker stop $N && docker rename $N "${N}_old$(date +%m%d%H%M)"
  docker run -d --name $N --restart unless-stopped -p $HP:3300 -v $DV:/app/data \
    -e TZ=Asia/Shanghai beishan-mall:latest
done
```

### 1.3 验证

```bash
for N in beishan-mall fixikang; do
  echo -n "$N 容器内版本: "
  docker exec $N sh -c "grep -o 'V2\.[0-9]*' /app/public/h5/assets/index-*.js | head -1"
done
```

再打开两个站的首页，滚到底部看版号，与上面一致即部署成功。

### 1.4 用脚本代替手敲（推荐）

仓库里带了 `scripts/deploy.sh`：

```bash
bash scripts/deploy.sh beishan-mall fixikang      # 构建 + 校验 + 重建 + 回读版本
bash scripts/deploy.sh --dry-run beishan-mall     # 只预览会做什么
SKIP_BUILD=1 bash scripts/deploy.sh fixikang      # 跳过构建，用现有镜像重建
```

它做了四件事：构建 → **校验镜像版本**（不对就停）→ 逐容器读端口和挂载后重建 →
回读新容器版本与数据库文件大小，并打印回滚命令。

---

## 2. 挂载与数据安全

### 2.1 三种挂载，安全等级完全不同

| 写法 | 类型 | 删除容器时 |
|---|---|---|
| `-v /www/xxx/data:/app/data` | 宿主机目录 | **绝对安全**，Docker 碰不到 |
| `-v myname:/app/data` | 具名卷 | 安全，只有手动 `docker volume rm` 才删 |
| `-v /app/data`（不给源） | 匿名卷 | **危险**：`docker rm -v` 或面板勾选"删除数据卷"时一起删掉 |

**正式在用的站点请一律使用宿主机目录**。匿名卷只适合临时试跑。

容器里唯一需要持久化的目录是 `/app/data`，包含：

```
/app/data/mall.db      SQLite 数据库（会员、订单、商品、资金流水全在这）
/app/data/uploads/     上传的图片
```

### 2.2 查看某个容器挂在哪

```bash
docker inspect -f '{{range .Mounts}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}}{{"\n"}}{{end}}' 容器名
```

### 2.3 把匿名卷迁移到宿主机目录

```bash
# ① 备份
mkdir -p /www/wwwroot/backup
docker run --rm -v 匿名卷ID:/d -v /www/wwwroot/backup:/b \
  alpine tar czf /b/before-migrate.tgz -C /d .

# ② 复制到宿主目录
mkdir -p /www/wwwroot/fixikang/data
docker run --rm -v 匿名卷ID:/from -v /www/wwwroot/fixikang/data:/to \
  alpine sh -c "cp -av /from/. /to/"

# ③ 停旧容器（先别删，留作回滚）
docker stop 容器名 && docker rename 容器名 容器名_volbak

# ④ 用宿主机目录重建
docker run -d --name 容器名 --restart unless-stopped \
  -p 宿主机端口:3300 \
  -v /www/wwwroot/fixikang/data:/app/data \
  -e TZ=Asia/Shanghai beishan-mall:latest

# ⑤ 验证数据接上了
docker exec 容器名 node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/mall.db');console.log('订单数',d.prepare('select count(*) c from orders').get().c)"

# 回滚（验证不通过时）
docker rm -f 容器名 && docker rename 容器名_volbak 容器名 && docker start 容器名
```

---

## 3. 备份与恢复

### 3.1 备份

```bash
mkdir -p /www/wwwroot/backup

# 宿主机目录（推荐）
tar czf /www/wwwroot/backup/site-$(date +%m%d-%H%M).tgz \
  -C /www/wwwroot/fixikang/data .

# 命名卷
docker run --rm -v 卷名:/d -v /www/wwwroot/backup:/b \
  alpine tar czf /b/site-$(date +%m%d-%H%M).tgz -C /d .
```

命令拆解：`tar` 打包、`c` 创建、`z` gzip 压缩、`f` 输出到文件、
`-C` 先切到该目录再打包（保证包内是相对路径）、`.` 打包当前目录全部内容。

### 3.2 查看与恢复

```bash
# 不解压，只看包内文件
tar tzf /www/wwwroot/backup/site-1101-0300.tgz | head -20

# 恢复（先停容器，避免写到一半的数据库被覆盖）
docker stop 容器名
tar xzf /www/wwwroot/backup/site-1101-0300.tgz -C /www/wwwroot/fixikang/data
docker start 容器名
```

### 3.3 每天自动备份

```bash
crontab -e
# 加入一行（crontab 里的 % 必须转义成 \%）
0 3 * * * mkdir -p /www/wwwroot/backup && tar czf /www/wwwroot/backup/site-$(date +\%m\%d).tgz -C /www/wwwroot/fixikang/data .
```

---

## 4. 排查手册

### 4.1 更新后页面没变化

按顺序排查，**不要跳步**：

```bash
# ① 镜像里到底是不是新代码
docker run --rm beishan-mall:latest sh -c "grep -o 'V2\.[0-9]*' /app/public/h5/assets/index-*.js | head -1"

# ② 容器是不是在用这个镜像
docker inspect -f '{{.Image}}' 容器名
docker images --format '{{.ID}}  {{.CreatedAt}}  {{.Repository}}:{{.Tag}}' | grep -i beishan

# ③ 容器里是不是新代码
docker exec 容器名 sh -c "grep -o 'V2\.[0-9]*' /app/public/h5/assets/index-*.js | head -1"

# ④ 绕过反代直连容器
docker port 容器名
curl -s http://127.0.0.1:宿主机端口/ | grep -o 'V2\.[0-9]*' | head -1
```

| ① 镜像 | ② 容器绑定 | ④ 直连 | 结论 |
|---|---|---|---|
| 旧版本 | — | — | 源码没更新，或 `docker build` 在别的目录执行 |
| 新版本 | 与 latest 不同 | — | 容器没重建（或重建时用了旧 ID） |
| 新版本 | 相同 | 旧版本 | 容器内文件被挂载覆盖，检查 `-v /app/public` |
| 新版本 | 相同 | 新版本 | **反代或浏览器缓存**，见 4.2 / 4.3 |

### 4.2 反代指错了容器

```bash
grep -rn "proxy_pass" /www/server/panel/vhost/nginx/ | grep -E "3278[0-9]"
```

两个站必须指向各自的宿主机端口，写反了就会出现"一个站更新、另一个不更新"。

同时检查站点配置里有没有 `proxy_cache`（会缓存 HTML）、有没有开 CDN / 网站加速。

### 4.3 浏览器缓存

用**无痕窗口**打开对比：

- 无痕正常 → 本地缓存或 Service Worker
  `F12 → Application → Service Workers → Unregister`，再强刷一次
- 无痕也旧 → 不是浏览器问题

服务端已对 `index.html`、`sw.js` 设置 `no-cache`，正常不会卡住旧入口；
带哈希的 `assets/*` 是一年强缓存，文件名变了才会重新下载。

### 4.4 站点白屏 / 502

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker logs --tail 80 容器名
```

常见原因：容器没起来（端口冲突、挂载路径不存在）、后端代码语法错误、数据库文件损坏。

### 4.5 数据"看起来没了"

先别慌，按这个顺序确认：

```bash
# 容器里挂的到底是哪
docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' 容器名

# 那个位置的数据库在不在
ls -lh /www/wwwroot/fixikang/data/mall.db
```

- 路径空的或指向了陌生卷 → 重建时 `-v` 写错了，旧数据还在原来的卷里，用
  `docker volume ls` 找回来重新挂载
- 文件在但 0 字节 → 可能被中断写入，用最近的备份恢复

### 4.6 构建很慢或报错

```bash
docker build --no-cache -t beishan-mall:latest .    # 排除缓存干扰
df -h                                                # 磁盘满也会失败
docker system df                                     # 看镜像/卷占用
```

清理无用镜像（**确认没有容器在用**）：

```bash
docker image prune -a
```

---

## 5. 容器生命周期速查

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'   # 全部容器
docker stop 容器名 && docker rename 容器名 容器名_old                # 停并留底
docker rm 容器名                                                   # 删容器（不加 -v）
docker rm -v 容器名                                                # 删容器 + 匿名卷（慎用）
docker logs --tail 100 容器名                                       # 看日志
docker exec -it 容器名 sh                                           # 进容器
docker restart 容器名                                               # 只重启，不换镜像
```

**卸载旧容器**：确认新容器跑稳一两天后再删，`docker rm 容器名` 不要加 `-v`。

---

## 6. 环境变量说明

镜像内置了默认值，一般不需要额外传：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3300 | 容器内监听端口，改这个要同步改 `-p` 右边 |
| `MALL_DB` | `/app/data/mall.db` | 数据库路径 |
| `UPLOAD_DIR` | `/app/data/uploads` | 上传目录 |
| `PUBLIC_DIR` | `/app/public` | 前端构建产物目录 |
| `TZ` | Asia/Shanghai | 时区，**必须设**，否则时间会差 8 小时 |
| `JWT_SECRET` | 内置默认 | 正式环境建议改成自己的 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin1 / 123456 | 内置管理员，首次启动创建 |
| `ADMIN_PASSWORD_RESET` | 0 | 设 1 重启一次可把管理员密码重置回环境变量里的值 |

改管理员密码：

```bash
docker stop 容器名
docker rm 容器名   # 不加 -v
docker run -d --name 容器名 ... -e ADMIN_PASSWORD_RESET=1 -e ADMIN_PASSWORD=新密码 beishan-mall:latest
# 登录成功后，再用 ADMIN_PASSWORD_RESET=0 重启一次
```
