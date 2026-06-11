<img width="1681" height="912" alt="MarethaOpsDashboard_Claude" src="https://github.com/user-attachments/assets/c40c7c6a-84f5-4758-9f17-46e27ad3ee6f" />

# Operations Portal 

A small, Google-authenticated web portal that gives a whole team safe hands on a Nuxeo lab:
upload add-on packages, deploy, pin a Studio release, roll back, watch the pipeline run step by
step, read live server logs, and see who did what - one page, no git or CLI access required.

This is the sanitized public mirror of the portal we run at `operations.maretha.io` for our own
lab at [Maretha](https://maretha.io). We implement and migrate content platforms for a living;
this is the operational scaffolding we built for ourselves.
<!-- blog link goes here when the build-story post is live -->

Built working with Claude Code. We specified the architecture and reviewed every line; Claude
wrote the Terraform, the Lambda API, and the front end with us, and helped debug what broke.

## What it does

```
team Google account -> portal (CloudFront + S3 static SPA)
   -> Cognito Hosted UI <-> Google   (sign-in restricted to your email domain)
   -> API Gateway (JWT authorizer) -> one Lambda
        -> presigned PUT to the add-ons S3 bucket
        -> GitHub Actions workflow_dispatch   (token from SSM)
   -> your existing deploy pipeline pulls the artifacts and does the real work
```

The portal never touches the cluster. It writes artifacts to S3 and dispatches the GitHub
Actions workflows you already trust. Audit events land in DynamoDB. Server logs ship from the
box into CloudWatch (fluent-bit DaemonSet) and the portal reads them back out.

## Layout

| Path | What |
|---|---|
| `infra/` | Terraform - all AWS resources + the Cloudflare DNS/ACM-validation records |
| `lambda/api/` | API Lambda: presign, deploy triggers, status, installed-bundles, server logs, audit |
| `lambda/presignup/` | Cognito pre-sign-up trigger - rejects sign-ins outside your email domain |
| `web/` | Vanilla-JS SPA, no build step (branded for our lab - restyle for yours) |
| `box/logging/` | fluent-bit DaemonSet + runbook: ship server logs to CloudWatch |
| `.github/workflows/` | Portal CI: terraform apply + SPA publish (dispatch-only in this mirror) |
| `SETUP.md` | Start here - the human-gated setup steps |

## Cost

CloudFront, Lambda, Cognito (social), ACM, and SSM sit in always-free tiers at team scale;
S3, API Gateway, and DynamoDB are pennies. About $0-1/month.

## Security notes - read before deploying

- The Installed panel calls your Nuxeo's management API server-side with admin credentials read
  from SSM. The browser never sees them, but the Lambda holds admin access to the target server.
  That is a trade-off we accepted for a lab; for anything more, create a dedicated read-only
  Nuxeo user and scope the credential down.
- The GitHub PAT in SSM can dispatch workflows on your deploy repo. Use a fine-grained token
  scoped to that one repo with Actions read/write only. A GitHub App is the better long-term answer.
- `terraform.tfstate` contains the Google client secret. Use an encrypted remote backend, or keep
  state local and out of git (the `.gitignore` here already covers it).
- Sign-in is double-gated: a Google Workspace "Internal" consent screen plus a Cognito
  pre-sign-up trigger that rejects any email outside your domain.

## Adapting it to your stack

Set the required variables in `infra/terraform.tfvars` (domain, allowed email domain, artifacts
bucket, deploy repo), point the workflow names in `lambda/api/index.mjs` at your pipeline, and
restyle `web/`. Only the Studio dropdown and the installed-bundles panel are Nuxeo-specific;
any platform with an API and a CI pipeline fits the same shape.

One hard-won tip for the deploy side: make every build produce a unique image tag (commit SHA
plus run number). Identical tags mean the cluster sees nothing new and quietly does nothing.

## License

MIT - see [LICENSE](./LICENSE).
