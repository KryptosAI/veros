FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3100

ENV PORT=3100
ENV NODE_ENV=production

RUN mkdir -p /app/data && chown node:node /app/data
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/api/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) })"

CMD ["node", "index.js"]
