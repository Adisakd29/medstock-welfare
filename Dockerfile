FROM node:20-slim

WORKDIR /app

# ติดตั้งเครื่องมือที่ sqlite3 ต้องใช้ตอน build
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# โฟลเดอร์ฐานข้อมูล (Railway จะ mount Volume ทับตรงนี้)
RUN mkdir -p /app/db

EXPOSE 3000
CMD ["node", "server.js"]
