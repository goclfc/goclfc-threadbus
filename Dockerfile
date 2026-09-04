# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Run as non-root user
RUN addgroup -g 1001 -S threadbus && \
    adduser -S threadbus -u 1001

COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

USER threadbus

EXPOSE 3000

CMD ["node", "dist/server.js"]
