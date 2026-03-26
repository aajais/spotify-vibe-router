FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY src/ src/
COPY public/ public/
EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8888/healthz || exit 1
CMD ["node", "src/server.mjs"]
