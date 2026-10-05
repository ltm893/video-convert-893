FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libmp3lame

RUN pip install --no-cache-dir boto3

COPY convert.py /app/convert.py
WORKDIR /app
ENTRYPOINT ["python3", "/app/convert.py"]
