# WandiHub on Hatch — single-stage Node image.
# bcrypt and sqlite3 are native modules; alpine needs python3/make/g++ to build them.
FROM node:22-alpine

RUN apk add --no-cache python3 make g++ \
  && ln -sf python3 /usr/bin/python

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# DB_PATH is set at deploy time to /files/shared.db so SQLite + images/
# live on the EFS volume Hatch mounts at /files.
CMD ["npm", "start"]
