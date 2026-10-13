FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    STOCK_N_SALES_DB_PATH=/data/stock_n_sales.db

WORKDIR /app

RUN mkdir -p /data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ai ./ai
COPY backend ./backend
COPY css ./css
COPY icons ./icons
COPY js ./js
COPY index.html manifest.json service-worker.js Logo.png ./

EXPOSE 8080

CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT} --workers 1 --threads 4 --timeout 120 backend.app:app"]
