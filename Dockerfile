FROM node:20-slim

# Install python and pip
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv

WORKDIR /app

# Copy package.json and install Node dependencies
COPY package.json ./
RUN npm install

# Create a virtual environment and install python dependencies
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip3 install requests urllib3

# Copy all source files
COPY . .

# Expose port
EXPOSE 3000

# Start both Node and Python scripts using bash
CMD ["bash", "-c", "node server.js & python3 sync.py & wait -n"]
