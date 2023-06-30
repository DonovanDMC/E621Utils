FROM node:20-alpine

ENV TZ=America/Chicago
WORKDIR /app
RUN echo -e "update-notifier=false\nloglevel=error\nnode-linker=hoisted" > ~/.npmrc
RUN npm install --no-save pnpm
COPY package.json pnpm-lock.yaml ./
RUN npx pnpm install  --frozen-lockfile
COPY . .
CMD npx pnpm start
