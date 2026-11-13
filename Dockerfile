# Blank-slate image for zibbit. The app has no npm dependencies.
# Build:  docker build -t zibbit .
# Run:    see docs/SETUP.md (config lives in a mounted /config volume, never in the image)
FROM node:22-alpine
# ffmpeg converts antenna-tuner (HDHomeRun) video, which browsers can't play, while someone is watching
RUN apk add --no-cache ffmpeg su-exec
WORKDIR /app
COPY app/package.json app/server.js app/transcode.js app/recorder.js app/downloader.js app/tablo.js app/vod.js app/adult.js app/update-channel.txt ./
COPY app/public ./public
# starts the server as an ordinary user (PUID / PGID), not as root
COPY app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh
ENV PORT=8080 CONFIG_DIR=/config
VOLUME /config
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:8080/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
