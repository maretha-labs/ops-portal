###############################################################################
# Add-on artifact bucket (eu-north-1, near the Hetzner box). The portal writes
# uploads here; the deploy pipeline `aws s3 sync`s addons/ onto the box.
###############################################################################
resource "aws_s3_bucket" "artifacts" {
  provider = aws.artifacts
  bucket   = var.artifacts_bucket_name
  tags     = merge(var.tags, { Project = var.project })
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  provider                = aws.artifacts
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  provider = aws.artifacts
  bucket   = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  provider = aws.artifacts
  bucket   = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  provider = aws.artifacts
  bucket   = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-incoming"
    status = "Enabled"
    filter { prefix = "incoming/" }
    expiration { days = 7 }
  }
  rule {
    id     = "abort-incomplete-mpu"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
  }
}

# Browser uploads go straight to S3 via a presigned PUT, so the bucket must allow
# cross-origin PUT from the portal origin.
resource "aws_s3_bucket_cors_configuration" "artifacts" {
  provider = aws.artifacts
  bucket   = aws_s3_bucket.artifacts.id
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = ["https://${var.domain_name}"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

###############################################################################
# Audit log of portal actions (who uploaded / deployed / rolled back, when).
###############################################################################
resource "aws_dynamodb_table" "audit" {
  name         = "${var.project}-audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  tags = merge(var.tags, { Project = var.project })
}

###############################################################################
# Read-only IAM user for the deploy pipeline (box runner) to pull addons/.
# Its keys go into the hetzner-remote repo secrets (see SETUP.md / outputs).
###############################################################################
resource "aws_iam_user" "addons_ro" {
  name = "${var.artifacts_bucket_name}-ro"
  tags = merge(var.tags, { Project = var.project })
}

resource "aws_iam_user_policy" "addons_ro" {
  name = "read-addons"
  user = aws_iam_user.addons_ro.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "List"
        Effect    = "Allow"
        Action    = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource  = aws_s3_bucket.artifacts.arn
        Condition = { StringLike = { "s3:prefix" = ["addons/*", "addons"] } }
      },
      {
        Sid      = "Read"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/addons/*"
      }
    ]
  })
}

resource "aws_iam_access_key" "addons_ro" {
  user = aws_iam_user.addons_ro.name
}
