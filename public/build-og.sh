#!/bin/sh
set -eu

cd "$(dirname "$0")"

for name in woah-og woah-slim; do
  rsvg-convert -w 1200 "$name.svg" -o "$name.png"
  echo "wrote $name.png"
done
