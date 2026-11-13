#!/bin/sh
# Runs Tor as an onion service for the Bellows container next to it.
#
# The onion service's keys, and so its address, live in BELLOWS_ONION_DIR (default /onion), which is the
# encrypted volume in deploy/tinfoil-config.onion.example.yml. Port 80 of the onion address goes to
# BELLOWS_ONION_TARGET_HOST:BELLOWS_ONION_TARGET_PORT (default bellows:8787).
#
# Arguments are passed to tor, so `--verify-config` checks the generated configuration without starting.
set -eu

target_host="${BELLOWS_ONION_TARGET_HOST:-bellows}"
target_port="${BELLOWS_ONION_TARGET_PORT:-8787}"
onion_dir="${BELLOWS_ONION_DIR:-/onion}"
torrc="${BELLOWS_ONION_TORRC:-/tmp/torrc}"

case "$target_port" in
  '' | *[!0-9]*) echo "bellows-onion: BELLOWS_ONION_TARGET_PORT must be a port number" >&2; exit 1 ;;
esac

# Tor takes an address, not a name, for the service target. Containers start in parallel, so wait until
# the Bellows container's name resolves.
tries=0
addr=""
while :; do
  addr="$(getent ahostsv4 "$target_host" 2>/dev/null | awk 'NR == 1 { print $1 }')" || addr=""
  [ -n "$addr" ] && break
  # ahostsv4 skips IPv4 when the container has no IPv4 route; /etc/hosts and plain lookups still answer.
  addr="$(getent hosts "$target_host" 2>/dev/null | awk '$1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print $1; exit }')" || addr=""
  [ -n "$addr" ] && break
  tries=$((tries + 1))
  if [ "$tries" -ge 120 ]; then
    echo "bellows-onion: cannot resolve $target_host" >&2
    exit 1
  fi
  sleep 1
done

umask 077
mkdir -p "$onion_dir/tor" "$onion_dir/service"
chmod 0700 "$onion_dir/tor" "$onion_dir/service"

cat > "$torrc" <<EOF
DataDirectory $onion_dir/tor
HiddenServiceDir $onion_dir/service
HiddenServicePort 80 $addr:$target_port
SocksPort 0
AvoidDiskWrites 1
Log notice stdout
EOF

# The onion address is public: it goes into the operator announcement (docs/OPERATORS.md). Print it once
# Tor has written it. The private key next to it never leaves the volume.
(
  i=0
  while [ ! -s "$onion_dir/service/hostname" ] && [ "$i" -lt 600 ]; do
    i=$((i + 1))
    sleep 1
  done
  if [ -s "$onion_dir/service/hostname" ]; then
    echo "bellows-onion: onion address $(cat "$onion_dir/service/hostname")"
  fi
) &

exec tor -f "$torrc" "$@"
