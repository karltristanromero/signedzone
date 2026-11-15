# Stage 1: Builder
FROM python:3.14-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Stage 2: Runtime
FROM python:3.14-slim
ARG UID=1000
ARG GID=1000
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN groupadd -g ${GID} app && useradd -u ${UID} -g app -M -s /usr/sbin/nologin app

WORKDIR /app
COPY --from=builder /install /usr/local
COPY --chown=app:app app.py .
COPY --chown=app:app static/ ./static/
RUN mkdir -p /app/storage && chown app:app /app/storage
USER app
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]