FROM node:22-alpine

WORKDIR /app

COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=58059 \
    DATA_DIR=/data

VOLUME /data
EXPOSE 58059

CMD ["node", "server.js"]
