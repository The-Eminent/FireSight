# 1) Base image with Python 3.11
FROM python:3.11-slim AS builder

# 2) Install Node.js 18
RUN apt-get update && \
    apt-get install -y curl build-essential && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# 3) Install Python ML deps
RUN pip install --no-cache-dir \
      tensorflow scikit-learn pandas numpy joblib tqdm requests

# 4) Copy your entire backend + ML code
WORKDIR /app
COPY . /app

# 5) Install Node.js deps
RUN npm install

# 6) Expose the port your app will run on
EXPOSE 5001

# 7) Default start command
CMD ["npm", "start"]
