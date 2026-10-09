# Use the official Node.js 20 image as the base
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    webp \
    python3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Use the current official yt-dlp build instead of the often-stale Debian package.
# This is important because media sites regularly change their player APIs.
RUN curl -L --fail --retry 3 \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

# Create and set the working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies (--unsafe-perm needed for native modules as root)
RUN npm install --legacy-peer-deps --unsafe-perm

# Copy the rest of the application code
COPY . .

# Ensure session and database directories exist
RUN mkdir -p session database

# Set environment variables
ENV NODE_ENV=production

# Start the application
CMD ["node", "index.js"]
