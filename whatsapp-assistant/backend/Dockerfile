FROM node:22-alpine
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
