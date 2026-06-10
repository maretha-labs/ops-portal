terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.30"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Recommended: an encrypted remote backend so tfstate (which holds the Google client
  # secret) is not stored in plaintext on a laptop. Fill and uncomment:
  # backend "s3" {
  #   bucket = "your-tf-state-bucket"
  #   key    = "ops-portal/terraform.tfstate"
  #   region = "eu-north-1"
  #   encrypt = true
  # }
}

# Default region: us-east-1 — REQUIRED for the CloudFront ACM certificate.
provider "aws" {
  region = var.aws_region
}

# Add-on artifact bucket lives close to the lab box.
provider "aws" {
  alias  = "artifacts"
  region = var.artifacts_region
}

# Auth via env var CLOUDFLARE_API_TOKEN (do not put the token in tfvars/state).
provider "cloudflare" {}
