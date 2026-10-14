#!/usr/bin/env bash
#
# Moves every account still in FORCE_CHANGE_PASSWORD to CONFIRMED.
#
# Sign-in is Cognito's custom auth flow (a 6-digit code; see
# api/src/auth-challenge.ts), and Cognito answers a custom-auth sign-in from
# FORCE_CHANGE_PASSWORD with NEW_PASSWORD_REQUIRED instead of tokens. That is
# the state AdminCreateUser leaves every invitee in. New invites are confirmed
# by the API as they are created (api/src/cognito.ts); this does the same once
# for everyone invited before that.
#
# Each account gets a random password that is printed nowhere and stored
# nowhere. The app client has no password flow, so it cannot be used to sign
# in; Cognito simply will not confirm an account without one.
#
# Run once, after the deploy that switches sign-in to the custom flow.
# Idempotent: confirmed accounts are not listed, so re-running is harmless.
#
#   ./scripts/confirm-invited-users.sh
#
set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:-435432815368}"
REGION="${REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-ChurchDirectoryStack}"

export AWS_PAGER=""
export AWS_REGION="$REGION"

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [ "$actual_account" != "$ACCOUNT_ID" ]; then
  echo "Refusing to run: credentials are for account $actual_account, expected $ACCOUNT_ID." >&2
  exit 1
fi

USER_POOL_ID="${USER_POOL_ID:-$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)}"

# The CLI pages through every result itself; the filter is server-side.
usernames="$(aws cognito-idp list-users --user-pool-id "$USER_POOL_ID" \
  --filter 'cognito:user_status = "FORCE_CHANGE_PASSWORD"' \
  --query "Users[].Username" --output text)"

count=0
for username in $usernames; do
  # Mixed classes so it passes any password policy the pool might have.
  password="$(openssl rand -base64 32 | tr -d '\n=+/')aA1!"
  aws cognito-idp admin-set-user-password --user-pool-id "$USER_POOL_ID" \
    --username "$username" --password "$password" --permanent
  count=$((count + 1))
done

echo "Confirmed $count account(s) in $USER_POOL_ID."
