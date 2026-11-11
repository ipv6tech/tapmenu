FROM node:24-alpine

# su-exec lets the entrypoint drop root privileges after fixing volume ownership
RUN apk add --no-cache su-exec

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Data directory for SQLite
RUN mkdir -p /data && chown node:node /data
ENV DB_PATH=/data/taproom.db

EXPOSE 3000

# Runs as root only to fix volume ownership, then drops to the "node" user
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
