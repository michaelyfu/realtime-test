FROM node:18

# Install the ALSA development libraries
RUN apt-get update && apt-get install -y \
    alsa-utils \
    libasound2 \
    libasound2-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json /app/
RUN npm ci

# Copy remaining source code
COPY . .

# Expose port & start app
EXPOSE 3000
CMD ["npm", "start"]
