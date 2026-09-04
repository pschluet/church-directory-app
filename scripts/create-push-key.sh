#!/usr/bin/env bash
#
# Generates the VAPID keypair Web Push is signed with.
#
# Every push the API sends is signed with the private half; the browser is given
# the public half when it subscribes, and the push service checks that the two
# match before it will deliver anything. Together they are what identify this
# deployment as the sender -- which is the whole of VAPID.
#
# Why a script and not part of the CDK stack, for the same two reasons as
# scripts/create-photo-key.sh:
#
#   * CDK has no primitive for a keypair.
#   * A private key passed to CloudFormation would sit in the template, readable
#     by anyone who can describe the stack. It has to arrive out of band.
#
# The public key is committed -- it is public by definition. The private key goes
# into a GitHub Actions secret and never touches the repository.
#
#   ./scripts/create-push-key.sh
#
# Re-running ROTATES the keypair, and that is not a quiet change: every existing
# subscription was issued against the old public key and stops working. Nobody
# has to do anything -- a send to a stale subscription answers 404 or 410 and
# api/src/services/push.ts deletes the row -- but every member has to turn
# notifications back on from the settings page before they hear anything again.
#
# Both halves are base64url, without padding, which is the encoding the Web Push
# spec uses and the only one `applicationServerKey` accepts. It is also why this
# cannot just be `openssl ec -pubout`: that emits DER or PEM.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_KEY_PATH="${REPO_ROOT}/infra/push-public-key.txt"
PRIVATE_KEY_PATH="$(mktemp -t vapid-private-key)"

# web-push is already a dependency of the API, and its CLI is the reference
# implementation of this encoding -- worth more than hand-rolling the base64url
# of a P-256 point with openssl and jq.
KEYS="$(npx --prefix "${REPO_ROOT}/api" --yes web-push generate-vapid-keys --json)"

PUBLIC_KEY="$(printf '%s' "$KEYS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).publicKey))')"
PRIVATE_KEY="$(printf '%s' "$KEYS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).privateKey))')"

if [ -z "$PUBLIC_KEY" ] || [ -z "$PRIVATE_KEY" ]; then
  echo "web-push did not return a keypair; nothing has been written." >&2
  exit 1
fi

printf '%s\n' "$PUBLIC_KEY" > "$PUBLIC_KEY_PATH"
printf '%s\n' "$PRIVATE_KEY" > "$PRIVATE_KEY_PATH"

echo "Public key written to infra/push-public-key.txt -- commit it."
echo
echo "Now store the private key as the VAPID_PRIVATE_KEY GitHub secret:"
echo
if command -v gh >/dev/null 2>&1; then
  echo "  gh secret set VAPID_PRIVATE_KEY < $PRIVATE_KEY_PATH"
else
  echo "  Settings > Secrets and variables > Actions > New repository secret"
  echo "  Name: VAPID_PRIVATE_KEY"
  echo "  Value: the contents of $PRIVATE_KEY_PATH"
fi
echo
echo "Then delete it:  rm $PRIVATE_KEY_PATH"
echo
echo "To deploy from a laptop instead, pass it as context:"
echo "  npx --prefix infra cdk deploy -c vapidPrivateKey=\"\$(cat $PRIVATE_KEY_PATH)\""
