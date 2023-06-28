FROM node:20-alpine

ENV TZ=America/Chicago
WORKDIR /app
COPY . .
RUN npm --no-update-notifier install --development
CMD node --no-warnings --no-deprecation --experimental-specifier-resolution=node --loader ts-node/esm /app/run.ts
