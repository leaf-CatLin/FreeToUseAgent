# Our Free Model 独立服务的容器镜像。
#
# 只发布推理面：管理台仍绑回环，容器内可用 `/health` 做健康检查；
# 局域网推理由 `--lan` 开启的中继在 18901 上提供。
# 详细说明见 deploy/README.md。
FROM node:24-alpine

# 服务需要的最低环境：数据目录固定在卷上，避免写进镜像层。
ENV OFM_HOME=/data \
    NODE_ENV=production

WORKDIR /app

# 只复制运行期真正需要的部分：源码、事件/通告数据、已构建的网页资源。
# 前端与渠道构建产物都已在仓库里，容器构建不需要安装 React/esbuild。
COPY package.json ./
COPY index.js client.js cordis.patch.yml ./
COPY src ./src
COPY adapter ./adapter
COPY catalog ./catalog
COPY feed ./feed
COPY locale ./locale
COPY packages/standalone ./packages/standalone
COPY vendor ./vendor
COPY scripts/standalone-package-test.mjs ./scripts/standalone-package-test.mjs

# 数据目录属于运行用户；凭据文件由服务自己以 0600 写出。
RUN mkdir -p /data \
    && chown -R node:node /data \
    && adduser -D -H -u 10001 ofm 2>/dev/null || true

USER node

# 18900：本机管理 + 本机推理（回环）。只有需要从宿主机本机管理时才发布它。
# 18901：局域网推理中继。
EXPOSE 18900 18901

# 走回环：中继按契约不转发 /health，所以健康检查必须问本机监听器。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:18900/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --lan 会把 LAN 意愿写进 /data/settings.json，重建容器后仍然生效。
ENTRYPOINT ["node", "packages/standalone/cli.mjs"]
CMD ["--data-dir", "/data", "--port", "18900", "--lan", "--lan-port", "18901"]