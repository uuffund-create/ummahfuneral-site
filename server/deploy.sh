#!/usr/bin/env bash
# Sets up (or updates) the UUFFUNDS payments server in Google Cloud.
#
# Run it in Google Cloud Shell with ONE of these lines:
#   bash <(curl -fsSL https://raw.githubusercontent.com/uuffund-create/ummahfuneral-site/main/server/deploy.sh) update
#   bash <(curl -fsSL https://raw.githubusercontent.com/uuffund-create/ummahfuneral-site/main/server/deploy.sh) email
#   bash <(curl -fsSL https://raw.githubusercontent.com/uuffund-create/ummahfuneral-site/main/server/deploy.sh) test
#   bash <(curl -fsSL https://raw.githubusercontent.com/uuffund-create/ummahfuneral-site/main/server/deploy.sh) live
#
#   update   Rebuilds the server from the latest code in this repository and
#            keeps every setting and key as it is. Use it after changing
#            server/stripe-api.
#   email    Asks for your Resend API key (resend.com), saves it in Google
#            Secret Manager and gives it to the server, so it can send payment
#            reminders and death reports. The code is not changed.
#   test / live  The first-time setup with a Stripe secret key:
#
# What test / live do, step by step:
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

if [[ "$MODE" != "test" && "$MODE" != "live" && "$MODE" != "update" && "$MODE" != "email" ]]; then
  echo "Please add 'update', 'email', 'test' or 'live' at the end of the command."
  exit 1
fi

if [[ "$MODE" == "update" ]]; then
  echo "== 1/2  Using project $PROJECT"
  gcloud config set project "$PROJECT" --quiet >/dev/null
  echo "== 2/2  Rebuilding the payments server from the latest code (takes 2 to 4 minutes)"
  WORK="$(mktemp -d)"
  git clone --depth 1 --quiet "$REPO_URL" "$WORK/site"
  # No key, secret or setting flags here, so everything already set stays as it is.
  gcloud run deploy "$SERVICE" \
    --source "$WORK/site/server/stripe-api" \
    --function stripeApi \
    --base-image nodejs22 \
    --region "$REGION" \
    --quiet
  rm -rf "$WORK"
  echo
  echo "All done. The payments server is running the latest code with the same settings."
  echo "You can close Cloud Shell now."
  exit 0
fi

if [[ "$MODE" == "email" ]]; then
  echo "== 1/4  Using project $PROJECT"
  gcloud config set project "$PROJECT" --quiet >/dev/null
  gcloud services enable secretmanager.googleapis.com --quiet
  echo
  echo "In Resend, open API Keys and create a key with Sending access."
  read -r -s -p "Paste your Resend API key here, then press Enter (it stays hidden): " KEY
  echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  if [[ ! "$KEY" =~ ^re_ ]]; then
    echo "That does not look like a Resend API key (it should start with re_). Nothing was changed."
    exit 1
  fi
  echo "== 2/4  Saving the key in Secret Manager"
  if gcloud secrets describe RESEND_API_KEY >/dev/null 2>&1; then
    printf '%s' "$KEY" | gcloud secrets versions add RESEND_API_KEY --data-file=- --quiet >/dev/null
  else
    printf '%s' "$KEY" | gcloud secrets create RESEND_API_KEY --replication-policy=automatic --data-file=- --quiet >/dev/null
  fi
  unset KEY
  echo "== 3/4  Letting the server read the key"
  RUNTIME_SA="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(spec.template.spec.serviceAccountName)')"
  if [[ -z "$RUNTIME_SA" ]]; then
    RUNTIME_SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
  fi
  gcloud secrets add-iam-policy-binding RESEND_API_KEY --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" --quiet >/dev/null
  echo "== 4/4  Giving the key to the payments server"
  gcloud run services update "$SERVICE" --region "$REGION" \
    --update-secrets "RESEND_API_KEY=RESEND_API_KEY:latest" --quiet
  echo
  echo "All done. Emails will go out as soon as ummahfuneral.org shows as Verified in Resend."
  echo "You can close Cloud Shell now."
  exit 0
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

echo "== 3/4  Letting the server read its keys"
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${NUMBER}-compute@developer.gserviceaccount.com"
SECRETS=""
for S in STRIPE_SECRET_KEY_TEST STRIPE_SECRET_KEY_LIVE RESEND_API_KEY; do
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
