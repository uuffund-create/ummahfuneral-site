#!/usr/bin/env bash
# Sets up (or updates) the UUFFUNDS payments server in Google Cloud.
#
# Run it in Google Cloud Shell with ONE of these lines:
#   bash <(curl -fsSL https://raw.githubusercontent.com/uuffund-create/ummahfuneral-site/main/server/deploy.sh) test
#   bash <(curl -fsSL https://raw.githubusercontent.com/uuffund-create/ummahfuneral-site/main/server/deploy.sh) live
#
# What it does, step by step:
#   1. Turns on the Google Cloud services the server needs (one time).
#   2. Asks you to paste your Stripe secret key (test or live). The key is
#      typed in hidden and saved only in Google Secret Manager.
#   3. Lets the server read that key, and nothing else.
#   4. Builds and starts the server from server/stripe-api in this repository,
#      open to the website (it checks log-ins itself).
set -euo pipefail

PROJECT="united-ummah-funeral-funds"
REGION="us-central1"
SERVICE="stripe-api"
REPO_URL="https://github.com/uuffund-create/ummahfuneral-site.git"
MODE="${1:-}"

if [[ "$MODE" != "test" && "$MODE" != "live" ]]; then
  echo "Please add 'test' or 'live' at the end of the command."
  exit 1
fi
SECRET="STRIPE_SECRET_KEY_$(echo "$MODE" | tr '[:lower:]' '[:upper:]')"

echo "== 1/4  Using project $PROJECT"
gcloud config set project "$PROJECT" --quiet >/dev/null

echo "== 2/4  Turning on the Google Cloud services this needs (can take a minute the first time)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com compute.googleapis.com --quiet

echo
echo "In Stripe, open Developers > API keys (in $MODE mode) and copy the secret key."
read -r -s -p "Paste your Stripe $MODE secret key here, then press Enter (it stays hidden): " KEY
echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
if [[ ! "$KEY" =~ ^(sk|rk)_${MODE}_ ]]; then
  echo "That does not look like a Stripe $MODE secret key (it should start with sk_${MODE}_ or rk_${MODE}_). Nothing was changed."
  exit 1
fi
if gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET" --data-file=- --quiet >/dev/null
else
  printf '%s' "$KEY" | gcloud secrets create "$SECRET" --replication-policy=automatic --data-file=- --quiet >/dev/null
fi
unset KEY
echo "Saved the key in Secret Manager as $SECRET."

echo "== 3/4  Letting the server read the Stripe keys"
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${NUMBER}-compute@developer.gserviceaccount.com"
SECRETS=""
for S in STRIPE_SECRET_KEY_TEST STRIPE_SECRET_KEY_LIVE; do
  if gcloud secrets describe "$S" >/dev/null 2>&1; then
    gcloud secrets add-iam-policy-binding "$S" --member="serviceAccount:${RUNTIME_SA}" \
      --role="roles/secretmanager.secretAccessor" --quiet >/dev/null
    SECRETS="${SECRETS:+$SECRETS,}${S}=${S}:latest"
  fi
done

echo "== 4/4  Building and starting the payments server (takes 2 to 4 minutes)"
WORK="$(mktemp -d)"
git clone --depth 1 --quiet "$REPO_URL" "$WORK/site"
gcloud run deploy "$SERVICE" \
  --source "$WORK/site/server/stripe-api" \
  --function stripeApi \
  --base-image nodejs22 \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-secrets "$SECRETS" \
  --memory 256Mi \
  --max-instances 3 \
  --quiet
rm -rf "$WORK"

echo
echo "All done. The payments server is running at:"
echo "  https://${SERVICE}-${NUMBER}.${REGION}.run.app"
echo "You can close Cloud Shell now."
