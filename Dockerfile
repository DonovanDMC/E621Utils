FROM node:20-alpine

ENV TZ=America/Chicago
WORKDIR /app
RUN echo -e "update-notifier=false\nloglevel=error\nnode-linker=hoisted" > ~/.npmrc
RUN npm install --no-save pnpm
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN npx pnpm install  --frozen-lockfile
COPY . .
CMD ["node", "--no-warnings", "--no-deprecation", "--experimental-specifier-resolution=node", "--loader", "ts-node/esm", "/app/src/main.ts"]
