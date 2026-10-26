FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY server server
# Keep the image's current assets outside the durable cache mounted by Compose.
# Docker seeds a new named volume with this empty directory's node ownership.
RUN mv dist/assets built-assets && mkdir dist/assets && chown node:node dist/assets
# The journal lives in a volume mounted here; it must belong to the app's user.
RUN mkdir data && chown node data
USER node
ENV PORT=8000
ENV NODE_ENV=production
ENV PUBLIC_DIR=/app/dist
ENV BUILT_ASSETS_DIR=/app/built-assets
EXPOSE 8000
# node:sqlite still prints an experimental warning on every start.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
