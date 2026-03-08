# -----------------------------------------------------------------------------
# Acme / dev — solo valores: invoca tenant-env con org_slug=acme, environment=dev
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

module "tenant" {
  source = "../../../../tenant-env"

  org_slug    = var.org_slug
  environment = var.environment
  aws_region  = var.aws_region
  tags        = var.tags
}
