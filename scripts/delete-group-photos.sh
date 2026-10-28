#!/usr/bin/env bash
#
# One-off: deletes every stored group cover photo from the photos bucket.
#
# Groups no longer have a cover photo (V32__drop_group_photo.sql dropped the
# columns that pointed at them), so these objects are unreachable. They all
# live under `photos/<org>/group/<groupId>/` -- the trailing slash keeps this
# clear of `photos/<org>/group-post/`, which holds post attachments and must
# not be touched. Because the prefix alone identifies them, this can run any
# time after the deploy, before or after the migration.
#
#   PHOTOS_BUCKET=<bucket> ./scripts/delete-group-photos.sh [--dryrun]
#
# The bucket name is the stack's PhotosBucketName output.
#
set -euo pipefail

: "${PHOTOS_BUCKET:?Set PHOTOS_BUCKET to the PhotosBucketName stack output}"
DRYRUN="${1:-}"

# Each organization is one common prefix under photos/.
orgs=$(aws s3api list-objects-v2 --bucket "$PHOTOS_BUCKET" --prefix photos/ --delimiter / \
  --query 'CommonPrefixes[].Prefix' --output text)

for org in $orgs; do
  [ "$org" = "None" ] && continue
  echo "Deleting s3://${PHOTOS_BUCKET}/${org}group/"
  aws s3 rm --recursive ${DRYRUN:+"$DRYRUN"} "s3://${PHOTOS_BUCKET}/${org}group/"
done
