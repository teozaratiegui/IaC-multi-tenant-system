# -----------------------------------------------------------------------------
# Bootstrap: run this ONCE with local state to create the S3 + DynamoDB backend.
# Then configure your environments to use that backend.
# Usage: terraform init && terraform apply
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # State is local during bootstrap
  backend "local" {
    path = "bootstrap.tfstate"
  }
}

provider "aws" {
  region = var.aws_region
}

module "backend" {
  source = "../modules/backend"

  bucket_name     = var.state_bucket_name
  lock_table_name = var.lock_table_name
  tags            = var.tags
}
