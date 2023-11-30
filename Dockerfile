FROM node:18

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY src/ .
COPY GeoLite2-City.mmdb .

EXPOSE 3000
CMD [ "node", "index.js" ]