FROM node:20-alpine

WORKDIR /usr/src/app

# Ensure production install by default
ENV NODE_ENV=production

# Install only production dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app
COPY . .

ENV envPath=/var/tyk-middleware/app.properties

# Expose gRPC port (configurable via GRPC_PORT)
EXPOSE 5555

# Run as non-root for security
USER node

CMD ["node", "server.js"]

