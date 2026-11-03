#!/usr/bin/env bash
#
# Converts the /help page's screen recordings to MP4 and uploads them to S3.
#
# Why this is a script and not part of the deploy: the recordings are large
# binaries that change about never, so they stay out of the repo and out of
# deploy.yml's `sync --delete` of the site bucket. They live in their own
# bucket (HelpMediaBucket), which CloudFront serves at /help-media/*.
#
# Encode from the original screen recordings, not from GIFs made out of them: a
# GIF has already thrown away colour and frame detail, and is 9-13MB for a minute
# of screen. The originals are 40-65MB at full phone resolution, far more than a
# phone-sized frame on this page can show, so they are scaled to 540px wide
# (twice the frame's width, for dense screens) at 24fps. That lands at about
# 1.4MB each -- ffmpeg reads whatever container the recording came in (.mp4,
# .webm, .mov).
#
#   ./scripts/upload-help-media.sh <ios-recording> <android-recording> [version]
#
# Needs ffmpeg and AWS credentials for the account the stack is deployed to.
#
# The files are uploaded as `immutable` under a versioned name, so CloudFront and
# browsers keep them for a year and nothing is ever invalidated. To replace a
# recording, pass a new version (v2) and bump HELP_MEDIA_VERSION in
# app/src/pages/Help.tsx to match.
#
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <ios-recording> <android-recording> [version]" >&2
  exit 1
fi

IOS_SRC="$1"
ANDROID_SRC="$2"
VERSION="${3:-v1}"
STACK_NAME="${STACK_NAME:-ChurchDirectoryStack}"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='HelpMediaBucketName'].OutputValue" --output text)"
if [[ -z "$BUCKET" || "$BUCKET" == "None" ]]; then
  echo "HelpMediaBucketName is not an output of ${STACK_NAME} -- deploy the stack first" >&2
  exit 1
fi

WORK="$(mktemp -d -t help-media)"
trap 'rm -rf "$WORK"' EXIT

CACHE="public,max-age=31536000,immutable"

publish() {
  local name="$1" src="$2"
  local mp4="${WORK}/${name}-setup-${VERSION}.mp4"
  local poster="${WORK}/${name}-setup-${VERSION}.jpg"

  # yuv420p and even dimensions: without both, Safari will not play the file.
  # faststart moves the index to the front so playback begins before the whole
  # file has arrived.
  # `scale=540:-2` keeps the aspect ratio and rounds the height to an even
  # number. `fps=24` also flattens a variable-frame-rate screen recording.
  ffmpeg -y -loglevel error -i "$src" \
    -vf "fps=24,scale=540:-2" -pix_fmt yuv420p \
    -c:v libx264 -crf 24 -preset slow -movflags +faststart -an "$mp4"
  ffmpeg -y -loglevel error -ss 1 -i "$src" -vf "scale=540:-2" -frames:v 1 -q:v 4 "$poster"

  aws s3 cp "$mp4" "s3://${BUCKET}/help-media/${name}-setup-${VERSION}.mp4" \
    --content-type video/mp4 --cache-control "$CACHE"
  aws s3 cp "$poster" "s3://${BUCKET}/help-media/${name}-setup-${VERSION}.jpg" \
    --content-type image/jpeg --cache-control "$CACHE"
}

publish ios "$IOS_SRC"
publish android "$ANDROID_SRC"

echo "Uploaded to s3://${BUCKET}/help-media/ as *-setup-${VERSION}.{mp4,jpg}"
