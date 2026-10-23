FROM node:20-slim

WORKDIR /app

# Python for the RFP script (Playwright + Chromium are installed by scripts/setup.sh below).
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN PLAYWRIGHT_WITH_DEPS=1 bash scripts/setup.sh

# Everything that must survive a redeploy lives under /data: mount a volume there
# (docker run -v rfp-state:/data ...). Without it the RFP numbering, the 7-day venue gaps, the
# hotels added from Slack and the job logs restart from scratch.
ENV RFP_STATE_DIR=/data/state \
    RFP_HOTELS_CONFIG=/data/rfp-hotels.json \
    DATA_DIR=/data/jobs \
    HOST=0.0.0.0
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
