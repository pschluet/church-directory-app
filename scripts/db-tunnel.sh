#!/usr/bin/env bash
#
# Forwards a local port to the deployed Postgres so a database client can
# inspect the real data.
#
# The instance sits in an isolated subnet with no route to the internet and a
# security group that only admits the API Lambda, the Flyway task and the
# bastion, so a tunnel through the bastion is the only way in from a laptop.
#
# The bastion is kept stopped -- ~$3/month running, ~$0.64/month for its root
# volume when it is not -- so this starts it, waits for Session Manager to pick
# it up, and stops it again when you quit. It stops the bastion on exit even if
# something else started it, on the grounds that a bastion left running is the
# expensive mistake. The instance also stops itself after twenty idle minutes,
# in case this script is killed before its trap can run.
#
#   ./scripts/db-tunnel.sh
#   LOCAL_PORT=5433 ./scripts/db-tunnel.sh
#   SHOW_PASSWORD=1 ./scripts/db-tunnel.sh   # print the password, do not copy it
#
set -euo pipefail

ACCOUNT_ID="${ACCOUNT_ID:-435432815368}"
REGION="${REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-ChurchDirectoryStack}"
DB_NAME="${DB_NAME:-directory}"
DB_USER="${DB_USER:-postgres}"
LOCAL_PORT="${LOCAL_PORT:-15432}"
SHOW_PASSWORD="${SHOW_PASSWORD:-}"
# A cold boot registers with Session Manager a minute or so after the instance
# reports running.
SSM_WAIT_SECONDS="${SSM_WAIT_SECONDS:-180}"

export AWS_PAGER=""

# --- Preflight -------------------------------------------------------------

if ! command -v session-manager-plugin >/dev/null; then
  echo "Missing session-manager-plugin, which the AWS CLI shells out to for a" >&2
  echo "port forward: brew install --cask session-manager-plugin" >&2
  exit 1
fi

if ! command -v jq >/dev/null; then
  echo "Missing jq, needed to read one field out of the database secret: brew install jq" >&2
  exit 1
fi

actual_account="$(aws sts get-caller-identity --query Account --output text)"
if [ "$actual_account" != "$ACCOUNT_ID" ]; then
  echo "Refusing to run: credentials are for account $actual_account, expected $ACCOUNT_ID." >&2
  exit 1
fi

# --- Stack outputs ---------------------------------------------------------

read_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

instance_id="$(read_output BastionInstanceId)"
db_host="$(read_output DatabaseEndpoint)"
secret_arn="$(read_output DatabaseSecretArn)"

if [ -z "$instance_id" ] || [ "$instance_id" = "None" ]; then
  echo "No BastionInstanceId output on $STACK_NAME. Deploy the stack first." >&2
  exit 1
fi

# --- Start the bastion, and always stop it again ---------------------------

instance_state() {
  aws ec2 describe-instances \
    --region "$REGION" \
    --instance-ids "$instance_id" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text
}

stopped=no
stop_bastion() {
  if [ "$stopped" = yes ]; then
    return 0
  fi
  stopped=yes

  echo "Stopping $instance_id ..." >&2
  if ! aws ec2 stop-instances \
    --region "$REGION" \
    --instance-ids "$instance_id" \
    --query 'StoppingInstances[0].CurrentState.Name' \
    --output text >/dev/null; then
    echo "WARNING: could not stop $instance_id. Stop it by hand or it keeps billing;" >&2
    echo "failing that, it stops itself after twenty idle minutes." >&2
  fi
}

# Turning the signals into ordinary exits means the cleanup is reached through
# exactly one path, and the guard above makes a second call a no-op anyway.
trap stop_bastion EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(instance_state)" = "running" ]; then
  echo "Bastion $instance_id is already running; this tunnel will still stop it on exit."
else
  echo "Starting bastion $instance_id ..."
  aws ec2 start-instances \
    --region "$REGION" \
    --instance-ids "$instance_id" \
    --query 'StartingInstances[0].CurrentState.Name' \
    --output text >/dev/null
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$instance_id"
fi

echo "Waiting for Session Manager to see it ..."
deadline=$(($(date +%s) + SSM_WAIT_SECONDS))
until [ "$(aws ssm describe-instance-information \
  --region "$REGION" \
  --filters "Key=InstanceIds,Values=$instance_id" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text 2>/dev/null)" = "Online" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Session Manager never saw $instance_id after ${SSM_WAIT_SECONDS}s." >&2
    echo "Check that the instance still has a public IP and that its SSM agent is running." >&2
    exit 1
  fi
  sleep 5
done

# --- Credentials -----------------------------------------------------------

password="$(aws secretsmanager get-secret-value \
  --region "$REGION" \
  --secret-id "$secret_arn" \
  --query SecretString \
  --output text | jq -r .password)"

echo
echo "  host      localhost"
echo "  port      $LOCAL_PORT"
echo "  database  $DB_NAME"
echo "  user      $DB_USER"
if [ -n "$SHOW_PASSWORD" ] || ! command -v pbcopy >/dev/null; then
  echo "  password  $password"
else
  printf '%s' "$password" | pbcopy
  echo "  password  copied to the clipboard (SHOW_PASSWORD=1 prints it instead)"
fi
# The server certificate is issued for the RDS hostname, and the client
# connects to localhost, so verify-full cannot pass. The parameter group
# requires SSL, so it cannot be turned off either.
echo "  ssl mode  require -- not verify-full, see the comment in this script"
echo
echo "Forwarding localhost:$LOCAL_PORT to $db_host:5432. Ctrl-C to close it."
echo

# --- The tunnel ------------------------------------------------------------

aws ssm start-session \
  --region "$REGION" \
  --target "$instance_id" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$db_host\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
