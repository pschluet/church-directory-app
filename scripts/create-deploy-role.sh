#!/usr/bin/env bash
#
# Creates the IAM role GitHub Actions assumes to deploy, and the account's
# GitHub OIDC provider if it is missing.
#
# Why this is a script rather than part of the CDK stack:
#
#   * Both are account-level and unique by name. The OIDC provider is shared
#     with other projects in this account, so a stack that creates it fails
#     with EntityAlreadyExists.
#   * CDK owning the role would be circular. The workflow can only deploy once
#     the role exists, so the first deploy would have to come from a developer
#     laptop -- which is the one machine that may not be able to publish assets
#     to S3 and ECR. Creating the role here uses IAM calls only.
#
# Idempotent: safe to re-run, and re-running is how you update the policy.
#
#   ./scripts/create-deploy-role.sh
#
set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:-435432815368}"
REGION="${REGION:-us-east-1}"
GITHUB_REPO="${GITHUB_REPO:-pschluet/church-directory-app}"
ROLE_NAME="${ROLE_NAME:-church-directory-github-deploy}"
POLICY_NAME="deploy"
STACK_NAME="${STACK_NAME:-ChurchDirectoryStack}"
# CloudFormation lowercases the stack name when it generates bucket names.
STACK_PREFIX_LOWER="$(echo "$STACK_NAME" | tr '[:upper:]' '[:lower:]')"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

export AWS_PAGER=""

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [ "$actual_account" != "$ACCOUNT_ID" ]; then
  echo "Refusing to run: credentials are for account $actual_account, expected $ACCOUNT_ID." >&2
  exit 1
fi

# --- OIDC provider ---------------------------------------------------------
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "OIDC provider already exists."
else
  echo "Creating the GitHub OIDC provider..."
  aws iam create-open-id-connect-provider \
    --url "https://token.actions.githubusercontent.com" \
    --client-id-list "sts.amazonaws.com" \
    >/dev/null
fi

# --- Trust policy ----------------------------------------------------------
# GitHub sometimes presents the immutable owner/repo id form
# ("repo:owner@123/repo@456:ref:...") rather than plain "repo:owner/repo:*",
# so match both.
github_owner="${GITHUB_REPO%%/*}"
github_repo_name="${GITHUB_REPO##*/}"

trust_policy=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${OIDC_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:${GITHUB_REPO}:*",
            "repo:${github_owner}@*/${github_repo_name}@*:*"
          ]
        }
      }
    }
  ]
}
JSON
)

# --- Permissions -----------------------------------------------------------
# `cdk deploy` does its work by assuming the CDK bootstrap roles, which is the
# least-privilege pattern -- this role holds no service permissions of its own
# beyond the handful of things the workflow does directly after the deploy.
#
# Some resource names do not exist until the first deploy, so they are matched
# by the prefix CloudFormation generates from the stack name.
permissions_policy=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/cdk-hnb659fds-*"
    },
    {
      "Sid": "ReadBootstrapAndStackState",
      "Effect": "Allow",
      "Action": ["cloudformation:DescribeStacks"],
      "Resource": [
        "arn:aws:cloudformation:${REGION}:${ACCOUNT_ID}:stack/CDKToolkit/*",
        "arn:aws:cloudformation:${REGION}:${ACCOUNT_ID}:stack/${STACK_NAME}/*"
      ]
    },
    {
      "Sid": "PublishTheSpa",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::${STACK_PREFIX_LOWER}-sitebucket*",
        "arn:aws:s3:::${STACK_PREFIX_LOWER}-sitebucket*/*"
      ]
    },
    {
      "Sid": "InvalidateTheCache",
      "Effect": "Allow",
      "Action": ["cloudfront:CreateInvalidation"],
      "Resource": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/*"
    },
    {
      "Sid": "RunTheMigrationTask",
      "Effect": "Allow",
      "Action": ["ecs:RunTask", "ecs:DescribeTasks", "ecs:DescribeTaskDefinition"],
      "Resource": [
        "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${STACK_NAME}*:*",
        "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task/${STACK_NAME}*/*"
      ]
    },
    {
      "Sid": "ReadMigrationLogs",
      "Effect": "Allow",
      "Action": ["logs:GetLogEvents", "logs:DescribeLogStreams"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*"
    },
    {
      "Sid": "PassTheTaskRoles",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${STACK_NAME}-*",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" }
      }
    }
  ]
}
JSON
)

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "Role $ROLE_NAME exists; updating its trust and permissions..."
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "$trust_policy" >/dev/null
else
  echo "Creating role $ROLE_NAME..."
  aws iam create-role --role-name "$ROLE_NAME" \
    --description "Deploys ${GITHUB_REPO} from GitHub Actions" \
    --max-session-duration 3600 \
    --assume-role-policy-document "$trust_policy" >/dev/null
fi

aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$permissions_policy" >/dev/null

echo
echo "Done. Role ARN:"
aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text
