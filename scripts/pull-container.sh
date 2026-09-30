#!/usr/bin/env bash
set -euo pipefail

# Retry image acquisition only; never retry or soften a failing runtime test.
image=${1:?image is required}
shift
for delay in 5 15 30; do
  if docker pull "$@" "$image"; then
    exit 0
  fi
  echo "Image pull failed; retrying in ${delay}s: $image" >&2
  sleep "$delay"
done
docker pull "$@" "$image"
