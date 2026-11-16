FROM node:22-alpine

WORKDIR /app

# 直接跑源码，无需构建步骤
COPY package.json ./
COPY src ./src
COPY web ./web
COPY tools ./tools

# 以非 root 运行
RUN addgroup -S app && adduser -S -G app app \
 && mkdir -p /app/data && chown -R app:app /app
USER app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7864 \
    DATA_DIR=/app/data \
    TZ=Asia/Shanghai

VOLUME ["/app/data"]
EXPOSE 7864

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7864)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
