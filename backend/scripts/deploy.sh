#!/bin/bash
# backend/scripts/deploy.sh
# Deploys the video-convert-893 CDK stack and writes video_convert_outputs.json.
#
# Idempotent:
#   - API Gateway: checked by name, imports real logical ID if found
#   - Cognito:     same family pool (authorizer only; no extra app client)
#
# Usage:
#   cd backend && ./scripts/deploy.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${BACKEND_DIR}/.." && pwd)"
CONFIG_FILE="${BACKEND_DIR}/bin/config.ts"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║       video-convert-893 — Backend Deploy     ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

if [ ! -f "$CONFIG_FILE" ]; then
  echo "  ❌ backend/bin/config.ts not found."
  echo "     Run: cp backend/bin/config.example.ts backend/bin/config.ts"
  echo "     Then fill in your values and re-run."
  exit 1
fi

CONFIG_ID=$(grep -E '^\s+id:' "$CONFIG_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')
AWS_REGION=$(grep -E '^\s+awsRegion:' "$CONFIG_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')
USER_POOL_ID=$(grep -E '^\s+userPoolId:' "$CONFIG_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')
PRIVATE_BUCKET=$(grep -E '^\s+privateBucket:' "$CONFIG_FILE" | head -1 | sed 's/.*"\(.*\)".*/\1/')

if [ -z "$CONFIG_ID" ] || [ -z "$AWS_REGION" ] || [ -z "$USER_POOL_ID" ] || [ -z "$PRIVATE_BUCKET" ]; then
  echo "  ❌ Could not read required values from config.ts."
  exit 1
fi

STACK_NAME="VideoConvertStack-${CONFIG_ID}"
INGEST_BUCKET="${CONFIG_ID}-video-ingest"
API_NAME="${CONFIG_ID}-video-convert-api"

echo "  Stack:          $STACK_NAME"
echo "  Region:         $AWS_REGION"
echo "  ID prefix:      $CONFIG_ID"
echo "  User Pool:      $USER_POOL_ID"
echo "  Output bucket:  $PRIVATE_BUCKET"
echo "  Ingest bucket:  $INGEST_BUCKET (created, retained)"
echo "  CLI output:     Videos/"
echo "  Web output:     users/{cognito-sub}/Videos/"
echo ""
echo "  Docker must be running (Fargate ffmpeg image)."
echo ""

echo "  Checking API Gateway '$API_NAME'..."

EXISTING_API_ID=$(aws apigateway get-rest-apis \
  --region "$AWS_REGION" \
  --query "items[?name=='${API_NAME}'].id" \
  --output text 2>/dev/null || true)

VIDEO_CONVERT_API_LOGICAL_ID=""

if [ -n "$EXISTING_API_ID" ] && [ "$EXISTING_API_ID" != "None" ]; then
  echo "  ✅ API Gateway exists: $EXISTING_API_ID"
  VIDEO_CONVERT_API_LOGICAL_ID=$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query "StackResources[?ResourceType=='AWS::ApiGateway::RestApi'].LogicalResourceId" \
    --output text 2>/dev/null || true)
  if [ -n "$VIDEO_CONVERT_API_LOGICAL_ID" ] && [ "$VIDEO_CONVERT_API_LOGICAL_ID" != "None" ]; then
    echo "  ✅ Logical ID: $VIDEO_CONVERT_API_LOGICAL_ID"
  else
    echo "  ⚠️  Could not fetch logical ID — CDK will manage normally."
    VIDEO_CONVERT_API_LOGICAL_ID=""
  fi
else
  echo "  ℹ️  API Gateway not found — CDK will create on first deploy."
  EXISTING_API_ID=""
fi

echo ""
echo "  Resources after this deploy:"
if [ -n "$EXISTING_API_ID" ]; then
  echo "    API Gateway:     $EXISTING_API_ID (preserved)"
else
  echo "    API Gateway:     will be created by CDK"
fi
echo "    Ingest bucket:   $INGEST_BUCKET (CORS for browser multipart)"
echo "    Jobs table:      ${CONFIG_ID}-video-convert-jobs (GSI userId-createdAt-index)"
echo ""
read -p "  Proceed? (y/n): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then echo "  Cancelled."; exit 0; fi

cd "$BACKEND_DIR"
[ ! -d "node_modules" ] && npm install

for dir in lambda/startJob lambda/uploadApi; do
  echo "  Installing $dir deps..."
  (cd "$dir" && npm install --omit=dev)
done

ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$AWS_REGION")

echo ""
echo "  Deploying CDK stack..."
CDK_DEFAULT_ACCOUNT="$ACCOUNT" \
CDK_DEFAULT_REGION="$AWS_REGION" \
VIDEO_CONVERT_API_LOGICAL_ID="$VIDEO_CONVERT_API_LOGICAL_ID" \
  npx cdk deploy "$STACK_NAME" --require-approval never

if [ -z "$EXISTING_API_ID" ]; then
  echo ""
  echo "  Resolving new API Gateway ID..."
  EXISTING_API_ID=$(aws apigateway get-rest-apis \
    --region "$AWS_REGION" \
    --query "items[?name=='${API_NAME}'].id" \
    --output text)
  echo "  ✅ API Gateway created: $EXISTING_API_ID"
fi

get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

API_URL=$(get_output "VideoConvertApiUrl")
INGEST_OUT=$(get_output "VideoConvertIngestBucket")
OUTPUT_OUT=$(get_output "VideoConvertOutputBucket")
PREFIX_OUT=$(get_output "VideoConvertOutputPrefix")
TABLE=$(get_output "VideoConvertJobsTable")

cat > "${REPO_ROOT}/video_convert_outputs.json" << OUTPUTS
{
  "version": "1",
  "aws_region": "${AWS_REGION}",
  "api": {
    "base_url": "${API_URL}"
  },
  "storage": {
    "ingest_bucket": "${INGEST_OUT}",
    "output_bucket": "${OUTPUT_OUT}",
    "output_prefix": "${PREFIX_OUT}",
    "jobs_table": "${TABLE}"
  }
}
OUTPUTS

echo ""
echo "  ✅ video_convert_outputs.json written to repo root"
echo ""
echo "  API:     ${API_URL}"
echo "  Ingest:  s3://${INGEST_OUT}/incoming/{disc}/  (CLI)"
echo "           s3://${INGEST_OUT}/incoming/{sub}/{jobId}/  (web)"
echo "  Output:  s3://${OUTPUT_OUT}/${PREFIX_OUT}  (CLI discs)"
echo "           s3://${OUTPUT_OUT}/users/{sub}/Videos/  (web)"
echo "  Jobs:    ${TABLE}"
echo ""
echo "  Next: set dest Amplify VIDEO_CONVERT_API_URL to the API URL above."
echo "        CLI discs: ./scripts/ingest.sh \"/Volumes/DVD Video Recording\""
echo ""
