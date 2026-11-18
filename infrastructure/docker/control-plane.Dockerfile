FROM python:3.12-slim
WORKDIR /srv
COPY services/control-plane/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/control-plane/app ./app
COPY docs/architecture ./docs/architecture
ENV APF_DATA_DIR=/data
RUN useradd -u 10001 apf && mkdir -p /data && chown apf /data
USER 10001
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
