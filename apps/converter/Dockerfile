FROM debian:bookworm-slim

# LibreOffice (Writer only) + the fonts the Writer export uses, plus Node for the
# tiny HTTP wrapper. Fonts first so the layer caches across code changes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui fonts-liberation fonts-liberation2 fonts-dejavu-core \
      fonts-noto-core fonts-inter nodejs ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs ./
ENV PORT=3100
EXPOSE 3100
CMD ["node", "server.mjs"]
