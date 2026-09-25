FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
# The public API serves its own OpenAPI description (GET /openapi.json), read
# from openapi/openapi.yaml beside dist/ at startup.
COPY --from=builder /app/openapi ./openapi
EXPOSE 3000
CMD ["node", "dist/main"]
