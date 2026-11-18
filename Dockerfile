# Production image: builds the web app, then runs the server (TypeScript, run directly by Node) with production dependencies only.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY engine/package.json engine/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY engine engine
COPY web web
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY engine/package.json engine/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY shared shared
COPY engine engine
COPY server server
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data/card-images && chown node:node /data/card-images
USER node
ENV PORT=3000 CARD_IMAGE_DIR=/data/card-images
EXPOSE 3000
CMD ["node", "server/src/index.ts"]
