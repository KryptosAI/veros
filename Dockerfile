FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3100

ENV PORT=3100
ENV NODE_ENV=production
ENV JWT_SECRET=change-this-in-production
ENV DEID_SECRET=change-this-in-production

RUN mkdir -p /app/data && chown node:node /app/data
USER node

CMD ["node", "index.js"]
