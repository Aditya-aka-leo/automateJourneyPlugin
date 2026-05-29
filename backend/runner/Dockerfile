# Autotest Playwright Runner Dockerfile
# Uses official Playwright image with all browsers pre-installed
FROM mcr.microsoft.com/playwright/python:v1.58.0-noble

# Set working directory
WORKDIR /app

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    ARTIFACTS_DIR=/app/artifacts

# Copy requirements first for caching
COPY requirements.txt .

# Install Node.js (needed for npx playwright test on .spec.ts files)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @playwright/test && \
    npx playwright install --with-deps chromium

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Create artifacts directory
RUN mkdir -p /app/artifacts /app/runner

# Copy application code
COPY . /app/runner/

# Create __init__.py for the runner package
RUN touch /app/runner/__init__.py

# Expose port
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')" || exit 1

# Run the application
CMD ["uvicorn", "runner.main:app", "--host", "0.0.0.0", "--port", "8001"]
