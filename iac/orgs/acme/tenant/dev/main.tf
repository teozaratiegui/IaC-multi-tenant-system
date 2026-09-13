# -----------------------------------------------------------------------------
# acme / dev — tenant root.
#
# Apply this BEFORE any use-case root for the same (org, environment): it creates
# the credentials the use cases read.
#
#   terraform init -backend-config=backend.hcl
#   terraform apply
#   terraform output parameters_to_set     # then run those commands
#
# The credential values are NOT in Terraform — see the note in iac/tenant/main.tf.
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
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
  source = "../../../../tenant"

  org_slug            = var.org_slug
  environment         = var.environment
  messaging_use_cases = var.messaging_use_cases
  tags                = var.tags
}
