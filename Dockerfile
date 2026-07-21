# MongoModel — production image (Next.js standalone)
# build:  docker build -t mongomodel .
# run:    docker run -d -p 3100:3100 -v mongomodel-data:/app/data mongomodel

# ---------- deps: ติดตั้ง node_modules ตาม lockfile ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder: build Next.js ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runner: เฉพาะของที่ต้องใช้รัน ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3100 \
    HOSTNAME=0.0.0.0

# standalone bundle + static assets + public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# ข้อมูลโปรเจกต์ (mount จาก host ตอนรัน — ใน image ให้เป็นโฟลเดอร์ว่าง)
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3100
CMD ["node", "server.js"]
