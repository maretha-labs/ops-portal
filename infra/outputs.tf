output "portal_url" {
  value = "https://${var.domain_name}"
}

output "cloudfront_domain" {
  description = "Point the Cloudflare CNAME here (Terraform already does this)."
  value       = aws_cloudfront_distribution.spa.domain_name
}

output "cloudfront_distribution_id" {
  description = "For CloudFront cache invalidation in the portal CI."
  value       = aws_cloudfront_distribution.spa.id
}

output "api_base_url" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.spa.id
}

output "cognito_hosted_ui_domain" {
  value = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
}

output "google_authorized_redirect_uri" {
  description = "Paste this into the Google OAuth client 'Authorized redirect URIs'."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.name}.amazoncognito.com/oauth2/idpresponse"
}

output "google_authorized_js_origin" {
  description = "Paste this into the Google OAuth client 'Authorized JavaScript origins'."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
}

output "spa_bucket" {
  value = aws_s3_bucket.spa.bucket
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

# Feed these into the hetzner-remote repo secrets so deploy.yaml can read addons/.
output "addons_ro_access_key_id" {
  value = aws_iam_access_key.addons_ro.id
}

output "addons_ro_secret_access_key" {
  value     = aws_iam_access_key.addons_ro.secret
  sensitive = true
}

# Feed these into the box's fluent-bit Secret so it can ship demo3 logs to CloudWatch.
output "nuxeo_log_group" {
  value = aws_cloudwatch_log_group.nuxeo.name
}

output "log_shipper_access_key_id" {
  value = aws_iam_access_key.log_shipper.id
}

output "log_shipper_secret_access_key" {
  value     = aws_iam_access_key.log_shipper.secret
  sensitive = true
}

output "ssm_params_to_fill" {
  description = "Set real values with: aws ssm put-parameter --name <n> --type SecureString --overwrite --value ..."
  value = [
    aws_ssm_parameter.github_token.name,
    aws_ssm_parameter.connect_user.name,
    aws_ssm_parameter.connect_token.name,
  ]
}
