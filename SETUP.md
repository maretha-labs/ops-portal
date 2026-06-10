# SETUP - bringing the portal live

This is the human-gated runbook. The code is all written; these are the steps that need your
credentials and console access. Do them in order. Examples use AWS account `123456789012`,
region `us-east-1`, and portal domain `ops.example.com` - substitute yours throughout.

The Cognito Hosted-UI domain is deterministic, so you can create the Google client **before**
`terraform apply`. The predicted values are:

```
Hosted UI base : https://ops-portal-123456789012.auth.us-east-1.amazoncognito.com
Google redirect: https://ops-portal-123456789012.auth.us-east-1.amazoncognito.com/oauth2/idpresponse
Google JS origin: https://ops-portal-123456789012.auth.us-east-1.amazoncognito.com
Portal URL     : https://ops.example.com
```

---

## 0. Prerequisites
- Tools: `terraform`, `aws` CLI (an admin-capable profile), `node`/`npm`, `gh`, `make`.
- On the box that runs your deploy pipeline: install the AWS CLI (the runner needs it for the
  S3 add-on sync).

## 1. Google OAuth client  *(console)*
Google Cloud Console -> **APIs & Services -> Credentials**:
1. Configure the **OAuth consent screen** -> User type **Internal** (restricts sign-in to your
   Google Workspace - belt-and-suspenders with the pre-sign-up trigger).
2. **Create Credentials -> OAuth client ID -> Web application**.
3. **Authorized JavaScript origins** = the JS origin above.
   **Authorized redirect URIs** = the Google redirect above.
4. Save the **Client ID** and **Client secret**.

## 2. Cloudflare token + zone  *(console)*
- Cloudflare -> your zone -> **Overview** -> copy the **Zone ID**.
- **My Profile -> API Tokens -> Create Token** -> template *Edit zone DNS* -> your zone. Copy it.
- Export it for Terraform/the Cloudflare provider:
  ```bash
  export CLOUDFLARE_API_TOKEN=...   # never put this in tfvars
  ```

## 3. Fill tfvars
```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# edit: cloudflare_zone_id, google_client_id, google_client_secret,
#       domain_name, allowed_email_domain, artifacts_bucket_name, github_repo
# optional: nuxeo_url (Installed panel), studio_project_id (Studio dropdown)
```

## 4. Apply the infrastructure
```bash
make apply       # = npm install (lambda) + terraform init + apply
```
ACM validation through Cloudflare takes a few minutes the first time. Review the plan before
approving - it creates the buckets, Cognito, CloudFront, API Gateway, Lambda, IAM, DynamoDB,
and the portal + ACM-validation DNS records.

> **State note:** `terraform.tfstate` will contain the Google client secret. Use the encrypted
> S3 backend stub in `versions.tf`, or keep state local + gitignored (it already is).

## 5. Put the runtime secrets in SSM
Terraform created these as `REPLACE_ME` placeholders; set the real values (the API Lambda reads
them at runtime - they never enter Terraform state):
```bash
# GitHub fine-grained PAT: your deploy repo only, permission Actions: Read and write
aws ssm put-parameter --name /ops-portal/github-token   --type SecureString --overwrite --value "github_pat_..."
# Nuxeo Connect creds (for the Studio version dropdown) - optional
aws ssm put-parameter --name /ops-portal/connect-user   --type SecureString --overwrite --value "you@example.com"
aws ssm put-parameter --name /ops-portal/connect-token  --type SecureString --overwrite --value "..."
# Target Nuxeo admin password (Installed panel; see Security notes in README) - optional
aws ssm put-parameter --name /ops-portal/nuxeo-admin-pw --type SecureString --overwrite --value "..."
```

## 6. Wire the deploy pipeline's S3 access  *(deploy-repo secrets)*
The deploy runner pulls add-ons from the bucket using the read-only user Terraform created:
```bash
cd infra
gh secret set AWS_ACCESS_KEY_ID     -R your-org/your-deploy-repo --body "$(terraform output -raw addons_ro_access_key_id)"
gh secret set AWS_SECRET_ACCESS_KEY -R your-org/your-deploy-repo --body "$(terraform output -raw addons_ro_secret_access_key)"
```

## 7. Publish the SPA
```bash
make web         # renders web/config.js from outputs, syncs to S3, invalidates CloudFront
```

## 8. Hook your deploy pipeline
The portal dispatches three workflows on your deploy repo: `deploy.yaml`, `build-base.yaml`,
`rollback.yaml` (names in `lambda/api/index.mjs`). Your deploy workflow needs an S3 sync step
that pulls `addons/` from the artifacts bucket before it builds, and `rollback.yaml` needs
`workflow_dispatch`. Make sure every build produces a **unique image tag** (commit SHA + run
number) - identical tags mean the cluster sees nothing new and quietly does nothing. We learned
that one the fun way.

## 9. Verify end-to-end
1. Open your portal URL -> **Sign in with Google** with an allowed-domain account
   (an outside account must be rejected).
2. Drag a known-good package `.zip` onto the upload card -> it lands in
   `s3://<your-bucket>/addons/` and a deploy run starts.
3. Watch the **Status** panel go green (and the runner indicator).
4. Confirm the result via your Nuxeo's `/api/v1/management/distribution` and
   `runningstatus` = 200.
5. Try **Redeploy**, **Studio version**, **Rollback**; confirm each fires the right workflow.

---

## Hardening / later
- **GitHub App instead of the PAT** - org-owned, no 1-year expiry, not bound to one user.
- **Encrypted Terraform backend** (S3) so state secrets aren't on a laptop.
- **Optional WAF** on CloudFront (~$5/mo) if you want IP allow-listing on top of Cognito.
- **OIDC for the portal CI** instead of static AWS keys in repo secrets.
- **A dedicated read-only Nuxeo user** for the Installed panel instead of Administrator.
