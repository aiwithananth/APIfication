FROM node:22-alpine AS build
WORKDIR /app
COPY apps/web/package*.json ./
RUN npm install --no-audit --no-fund
COPY apps/web ./
ARG APF_API_URL=http://control-plane:8000
ENV APF_API_URL=$APF_API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3000
CMD ["npm", "start"]
