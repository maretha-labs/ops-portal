###############################################################################
# Runtime secrets the API Lambda reads (NOT stored in tfstate). Terraform creates
# the parameters with a placeholder; you set the real values out-of-band with
# `aws ssm put-parameter ... --overwrite` (see SETUP.md). ignore_changes keeps
# Terraform from clobbering them on the next apply.
###############################################################################
locals {
  ssm_prefix = "/${var.project}"
}

resource "aws_ssm_parameter" "github_token" {
  name        = "${local.ssm_prefix}/github-token"
  description = "Fine-grained GitHub PAT (Actions: read+write on ${var.github_repo})."
  type        = "SecureString"
  value       = "REPLACE_ME"
  lifecycle { ignore_changes = [value] }
  tags = merge(var.tags, { Project = var.project })
}

resource "aws_ssm_parameter" "connect_user" {
  name        = "${local.ssm_prefix}/connect-user"
  description = "Nuxeo Connect username (for the Studio version list)."
  type        = "SecureString"
  value       = "REPLACE_ME"
  lifecycle { ignore_changes = [value] }
  tags = merge(var.tags, { Project = var.project })
}

resource "aws_ssm_parameter" "connect_token" {
  name        = "${local.ssm_prefix}/connect-token"
  description = "Nuxeo Connect token/password (for the Studio version list)."
  type        = "SecureString"
  value       = "REPLACE_ME"
  lifecycle { ignore_changes = [value] }
  tags = merge(var.tags, { Project = var.project })
}

resource "aws_ssm_parameter" "nuxeo_admin_pw" {
  name        = "${local.ssm_prefix}/nuxeo-admin-pw"
  description = "Target Nuxeo Administrator password; read server-side by the API Lambda for the 'Installed in demo3' panel."
  type        = "SecureString"
  value       = "REPLACE_ME"
  lifecycle { ignore_changes = [value] }
  tags = merge(var.tags, { Project = var.project })
}
