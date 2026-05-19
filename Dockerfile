FROM oven/bun:1.3.10-alpine

ENV TZ=America/Chicago

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
CMD ["bun", "run", "src/main.ts"]
