# Application Angular ISPAT Gestion — compilation puis service par Nginx
FROM node:22-alpine AS compilation
WORKDIR /src
COPY ispat_web/package.json ispat_web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ispat_web/ ./
RUN npx ng build --configuration production

FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY web/nginx.conf /etc/nginx/conf.d/ispat.conf
COPY --from=compilation /src/dist/ispat-gestion/browser/ /usr/share/nginx/html/
EXPOSE 80
