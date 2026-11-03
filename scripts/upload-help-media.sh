#!/usr/bin/env bash
#
# Converts the /help page's screen recordings to MP4 and uploads them to S3.
#
# Why this is a script and not part of the deploy: the recordings are large
# binaries that change about never, so they stay out of the repo and out of
# deploy.yml's `sync --delete` of the site bucket. They live in their own
# bucket (HelpMediaBucket), which CloudFront serves at /help-media/*.
#
# Why MP4 and not the GIFs they were recorded as: a GIF of a minute of screen
# is 9-13MB, and this page is opened on a phone. The same footage is a fraction
# of that as H.264, and a muted, looping, inline <video> looks identical.
#
#   ./scripts/upload-help-media.sh <ios.gif> <android.gif> [version]
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
  echo "usage: $0 <ios.gif> <android.gif> [version]" >&2
  exit 1
fi

IOS_GIF="$1"
ANDROID_GIF="$2"
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
  local name="$1" gif="$2"
  local mp4="${WORK}/${name}-setup-${VERSION}.mp4"
  local poster="${WORK}/${name}-setup-${VERSION}.jpg"

  # yuv420p and even dimensions: without both, Safari will not play the file.
  # faststart moves the index to the front so playback begins before the whole
  # file has arrived.
  ffmpeg -y -loglevel error -i "$gif" \
    -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -pix_fmt yuv420p \
    -c:v libx264 -crf 26 -preset slow -movflags +faststart -an "$mp4"
  ffmpeg -y -loglevel error -i "$gif" -frames:v 1 -q:v 4 "$poster"

  aws s3 cp "$mp4" "s3://${BUCKET}/help-media/${name}-setup-${VERSION}.mp4" \
    --content-type video/mp4 --cache-control "$CACHE"
  aws s3 cp "$poster" "s3://${BUCKET}/help-media/${name}-setup-${VERSION}.jpg" \
    --content-type image/jpeg --cache-control "$CACHE"
}

publish ios "$IOS_GIF"
publish android "$ANDROID_GIF"

echo "Uploaded to s3://${BUCKET}/help-media/ as *-setup-${VERSION}.{mp4,jpg}"
