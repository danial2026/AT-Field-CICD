FROM node:22-alpine

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG NO_PROXY
ARG no_proxy

WORKDIR /app

RUN apk add --no-cache \
    bash \
    curl \
    git \
    openssh-client \
    rsync \
    ca-certificates \
    jq \
    python3 \
    make \
    g++

COPY package.json package-lock.json* ./

RUN npm ci --only=production && apk del python3 make g++

COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/

RUN mkdir -p /app/scripts /app/logs /app/ssh /app/data && touch /app/ssh/known_hosts

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

CMD ["node", "server.js"]
