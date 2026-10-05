#!/bin/bash
# backend/scripts/ingest.sh
# Sync a mounted disc (or folder) into the ingest bucket and write the ready marker.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BACKEND_DIR}/.." && pwd)"
OUTPUTS="${REPO_ROOT}/video_convert_outputs.json"
CONFIG_FILE="${BACKEND_DIR}/bin/config.ts"
SRC="${1:-}"

if [ ! -f "$OUTPUTS" ]; then
  echo "  Run ./scripts/deploy.sh first."
  exit 1
fi

if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "  Usage: ./scripts/ingest.sh \"/Volumes/DVD Video Recording\""
  exit 1
fi

BUCKET=$(python3 -c "import json; print(json.load(open('$OUTPUTS'))['storage']['ingest_bucket'])")
AWS_REGION=$(grep -E '^\s+awsRegion:' "$CONFIG_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')
VOLUME_NAME="$(basename "$SRC")"
SLUG=$(python3 -c "import re,sys; t=re.sub(r'[^A-Za-z0-9._-]+','-',sys.argv[1].strip()); t=re.sub(r'-{2,}','-',t).strip('-'); print(t or 'disc')" "$VOLUME_NAME")
PREFIX="incoming/${SLUG}"

echo "  Disc:   $VOLUME_NAME"
echo "  Prefix: s3://$BUCKET/$PREFIX/"
echo "  Syncing (original files on the disc are not changed)..."

aws s3 sync "$SRC" "s3://$BUCKET/$PREFIX" \
  --exclude ".DS_Store" \
  --exclude "*.DS_Store" \
  --exclude "ready" \
  --region "$AWS_REGION"

READY_BODY=$(VOLUME_NAME="$VOLUME_NAME" python3 -c "import json,os,datetime; print(json.dumps({'source': os.environ['VOLUME_NAME'], 'ingestedAt': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}))")
echo "$READY_BODY" | aws s3 cp - "s3://$BUCKET/$PREFIX/ready" \
  --content-type application/json \
  --region "$AWS_REGION"

echo "  ✅ Ready marker written. Conversion starts in AWS."
echo "  MP4 will land in Dropbox → All DLIV Users → Videos/"
