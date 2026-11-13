# Tor onion service sidecar for Bellows (deploy/tinfoil-config.onion.example.yml). Build from the repository root:
#   docker build -f deploy/tor/Dockerfile -t bellows-tor deploy/tor
# Runs as an unprivileged user (10001) on a read-only root file system; its keys live on /onion.
ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
FROM ${DEBIAN_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends tor \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 onion \
 && useradd --system --uid 10001 --gid 10001 --home-dir /onion --no-create-home --shell /usr/sbin/nologin onion \
 && mkdir -p /onion \
 && chown 10001:10001 /onion \
 && chmod 0700 /onion

COPY --chmod=0555 entrypoint.sh /usr/local/bin/bellows-onion

USER 10001:10001
VOLUME ["/onion"]
ENTRYPOINT ["/usr/local/bin/bellows-onion"]
