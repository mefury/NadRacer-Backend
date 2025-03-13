FROM node:18-alpine

# Add production dependencies
RUN apk add --no-cache tini curl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application code
COPY . .

# Use tini as init system
ENTRYPOINT ["/sbin/tini", "--"]

# Set environment variables
ENV NODE_ENV=production

# Expose the port the app runs on
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:3001/health || exit 1

# Command to run the application
CMD ["npm", "run", "start:prod"] 