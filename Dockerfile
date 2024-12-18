FROM node:20-alpine3.19
WORKDIR /app
COPY package.json /app/
RUN npm install
COPY app.js /app/
EXPOSE 3000
CMD ["npm", "start"]
