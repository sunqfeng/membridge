FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
USER 1000:1000
ENV HOST=127.0.0.1 PORT=8787
CMD ["bun", "src/server.ts"]
