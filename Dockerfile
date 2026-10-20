FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json --outDir dist

FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV CWP_DATA=/app/data/store.json
EXPOSE 8000
VOLUME /app/data
CMD ["node", "dist/src/cli.js", "serve", "--port", "8000"]
