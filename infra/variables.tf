variable "aws_region" {
  description = "Primary region. Must be us-east-1 (CloudFront ACM requirement)."
  type        = string
  default     = "us-east-1"
}

variable "artifacts_region" {
  description = "Region for the add-on artifact bucket (put it near your deploy box)."
  type        = string
  default     = "eu-north-1"
}

variable "project" {
  description = "Name prefix / tag for all resources."
  type        = string
  default     = "ops-portal"
}

variable "domain_name" {
  description = "Public portal hostname (e.g. ops.example.com)."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for your domain (dashboard -> Overview -> API -> Zone ID)."
  type        = string
}

variable "allowed_email_domain" {
  description = "Only Google accounts on this domain may sign in (e.g. example.com)."
  type        = string
}

variable "google_client_id" {
  description = "Google OAuth 2.0 Web client ID (Google Cloud Console)."
  type        = string
}

variable "google_client_secret" {
  description = "Google OAuth 2.0 Web client secret. Sensitive - ends up in tfstate; use an encrypted backend."
  type        = string
  sensitive   = true
}

variable "artifacts_bucket_name" {
  description = "S3 bucket for uploaded add-on artifacts (pulled by the deploy pipeline). Bucket names are global - pick your own."
  type        = string
}

variable "github_repo" {
  description = "owner/repo the portal dispatches workflows against."
  type        = string
}

variable "max_upload_mb" {
  description = "Largest add-on artifact the portal will presign (MB)."
  type        = number
  default     = 200
}

variable "nuxeo_url" {
  description = "Base URL of the target Nuxeo (read-only, for the Installed panel). Empty disables the panel."
  type        = string
  default     = ""
}

variable "studio_project_id" {
  description = "Nuxeo Studio project id for the version dropdown. Empty shows the default list only."
  type        = string
  default     = ""
}

variable "nuxeo_log_retention_days" {
  description = "Retention for the server-log CloudWatch group (cost control)."
  type        = number
  default     = 14
}

variable "tags" {
  description = "Extra tags."
  type        = map(string)
  default     = {}
}
