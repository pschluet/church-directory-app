#!/usr/bin/env bash
#
# Generates the RSA keypair CloudFront uses to gate photo reads.
#
# Photos live in a private bucket served through CloudFront, whose /photos/*
# behaviour only answers requests carrying a signature from a trusted key group.
# The API signs the cookies; CloudFront verifies them with the public half.
#
# Why a script and not part of the CDK stack:
#
#   * CloudFront cannot generate a keypair, and CDK has no primitive for one.
#   * A private key passed to CloudFormation would sit in the template, readable
#     by anyone who can describe the stack. It has to arrive out of band.
#
# The public key is committed -- it is public by definition, and the stack needs
# it at synth time. The private key goes into a GitHub Actions secret and never
# touches the repository.
#
#   ./scripts/create-photo-key.sh
#
# Re-running rotates the key: deploy afterwards, and every browser holding an
# old cookie gets a 403 on photos until its next GET /me, which is one page load.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_KEY_PATH="${REPO_ROOT}/infra/photo-public-key.pem"
PRIVATE_KEY_PATH="$(mktemp -t photo-private-key)"

# CloudFront requires RSA-2048 for trusted key groups; it rejects anything else.
openssl genrsa -out "$PRIVATE_KEY_PATH" 2048 2>/dev/null
openssl rsa -pubout -in "$PRIVATE_KEY_PATH" -out "$PUBLIC_KEY_PATH" 2>/dev/null

echo "Public key written to infra/photo-public-key.pem -- commit it."
echo
echo "Now store the private key as the CLOUDFRONT_PRIVATE_KEY GitHub secret:"
echo
if command -v gh >/dev/null 2>&1; then
  echo "  gh secret set CLOUDFRONT_PRIVATE_KEY < $PRIVATE_KEY_PATH"
else
  echo "  Settings > Secrets and variables > Actions > New repository secret"
  echo "  Name: CLOUDFRONT_PRIVATE_KEY"
  echo "  Value: the contents of $PRIVATE_KEY_PATH"
fi
echo
echo "Then delete it:  rm $PRIVATE_KEY_PATH"
echo
echo "To deploy from a laptop instead, pass it as context:"
echo "  npx --prefix infra cdk deploy -c photoPrivateKey=\"\$(cat $PRIVATE_KEY_PATH)\""
