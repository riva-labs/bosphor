# Nightly offsite Postgres backups (#345): pg_dump -> gzip -> Cloudflare R2.
FROM postgres:16-alpine
RUN apk add --no-cache rclone busybox-extras
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
