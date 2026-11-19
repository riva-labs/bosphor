# ntfy with the Bosphor alert template and server config baked in. Bind-mounting
# them from the repo checkout broke delivery for two days: switching git
# branches removed monitoring/ntfy/templates under the running container and
# every Alertmanager webhook failed with "template file not found".
FROM binwiederhier/ntfy:v2.38.1
COPY server.yml /etc/ntfy/server.yml
COPY templates /etc/ntfy/templates
