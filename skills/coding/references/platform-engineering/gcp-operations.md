---
name: gcp-operations
description: Use when asked to check GCP status/logs, operate Cloud Run, manage secrets, or deploy services. Generic GCP workflows with project/region discovery steps.
metadata:
  version: "2.0.0"
---

# GCP Operations (Generic)

Use this skill for Cloud Run ops, logs, deployments, Secret Manager, and basic storage/IAM tasks. Do **not** assume a project or region; discover them first.

## 0) Discover context (required)

```bash
# Current gcloud context (project/region/zone if set)
gcloud config list

# List available projects
gcloud projects list

# Set project (if needed)
gcloud config set project <PROJECT_ID>

# Get current project
PROJECT_ID="$(gcloud config get-value project)"

# Get a default region (Cloud Run prefers run/region; fallback to compute/region)
REGION="$(gcloud config get-value run/region 2>/dev/null || gcloud config get-value compute/region 2>/dev/null)"

# If REGION is empty, ask the user or list regions
# (Cloud Run regions list may not be enabled on all accounts)
# gcloud run regions list
```

Use `$PROJECT_ID` and `$REGION` in all subsequent commands.

## Cloud Run

### List and describe services

```bash
# List services
gcloud run services list --project="$PROJECT_ID" --region="$REGION"

# Describe a service
gcloud run services describe <SERVICE_NAME> \
  --project="$PROJECT_ID" \
  --region="$REGION"

# Service URL
gcloud run services describe <SERVICE_NAME> \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.url)'
```

### Deploy (manual)

```bash
# Deploy a container image to Cloud Run
gcloud run deploy <SERVICE_NAME> \
  --image <IMAGE_URI> \
  --project="$PROJECT_ID" \
  --region="$REGION"
```

## Logs

### Tail logs

```bash
# Tail logs for a service
gcloud beta run services logs tail <SERVICE_NAME> \
  --project="$PROJECT_ID" \
  --region="$REGION"
```

### Read recent logs

```bash
# Last 50 log entries for a service
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=<SERVICE_NAME>" \
  --project="$PROJECT_ID" \
  --limit=50

# Filter by severity (ERROR, WARNING, INFO, DEBUG)
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=<SERVICE_NAME> AND severity>=ERROR" \
  --project="$PROJECT_ID" \
  --limit=20

# Filter by time range (last hour)
# GNU date (Linux)
START_TIME="$(date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%SZ')"
# BSD date (macOS)
# START_TIME="$(date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ')"
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=<SERVICE_NAME> AND timestamp>=\"$START_TIME\"" \
  --project="$PROJECT_ID" \
  --limit=100
```

## Secret Manager

Follow `references/secrets-and-auth-guardrails.md`. Do not read or print secret values.

```bash
# List secrets
gcloud secrets list --project="$PROJECT_ID"

# Describe a secret (metadata only)
gcloud secrets describe <SECRET_NAME> --project="$PROJECT_ID"

# List recent versions (metadata only)
gcloud secrets versions list <SECRET_NAME> --project="$PROJECT_ID" --limit=5

# Create a secret from stdin (run locally; never paste secrets into chat/logs)
printf '%s' '<secret-value>' | gcloud secrets create <SECRET_NAME> \
  --data-file=- \
  --project="$PROJECT_ID"

# Add new version
printf '%s' '<new-secret-value>' | gcloud secrets versions add <SECRET_NAME> \
  --data-file=- \
  --project="$PROJECT_ID"

# Delete a secret
gcloud secrets delete <SECRET_NAME> --project="$PROJECT_ID"
```

## Cloud Storage (GCS)

```bash
# List buckets in project
gsutil ls -p "$PROJECT_ID"

# List bucket contents
gsutil ls gs://<BUCKET_NAME>/

# Download/upload
gsutil cp gs://<BUCKET_NAME>/<path> ./local-file
gsutil cp ./local-file gs://<BUCKET_NAME>/<path>

# Bucket size
gsutil du -s gs://<BUCKET_NAME>/
```

## IAM (Cloud Run invoker example)

```bash
gcloud run services add-iam-policy-binding <SERVICE_NAME> \
  --member="serviceAccount:<SERVICE_ACCOUNT_EMAIL>" \
  --role="roles/run.invoker" \
  --project="$PROJECT_ID" \
  --region="$REGION"
```

## Troubleshooting

- If a command fails, confirm `PROJECT_ID` and `REGION` are set.
- Re-auth if needed:
  ```bash
  gcloud auth login
  gcloud auth application-default login
  gcloud auth list
  ```
- Check service status:
  ```bash
  gcloud run services describe <SERVICE_NAME> --project="$PROJECT_ID" --region="$REGION"
  ```
