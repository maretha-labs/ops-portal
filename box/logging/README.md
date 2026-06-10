# demo3 server logs in the portal — runbook (Bug #3)

Surfaces **direct Nuxeo server logs from the demo3 box** in the ops-portal
(Activity & Logs → **Server log** tab).

## How it works

The API Lambda runs in AWS and cannot reach the Hetzner box, so the box **pushes**
logs out instead of the Lambda pulling them:

```
demo3 k3s node                         AWS (us-east-1)                 browser
┌────────────────────────┐             ┌───────────────────┐
│ fluent-bit DaemonSet    │  PutLog     │ CloudWatch Logs   │   GET /logs   ┌──────────┐
│  tail nuxeo pod log ────┼────Events──▶│  /nuxeo/demo3     │◀──(Lambda)────│ Server log│
│  (cloudwatch_logs out)  │  (IAM user) │  retention 14d    │   FilterLog   │   tab     │
└────────────────────────┘             └───────────────────┘   Events      └──────────┘
```

- **Terraform** (`infra/logs.tf`) creates the log group `/nuxeo/demo3` and a
  least-privilege IAM user `ops-portal-log-shipper` (PutLogEvents on that group only).
- **The Lambda** (`GET /logs`) reads the group with `FilterLogEvents` (read grant in
  `infra/api.tf`); env var `NUXEO_LOG_GROUP=/nuxeo/demo3`.
- **The box** runs `fluent-bit.yaml` (this dir), which tails the Nuxeo container log
  and ships it using the shipper user's access key (a k8s Secret).

---

## One-time setup (human-gated)

### 1. Apply the AWS side (from your workstation, in `ops-portal/`)

```bash
export CLOUDFLARE_API_TOKEN=...   # Zone:DNS:Edit token for your zone
make apply        # creates the log group + shipper user, redeploys the Lambda (now with /logs)
```

Grab the shipper credentials (used by the box in step 2):

```bash
cd infra
terraform output -raw log_shipper_access_key_id       ; echo
terraform output -raw log_shipper_secret_access_key   ; echo
terraform output -raw nuxeo_log_group                 ; echo   # expect: /nuxeo/demo3
cd ..
```

### 2. Create the shipper Secret + start fluent-bit (on the box)

Copy `fluent-bit.yaml` to the box, then:

```bash
ssh your-box
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

kubectl create ns logging --dry-run=client -o yaml | kubectl apply -f -

kubectl -n logging create secret generic fluent-bit-aws \
  --from-literal=AWS_ACCESS_KEY_ID='<log_shipper_access_key_id from step 1>' \
  --from-literal=AWS_SECRET_ACCESS_KEY='<log_shipper_secret_access_key from step 1>'

kubectl apply -f fluent-bit.yaml
```

### 3. Publish the SPA (the Server-log tab) — from your workstation

```bash
make web          # republishes the SPA + invalidates CloudFront
```

---

## Verify

```bash
# on the box: fluent-bit should be Running with no output errors
kubectl -n logging get pods -l app=fluent-bit
kubectl -n logging logs -l app=fluent-bit --tail=40        # look for "[output:cloudwatch_logs]" OK, no AccessDenied

# AWS side: a stream should appear within ~1 min
aws logs describe-log-streams --log-group-name /nuxeo/demo3 \
  --order-by LastEventTime --descending --max-items 3 --region us-east-1

# Lambda route end-to-end
aws lambda invoke --function-name ops-portal-api --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"rawPath":"/logs","requestContext":{"http":{"method":"GET"}}}' /tmp/logs.json >/dev/null \
  && cat /tmp/logs.json
```

Then open the portal → **Activity & Logs → Server log**.

---

## Gotchas

- **Pod-name glob.** The tail `Path` is `/var/log/containers/nuxeo-*_nuxeo_*.log`
  (pod starts `nuxeo-`, namespace `nuxeo`). If the Nuxeo pod/namespace is named
  differently, edit the `Path` in the ConfigMap and `kubectl rollout restart ds/fluent-bit -n logging`.
- **`auto_create_group false`.** fluent-bit does NOT create the group — Terraform owns
  it. If you see `ResourceNotFoundException`, run `make apply` first.
- **Container stdout only.** This ships the pod's console output (what `kubectl logs`
  shows), which for Nuxeo is the server console. The on-disk `server.log` file would
  need a sidecar that tails the file — out of scope here.
- **Cost.** Retention is 14 days (`var.nuxeo_log_retention_days`). Ingest is whatever
  Nuxeo logs; for a lab that's negligible. Lower the level in Nuxeo if it ever isn't.
- **Credentials.** The shipper user can ONLY `PutLogEvents` to `/nuxeo/demo3`. Rotate by
  re-running `terraform apply` after tainting `aws_iam_access_key.log_shipper`, then
  recreate the Secret.
