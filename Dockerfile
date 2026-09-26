FROM node:22-alpine

WORKDIR /app

# Build tools for native modules (better-sqlite3) when no prebuilt binary matches
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# Data directory for SQLite
RUN mkdir -p /data
ENV DB_PATH=/data/taproom.db

EXPOSE 3000

CMD ["node", "server.js"]
