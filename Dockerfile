FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HUB_DATA_DIR=/data \
    PORT=3000

# 외부 의존성이 없어서 npm install 단계가 없어요
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
