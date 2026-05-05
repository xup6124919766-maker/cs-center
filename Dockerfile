FROM node:24-bookworm-slim

# 安裝 curl（healthcheck 用）
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# 確保 data / backups / logs 目錄存在
RUN mkdir -p data backups logs

ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/api/health || exit 1

CMD ["node", "--experimental-sqlite", "server.js"]
