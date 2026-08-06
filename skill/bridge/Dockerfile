FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev || npm install --omit=dev) && npm cache clean --force
COPY --from=build /app/dist ./dist
# 微信凭证持久化目录（挂 volume 重启免扫码）
VOLUME ["/data/wechatbot"]
ENV WECHATBOT_STORAGE_DIR=/data/wechatbot
CMD ["node", "dist/index.js"]
