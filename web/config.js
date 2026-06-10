// Filled at deploy time by the portal CI (or by hand) from `terraform output`.
// Placeholders look like __NAME__ and are replaced before upload to S3.
window.OPS_CONFIG = {
  apiBase:       "__API_BASE__",        // terraform output api_base_url
  cognitoDomain: "__COGNITO_DOMAIN__",  // terraform output cognito_hosted_ui_domain
  clientId:      "__CLIENT_ID__",       // terraform output cognito_client_id
  redirectUri:   "__REDIRECT_URI__",    // https://operations.maretha.io/
};
