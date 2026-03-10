FROM node:22-alpine AS frontend
WORKDIR /app/my-react-app
COPY my-react-app/package*.json ./
RUN npm ci
COPY my-react-app/ ./
RUN npm run build

FROM node:22-alpine AS backend
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY --from=frontend /app/my-react-app/dist ./public

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD ["npm", "run", "start"]
