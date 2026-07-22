# Use official Node.js image
FROM node:20-slim

# Install Python, pip, ffmpeg, and build tools (required for yt-dlp)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    ffmpeg \
    unzip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip and install yt-dlp with the latest version
RUN pip3 install --upgrade pip --break-system-packages && \
    pip3 install --upgrade yt-dlp --break-system-packages

# Install Deno (required for YouTube JS extraction in yt-dlp)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_DIR="/root/.deno"
ENV PATH="${DENO_DIR}/bin:${PATH}"

# Verify Deno installation
RUN deno --version

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
