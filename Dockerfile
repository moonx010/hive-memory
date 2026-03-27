FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
ENV CORTEX_HTTP=true
ENV CORTEX_DATA_DIR=/data
EXPOSE 3179
HEALTHCHECK CMD curl -f http://localhost:3179/health || exit 1
CMD ["node", "dist/index.js"]
