// ops-portal API Lambda (API Gateway HTTP API, payload format 2.0).
// Every route is already gated by the Cognito JWT authorizer; we additionally
// record the caller's email for audit. The portal never touches the cluster —
// it writes artifacts to S3 and dispatches GitHub Actions workflows.

import {
  S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { randomUUID } from "node:crypto";

const {
  ARTIFACTS_BUCKET, ARTIFACTS_REGION, GITHUB_REPO,
  GH_TOKEN_PARAM, CONNECT_USER_PARAM, CONNECT_TOKEN_PARAM,
  AUDIT_TABLE, MAX_UPLOAD_MB, STUDIO_PROJECT_ID,
  NUXEO_URL, NUXEO_ADMIN_USER, NUXEO_ADMIN_PW_PARAM,
  NUXEO_LOG_GROUP,
} = process.env;

const REF = process.env.GIT_REF || "main";        // default branch for workflow_dispatch
const MAX_BYTES = (Number(MAX_UPLOAD_MB) || 200) * 1024 * 1024;
const WORKFLOWS = { deploy: "deploy.yaml", base: "build-base.yaml", rollback: "rollback.yaml" };

const s3 = new S3Client({ region: ARTIFACTS_REGION });
const ssm = new SSMClient({});
const ddb = new DynamoDBClient({});
const cwl = new CloudWatchLogsClient({}); // default region = Lambda's (us-east-1), where the log group lives

const secretCache = {};
async function secret(name) {
  if (!name) return undefined;
  if (secretCache[name] !== undefined) return secretCache[name];
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const v = out.Parameter?.Value;
  secretCache[name] = v && v !== "REPLACE_ME" ? v : undefined;
  return secretCache[name];
}

function json(statusCode, body) {
  // CORS headers are added by API Gateway's cors_configuration.
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try { return JSON.parse(raw); } catch { return {}; }
}

// Only allow a safe, flat artifact filename.
function safeName(name) {
  const base = String(name || "").split("/").pop().split("\\").pop();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(zip|jar)$/.test(base)) return null;
  return base;
}

async function gh(path, { method = "GET", body } = {}) {
  const token = await secret(GH_TOKEN_PARAM);
  if (!token) throw new Error("GitHub token not configured in SSM");
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ops-portal",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

async function dispatch(workflowFile, inputs = {}) {
  // Drop undefined/empty inputs so the workflow defaults apply.
  const clean = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v !== undefined && v !== ""));
  await gh(`/repos/${GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    body: { ref: REF, inputs: clean },
  });
}

async function audit(actor, action, detail = {}) {
  try {
    await ddb.send(new PutItemCommand({
      TableName: AUDIT_TABLE,
      Item: {
        pk: { S: "EVENT" },
        sk: { S: `${new Date().toISOString()}#${randomUUID()}` },
        actor: { S: String(actor || "unknown") },
        action: { S: String(action) },
        detail: { S: JSON.stringify(detail) },
      },
    }));
  } catch (e) { console.error("audit failed", e); } // never block the action on audit
}

async function latestRun(workflowFile) {
  try {
    const d = await gh(`/repos/${GITHUB_REPO}/actions/workflows/${workflowFile}/runs?per_page=1`);
    const r = d.workflow_runs?.[0];
    if (!r) return { status: "none" };
    return { status: r.status, conclusion: r.conclusion, url: r.html_url, created_at: r.created_at, event: r.event };
  } catch (e) { return { status: "error", error: String(e.message || e) }; }
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = (event.rawPath || "/").replace(/\/+$/, "") || "/";
  const actor = event.requestContext?.authorizer?.jwt?.claims?.email || "unknown";

  try {
    // ---- uploads --------------------------------------------------------
    if (method === "POST" && path === "/addons/presign") {
      const { filename, contentLength } = parseBody(event);
      const name = safeName(filename);
      if (!name) return json(400, { error: "filename must be a flat *.zip or *.jar name" });
      if (contentLength && Number(contentLength) > MAX_BYTES)
        return json(413, { error: `file too large (max ${MAX_UPLOAD_MB} MB)` });
      const key = `incoming/${name}`;
      const contentType = name.endsWith(".jar") ? "application/java-archive" : "application/zip";
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key, ContentType: contentType }),
        { expiresIn: 300 },
      );
      return json(200, { url, key, bucket: ARTIFACTS_BUCKET, contentType });
    }

    if (method === "POST" && path === "/addons/confirm") {
      const { key } = parseBody(event);
      if (!key || !key.startsWith("incoming/")) return json(400, { error: "key must be the incoming/ object just uploaded" });
      const name = safeName(key);
      if (!name) return json(400, { error: "bad artifact name" });
      // Verify the upload landed.
      const head = await s3.send(new HeadObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key })).catch(() => null);
      if (!head) return json(404, { error: "uploaded object not found — retry the upload" });
      // Promote incoming/ → addons/ (deep package validation happens in the pipeline on the box).
      await s3.send(new CopyObjectCommand({
        Bucket: ARTIFACTS_BUCKET, Key: `addons/${name}`,
        CopySource: `/${ARTIFACTS_BUCKET}/${encodeURIComponent(key)}`,
      }));
      await s3.send(new DeleteObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key }));
      await audit(actor, "addon.upload", { name, size: head.ContentLength });
      await dispatch(WORKFLOWS.deploy, {});
      return json(200, { ok: true, name, deploy: "dispatched" });
    }

    if (method === "GET" && path === "/addons") {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: ARTIFACTS_BUCKET, Prefix: "addons/" }));
      const items = (out.Contents || [])
        .filter((o) => o.Key !== "addons/")
        .map((o) => ({ name: o.Key.replace(/^addons\//, ""), size: o.Size, lastModified: o.LastModified }));
      return json(200, { addons: items });
    }

    if (method === "DELETE" && path.startsWith("/addons/")) {
      const name = safeName(decodeURIComponent(path.slice("/addons/".length)));
      if (!name) return json(400, { error: "bad addon name" });
      await s3.send(new DeleteObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: `addons/${name}` }));
      await audit(actor, "addon.remove", { name });
      await dispatch(WORKFLOWS.deploy, {});
      return json(200, { ok: true, removed: name, deploy: "dispatched" });
    }

    // ---- deploy actions -------------------------------------------------
    if (method === "POST" && path === "/deploy") {
      const { studio_version } = parseBody(event);
      await dispatch(WORKFLOWS.deploy, { studio_version });
      await audit(actor, "deploy", { studio_version: studio_version || "(default)" });
      return json(200, { ok: true, deploy: "dispatched" });
    }

    if (method === "POST" && path === "/deploy/base") {
      await dispatch(WORKFLOWS.base, {});
      await audit(actor, "deploy.base", {});
      return json(200, { ok: true, base: "dispatched" });
    }

    if (method === "POST" && path === "/rollback") {
      const { revision } = parseBody(event);
      await dispatch(WORKFLOWS.rollback, { revision: revision ? String(revision) : undefined });
      await audit(actor, "rollback", { revision: revision || "previous" });
      return json(200, { ok: true, rollback: "dispatched" });
    }

    // ---- read-only helpers ---------------------------------------------
    if (method === "GET" && path === "/studio/versions") {
      const user = await secret(CONNECT_USER_PARAM);
      const token = await secret(CONNECT_TOKEN_PARAM);
      if (!user || !token) return json(200, { versions: ["master-SNAPSHOT"], latest: null, note: "Connect creds not set; showing default only" });
      const url = `https://connect.nuxeo.com/nuxeo/site/studio/maven/nuxeo-studio/${STUDIO_PROJECT_ID}/maven-metadata.xml`;
      const res = await fetch(url, { headers: { authorization: "Basic " + Buffer.from(`${user}:${token}`).toString("base64") } });
      if (!res.ok) return json(200, { versions: ["master-SNAPSHOT"], latest: null, note: `Connect returned ${res.status}` });
      const xml = await res.text();
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
      const latest = (xml.match(/<latest>([^<]+)<\/latest>/) || [])[1] || null;
      return json(200, { versions, latest });
    }

    if (method === "GET" && path === "/status") {
      const [deploy, base, rollback, runners] = await Promise.all([
        latestRun(WORKFLOWS.deploy),
        latestRun(WORKFLOWS.base),
        latestRun(WORKFLOWS.rollback),
        gh(`/repos/${GITHUB_REPO}/actions/runners`).catch((e) => ({ error: String(e.message || e) })),
      ]);
      let runner = { status: "unknown" };
      if (runners?.runners) {
        const r = runners.runners.find((x) => (x.labels || []).some((l) => l.name === "hetzner-prod")) || runners.runners[0];
        runner = r ? { name: r.name, status: r.status, busy: r.busy } : { status: "none" };
      } else if (runners?.error) {
        // A 403 here means the portal PAT lacks the repo "Administration: read"
        // permission needed to LIST self-hosted runners — it does NOT mean the
        // runner is down (it may be happily running deploys). Degrade to a calm
        // "unknown" so the health strip doesn't cry wolf with a red ERROR tile.
        const denied = /\b403\b|not accessible/i.test(runners.error);
        runner = denied
          ? { status: "unknown", note: "portal token lacks Administration:read — runner state can't be queried" }
          : { status: "error", error: runners.error };
      }
      return json(200, { workflows: { deploy, base, rollback }, runner });
    }

    // Read-only view of what's actually loaded in the target Nuxeo.
    // Calls the management/distribution endpoint server-side with admin creds
    // from SSM, so the browser never sees them.
    if (method === "GET" && path === "/installed") {
      const base = (NUXEO_URL || "").replace(/\/+$/, "");
      if (!base) return json(200, { configured: false, note: "NUXEO_URL not set" });
      const pw = await secret(NUXEO_ADMIN_PW_PARAM);
      if (!pw) return json(200, { configured: false, note: "admin creds not set in SSM" });
      const authz = "Basic " + Buffer.from(`${NUXEO_ADMIN_USER || "Administrator"}:${pw}`).toString("base64");
      let res;
      try {
        res = await fetch(`${base}/api/v1/management/distribution`, {
          headers: { authorization: authz, accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
      } catch (e) { return json(200, { configured: true, reachable: false, error: String(e.message || e) }); }
      if (!res.ok) return json(200, { configured: true, reachable: false, status: res.status });
      const d = await res.json();
      const bundles = Array.isArray(d.bundles) ? d.bundles : [];
      const NOTABLE = /studio\.|web[.-]ui|amazon|s3|importer|drive|coldstorage|csv|opensearch|mongodb/i;
      const notable = bundles
        .filter((b) => NOTABLE.test(b?.name || ""))
        .map((b) => ({ name: b.name, version: b.version }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(200, {
        configured: true,
        reachable: true,
        distribution: [d.distributionName, d.distributionVersion].filter(Boolean).join(" "),
        application: [d.applicationName, d.applicationVersion].filter(Boolean).join(" "),
        bundleCount: bundles.length,
        studioLoaded: bundles.some((b) => /studio\.extensions\./i.test(b?.name || "")),
        studioVersion: (bundles.find((b) => /studio\.extensions\./i.test(b?.name || "")) || {}).version || null,
        webUiLoaded: bundles.some((b) => /web[.-]ui/i.test(b?.name || "")),
        notable,
        all: bundles.map((b) => ({ name: b.name, version: b.version })).sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    // Direct target-server logs, read from the CloudWatch group that the box's
    // fluent-bit ships into (the Lambda can't reach the box, so the box pushes).
    // Query params: ?minutes=30 (window, 1–1440) &limit=300 (1–1000) &filter=text
    if (method === "GET" && path === "/logs") {
      if (!NUXEO_LOG_GROUP) return json(200, { configured: false, note: "NUXEO_LOG_GROUP not set" });
      const q = event.queryStringParameters || {};
      const minutes = Math.min(Math.max(Number(q.minutes) || 30, 1), 1440);
      const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
      const params = {
        logGroupName: NUXEO_LOG_GROUP,
        startTime: Date.now() - minutes * 60000,
        limit,
        interleaved: true,
      };
      // CloudWatch term filter: quote the phrase, strip embedded quotes to keep it literal.
      if (q.filter) params.filterPattern = `"${String(q.filter).replace(/"/g, "")}"`;
      try {
        const out = await cwl.send(new FilterLogEventsCommand(params));
        const events = (out.events || []).map((e) => {
          // The box ships each raw container line as JSON ({"log":"<raw line>"}).
          // Unwrap the log field, then strip the containerd/CRI line prefix
          // ("2026-..T..Z stdout F ") so the portal shows just the Nuxeo line.
          let msg = e.message || "";
          if (msg.charCodeAt(0) === 123 /* { */) {
            try { const o = JSON.parse(msg); if (typeof o.log === "string") msg = o.log; } catch { /* not JSON — keep raw */ }
          }
          msg = msg.replace(/^\S+ (?:stdout|stderr) [PF] /, "").replace(/\s+$/, "");
          return { time: new Date(e.timestamp).toISOString(), message: msg };
        });
        return json(200, { configured: true, group: NUXEO_LOG_GROUP, minutes, events });
      } catch (e) {
        const note = e?.name === "ResourceNotFoundException"
          ? "no logs yet — the box shipper hasn't created the stream (is fluent-bit running?)"
          : String(e.message || e);
        return json(200, { configured: true, group: NUXEO_LOG_GROUP, minutes, events: [], note });
      }
    }

    // ---- activity: recent CI runs + latest deploy's live steps ----------
    if (method === "GET" && path === "/runs") {
      try {
        const d = await gh(`/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOWS.deploy}/runs?per_page=8`);
        const runs = (d.workflow_runs || []).map((r) => ({
          id: r.id, title: r.display_title || r.name, status: r.status, conclusion: r.conclusion,
          event: r.event, actor: r.actor?.login, created_at: r.created_at, url: r.html_url, runNumber: r.run_number,
        }));
        const top = (d.workflow_runs || [])[0];
        let steps = [];
        if (top) {
          const jb = await gh(`/repos/${GITHUB_REPO}/actions/runs/${top.id}/jobs`).catch(() => null);
          const job = jb?.jobs?.[0];
          if (job) steps = (job.steps || []).map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion }));
        }
        return json(200, { runs, latest: top ? { id: top.id, url: top.html_url, status: top.status, conclusion: top.conclusion, steps } : null });
      } catch (e) { return json(200, { runs: [], latest: null, error: String(e.message || e) }); }
    }

    // ---- audit: who did what, from DynamoDB ------------------------------
    if (method === "GET" && path === "/audit") {
      try {
        const out = await ddb.send(new QueryCommand({
          TableName: AUDIT_TABLE,
          KeyConditionExpression: "pk = :p",
          ExpressionAttributeValues: { ":p": { S: "EVENT" } },
          ScanIndexForward: false,
          Limit: 30,
        }));
        const events = (out.Items || []).map((it) => ({
          time: (it.sk?.S || "").split("#")[0],
          actor: it.actor?.S || "",
          action: it.action?.S || "",
          detail: (() => { try { return JSON.parse(it.detail?.S || "{}"); } catch { return {}; } })(),
        }));
        return json(200, { events });
      } catch (e) { return json(200, { events: [], error: String(e.message || e) }); }
    }

    return json(404, { error: `no route for ${method} ${path}` });
  } catch (e) {
    console.error(e);
    return json(500, { error: String(e.message || e) });
  }
};
