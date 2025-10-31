
FROM node:21.7.1

WORKDIR /app

COPY . .

COPY "./package.json" .

RUN npm install --force


EXPOSE 3000

CMD ["npm","run","start:dev"]
