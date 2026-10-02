# A machine to try autofwd on: sshd, the herdr build matching yours, and a few web servers.
FROM debian:bookworm-slim
ARG HERDR_TAG
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server iproute2 procps python3 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash dev \
 && curl -fsSL -o /usr/local/bin/herdr "https://github.com/herdrdev/herdr/releases/download/${HERDR_TAG}/herdr-linux-$(uname -m)" \
 && chmod +x /usr/local/bin/herdr
COPY entrypoint.sh /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["sh", "/entrypoint.sh"]
