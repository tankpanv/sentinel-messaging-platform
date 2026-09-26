FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/infrastructure/db/schema.sql ./dist/infrastructure/db/schema.sql
CMD ["sh","-c","node dist/infrastructure/db/migrate.js && node dist/index.js"]
