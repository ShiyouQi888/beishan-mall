# ---- 构建阶段：编译后台与 H5 ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 先只拷贝依赖清单，利用镜像层缓存
COPY server/package*.json ./server/
COPY admin/package*.json ./admin/
COPY h5/package*.json ./h5/

RUN cd server && npm ci --omit=dev || npm install --omit=dev
RUN cd admin && npm ci || npm install
RUN cd h5 && npm ci || npm install

# 再拷贝源码并构建
COPY . .

# 后台必须带 base=/admin/ 构建，否则静态资源会与 H5 抢根路径
RUN cd admin && VITE_BASE=/admin/ npx vite build
RUN cd h5 && npx vite build
RUN mkdir -p public \
 && cp -r admin/dist public/admin \
 && cp -r h5/dist public/h5

# ---- 运行阶段 ----
FROM node:22-bookworm-slim
WORKDIR /app

# slim 镜像**不带 tzdata**：只设 TZ 环境变量是没用的，glibc 找不到时区文件会静默退回 UTC。
# 结果就是容器里「北京时间 08:00」被算成 UTC 08:00（= 北京 16:00），上午场明明开放，
# 前台却显示「未开始 · 距开始 5 小时」。业务时间已经在代码里固定按东八区算，
# 这里补 tzdata 是为了让日志、sqlite 的 localtime 也一起对齐。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3300 \
    TZ=Asia/Shanghai \
    MALL_DB=/app/data/mall.db \
    UPLOAD_DIR=/app/data/uploads \
    PUBLIC_DIR=/app/public

# 运行时只需要 server 代码 + 已构建的静态站点
COPY --from=build /app/server/package*.json ./server/
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/src ./server/src
COPY --from=build /app/server/test ./server/test
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/docs ./docs
COPY --from=build /app/package.json ./package.json

# 数据目录（SQLite + 上传文件），挂卷持久化
RUN mkdir -p /app/data/uploads \
 && printf '#!/bin/sh\nset -e\nif [ ! -f "$MALL_DB" ]; then\n  echo "[entrypoint] 首次启动，初始化演示数据…"\n  node src/seed.js\nfi\nexec node src/app.js\n' > /app/server/entrypoint.sh \
 && chmod +x /app/server/entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 3300

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["sh", "/app/server/entrypoint.sh"]
