FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p db

EXPOSE 3000

CMD ["node", "server.js"]
