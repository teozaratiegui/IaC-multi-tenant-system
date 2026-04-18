# -----------------------------------------------------------------------------
# Acme / access-control / dev — deployment root: SSM API key + use_cases/access_control
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = var.environment
      Org         = var.org_slug
      ManagedBy   = "terraform"
    }
  }
}

resource "random_password" "api_key" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "api_key" {
  name        = "/${coalesce(var.org_slug, "org")}/${coalesce(var.environment, "env")}/api-key"
  description = "API key for Lambda; client sends in X-Api-Key header"
  type        = "SecureString"
  value       = random_password.api_key.result

  tags = var.tags
}

module "access_control" {
  source = "../../../../use_cases/access_control"

  org_slug               = var.org_slug
  environment            = var.environment
  api_key_parameter_name   = aws_ssm_parameter.api_key.name
  api_key_parameter_arn    = aws_ssm_parameter.api_key.arn
  tags                     = var.tags
}
