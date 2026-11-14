# Stage 1: Builder
FROM python:3.14-slim AS builder
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]


# Stage 2: Runtime
FROM python:3.14-slim

WORKDIR /app

# Copy only installed packages from builder (excludes __pycache__, .pytest_cache, etc.)
COPY --from=builder /usr/local/lib/python3.14/site-packages /usr/local/lib/python3.14/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy only production files (excludes test_app.py, __pycache__)
COPY app.py .
COPY requirements.txt .
COPY static/ ./static/
COPY storage/ ./storage/

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]