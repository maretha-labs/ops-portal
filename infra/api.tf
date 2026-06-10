###############################################################################
# API Lambda
###############################################################################
data "archive_file" "api" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/api"
  output_path = "${path.module}/api.zip"
}

resource "aws_iam_role" "api" {
  name = "${var.project}-api"
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

resource "aws_iam_role_policy" "api" {
  name = "api"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:${data.aws_caller_identity.current.account_id}:*"
      },
      {
        Sid      = "ArtifactsObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.artifacts.arn}/incoming/*", "${aws_s3_bucket.artifacts.arn}/addons/*"]
      },
      {
        Sid      = "ArtifactsList"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.artifacts.arn
      },
      {
        Sid    = "ReadSecrets"
        Effect = "Allow"
        Action = ["ssm:GetParameter"]
        Resource = [
          aws_ssm_parameter.github_token.arn,
          aws_ssm_parameter.connect_user.arn,
          aws_ssm_parameter.connect_token.arn,
          aws_ssm_parameter.nuxeo_admin_pw.arn,
        ]
      },
      {
        Sid      = "Audit"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.audit.arn
      },
      {
        Sid      = "ReadNuxeoLogs"
        Effect   = "Allow"
        Action   = ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams"]
        Resource = ["${aws_cloudwatch_log_group.nuxeo.arn}", "${aws_cloudwatch_log_group.nuxeo.arn}:*"]
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.project}-api"
  retention_in_days = 14
  tags              = merge(var.tags, { Project = var.project })
}

resource "aws_lambda_function" "api" {
  function_name    = "${var.project}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      ARTIFACTS_BUCKET     = aws_s3_bucket.artifacts.bucket
      ARTIFACTS_REGION     = var.artifacts_region
      GITHUB_REPO          = var.github_repo
      GH_TOKEN_PARAM       = aws_ssm_parameter.github_token.name
      CONNECT_USER_PARAM   = aws_ssm_parameter.connect_user.name
      CONNECT_TOKEN_PARAM  = aws_ssm_parameter.connect_token.name
      AUDIT_TABLE          = aws_dynamodb_table.audit.name
      ALLOWED_ORIGIN       = "https://${var.domain_name}"
      MAX_UPLOAD_MB        = tostring(var.max_upload_mb)
      STUDIO_PROJECT_ID    = var.studio_project_id
      NUXEO_URL            = var.nuxeo_url
      NUXEO_ADMIN_USER     = "Administrator"
      NUXEO_ADMIN_PW_PARAM = aws_ssm_parameter.nuxeo_admin_pw.name
      NUXEO_LOG_GROUP      = aws_cloudwatch_log_group.nuxeo.name
    }
  }
  depends_on = [aws_cloudwatch_log_group.api]
  tags       = merge(var.tags, { Project = var.project })
}

###############################################################################
# HTTP API + Cognito JWT authorizer
###############################################################################
resource "aws_apigatewayv2_api" "http" {
  name          = "${var.project}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins  = ["https://${var.domain_name}"]
    allow_methods  = ["GET", "POST", "DELETE", "OPTIONS"]
    allow_headers  = ["authorization", "content-type"]
    expose_headers = ["*"]
    max_age        = 3600
  }
  tags = merge(var.tags, { Project = var.project })
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito-jwt"
  jwt_configuration {
    audience = [aws_cognito_user_pool_client.spa.id]
    issuer   = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.this.id}"
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

# One route per real method so the JWT authorizer does NOT sit on OPTIONS.
# With no OPTIONS (and no $default) route, API Gateway answers the CORS preflight
# itself — HTTP 200, unauthenticated — from cors_configuration above. An
# "ANY /{proxy+}" route also catches the preflight OPTIONS → authorizer → 401,
# which makes the browser report "Failed to fetch" on every API call.
resource "aws_apigatewayv2_route" "proxy" {
  for_each           = toset(["GET", "POST", "DELETE"])
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "${each.value} /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  tags        = merge(var.tags, { Project = var.project })
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
