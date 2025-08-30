############################################
# Frontend build stage
############################################
FROM node:16-alpine AS frontend-builder

WORKDIR /frontend

# Install frontend dependencies
COPY frontend/package*.json ./
RUN npm ci || npm install

# Copy frontend source and build
COPY frontend/ ./
RUN npm run build

############################################
# Backend runtime stage
############################################
FROM node:16-alpine AS backend

WORKDIR /app
# Build-time metadata
ARG BUILD_COMMIT
ARG BUILD_TIME
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_TIME=${BUILD_TIME}
ENV BUILD_VERSION=1.0.0

# Install backend dependencies
COPY backend/package*.json ./
RUN npm ci || npm install

# Copy backend source code
COPY backend/ ./

# Copy built frontend assets from the frontend stage
COPY --from=frontend-builder /frontend/build /frontend/build

# Install CUPS client and Ghostscript for server-side printing with `lp`
RUN apk add --no-cache cups-client ghostscript

# Expose port and set environment
EXPOSE 5000
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]
