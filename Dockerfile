# syntax=docker/dockerfile:1.7

ARG PYTHON_IMAGE=python:3.14-slim-bookworm
ARG NODE_IMAGE=node:22-bookworm-slim
ARG CHORDMARK_COMMIT=5271674cc7c81599354fb43eb35bae1cd2494cc0

FROM ${NODE_IMAGE} AS chordmark
ARG CHORDMARK_COMMIT
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/chordmark-source
RUN git clone --filter=blob:none https://github.com/arthursoares/chord-mark.git . \
    && git checkout --detach "${CHORDMARK_COMMIT}" \
    && install -d /opt/chordmark/packages/chord-mark /opt/chordmark/packages/chord-mark-themes \
    && cp -a packages/chord-mark/src /opt/chordmark/packages/chord-mark/src \
    && cp -a packages/chord-mark-themes/scss /opt/chordmark/packages/chord-mark-themes/scss \
    && cd /opt/chordmark \
    && npm init --yes >/dev/null \
    && npm install --save-exact --omit=dev --no-audit --no-fund \
         esbuild@0.21.5 jsdom@25.0.0 sass@1.78.0 \
         chord-symbol@4.0.0 dompurify@3.1.6 lodash@4.17.21 \
    && rm -rf /tmp/chordmark-source /root/.npm /tmp/*

FROM ${PYTHON_IMAGE} AS runtime
ARG CHORDMARK_COMMIT
ARG APP_UID=1000
ARG APP_GID=1000

LABEL org.opencontainers.image.url="https://github.com/arthursoares/songsheet-parser" \
      org.opencontainers.image.description="Local browser QA for scanned chord-song libraries" \
      io.songsheet.chordmark.commit="${CHORDMARK_COMMIT}"

WORKDIR /app
COPY pyproject.toml ./
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir --group core
COPY --from=chordmark /usr/local/bin/node /usr/local/bin/node
COPY --from=chordmark /opt/chordmark /opt/chordmark
COPY schemas ./schemas
COPY scripts ./scripts

RUN groupadd --gid "${APP_GID}" songsheet \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --home-dir /home/songsheet songsheet \
    && install -d -o songsheet -g songsheet /state /library /library/songs /library/pdf \
    && touch /state/.songsheet-state \
    && chown -R songsheet:songsheet /app /state /library

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CHORDMARK_REPO=/opt/chordmark \
    SONGSHEET_HOST=0.0.0.0 \
    SONGSHEET_STATE_DIR=/state

USER songsheet:songsheet
VOLUME ["/state"]
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/', timeout=3).read(1)"]

ENTRYPOINT ["python", "-u", "scripts/qa_server.py"]
CMD ["--songs", "/library/songs", "--pdfs", "/library/pdf", "--port", "8001"]
