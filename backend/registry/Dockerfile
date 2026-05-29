# Autotest Registry Dockerfile
# Lightweight service for account/project/key management + test approval.
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY . /app/registry/
RUN touch /app/registry/__init__.py

RUN mkdir -p /app/registry-data /app/tests-store

EXPOSE 8003

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8003/health')" || exit 1

CMD ["uvicorn", "registry.main:app", "--host", "0.0.0.0", "--port", "8003"]
