###############################################################################
# Pre-sign-up Lambda trigger — rejects any sign-in whose email is not on the
# allowed domain. Runs for federated (Google) sign-ups too.
###############################################################################
data "archive_file" "presignup" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/presignup"
  output_path = "${path.module}/presignup.zip"
}

resource "aws_iam_role" "presignup" {
  name = "${var.project}-presignup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = merge(var.tags, { Project = var.project })
}

resource "aws_iam_role_policy_attachment" "presignup_logs" {
  role       = aws_iam_role.presignup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "presignup" {
  name              = "/aws/lambda/${var.project}-presignup"
  retention_in_days = 14
  tags              = merge(var.tags, { Project = var.project })
}

resource "aws_lambda_function" "presignup" {
  function_name    = "${var.project}-presignup"
  role             = aws_iam_role.presignup.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.presignup.output_path
  source_code_hash = data.archive_file.presignup.output_base64sha256
  timeout          = 5
  environment {
    variables = { ALLOWED_DOMAIN = var.allowed_email_domain }
  }
  depends_on = [aws_cloudwatch_log_group.presignup]
  tags       = merge(var.tags, { Project = var.project })
}

resource "aws_lambda_permission" "cognito_presignup" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.presignup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.this.arn
}

###############################################################################
# Cognito user pool + Google federation
###############################################################################
resource "aws_cognito_user_pool" "this" {
  name                     = "${var.project}-users"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config { allow_admin_create_user_only = false }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }

  lambda_config {
    pre_sign_up = aws_lambda_function.presignup.arn
  }

  tags = merge(var.tags, { Project = var.project })
}

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.this.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email          = "email"
    email_verified = "email_verified"
    name           = "name"
    username       = "sub"
  }
}

# Hosted-UI domain. Prefix must be globally unique → suffix with the account id.
resource "aws_cognito_user_pool_domain" "this" {
  domain       = "${var.project}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.this.id
}

resource "aws_cognito_user_pool_client" "spa" {
  name         = "${var.project}-spa"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret               = false
  supported_identity_providers  = ["Google"]
  prevent_user_existence_errors = "ENABLED"

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  callback_urls = ["https://${var.domain_name}/", "https://${var.domain_name}/index.html"]
  logout_urls   = ["https://${var.domain_name}/"]

  # Token lifetimes
  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  depends_on = [aws_cognito_identity_provider.google]
}
