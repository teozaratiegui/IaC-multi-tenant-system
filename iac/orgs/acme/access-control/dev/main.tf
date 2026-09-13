# -----------------------------------------------------------------------------
# acme / access-control / dev — use-case deployment root.
#
# Prerequisites, in order:
#   1. iac/bootstrap                  — S3 state bucket + lock table (once, ever)
#   2. iac/orgs/acme/tenant/dev       — the credentials in SSM
#   3. this root
#
#   terraform init -backend-config=backend.hcl
#   terraform apply
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
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
      UseCase     = "access-control"
    }
  }
}

# The credentials belong to the tenant, not to this use case: they are named here,
# never created. Creating them from a use-case root is what made two use cases of
# the same tenant collide on /<org>/<env>/api-key.
#
# The API key is the tenant's own and is shared: the gateway holds exactly one.
# The messaging credentials are per use case, so this root names its own.
#
# ── Why these are built as strings, and not read with a data source ───────────
# Because `data "aws_ssm_parameter"` would put all three secrets, in clear text,
# into this root's state file.
#
# That data source exposes a `value` attribute and defaults to `with_decryption =
# true`, and Terraform persists *every* attribute of a data source into the state.
# `sensitive = true` only redacts CLI output; it stores the same string — which is
# the very argument iac/tenant/main.tf makes about `random_password` before
# creating these parameters with a placeholder. Reading them back here would have
# reopened exactly that hole on the read side, with three secrets instead of two,
# in a state bucket shared by every tenant.
#
# Nothing is lost by naming them: only `.name` and `.arn` are ever consumed, and
# both are pure string construction — the names below are the same literals the
# data sources were looking up.
#
# What this does give up is the data source's implicit existence check: `apply` no
# longer fails when the tenant root has not been applied, or when it does not list
# this use case in `messaging_use_cases`. The ordering is in the runbook at the top
# of this file, and the failure mode is loud rather than silent — the function logs
# a GetParameter error and answers 500 on its first invoke. Buying that check back
# would mean a data source with `with_decryption = false`, which keeps the
# ciphertext in the state instead of the plaintext.
data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  # How this use case is named in SSM. It has to match one of the tenant root's
  # `messaging_use_cases`, which is what creates the two parameters below.
  use_case = "access-control"

  ssm_prefix = "/${var.org_slug}/${var.environment}"

  api_key_parameter_name         = "${local.ssm_prefix}/api-key"
  messaging_token_parameter_name = "${local.ssm_prefix}/${local.use_case}/messaging-token"
  webhook_secret_parameter_name  = "${local.ssm_prefix}/${local.use_case}/webhook-secret"

  # arn:aws:ssm:<region>:<account>:parameter/<org>/<env>/… — a parameter name
  # already carries its own leading slash.
  ssm_arn_prefix = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter"
}

module "access_control" {
  source = "../../../../use_cases/access_control"

  org_slug    = var.org_slug
  environment = var.environment

  api_key_parameter_name = local.api_key_parameter_name
  api_key_parameter_arn  = "${local.ssm_arn_prefix}${local.api_key_parameter_name}"

  messaging_token_parameter_name = var.enable_messaging ? local.messaging_token_parameter_name : null
  messaging_token_parameter_arn  = var.enable_messaging ? "${local.ssm_arn_prefix}${local.messaging_token_parameter_name}" : null
  webhook_secret_parameter_name  = var.enable_messaging ? local.webhook_secret_parameter_name : null
  webhook_secret_parameter_arn   = var.enable_messaging ? "${local.ssm_arn_prefix}${local.webhook_secret_parameter_name}" : null
  messaging_provider             = var.messaging_provider

  org_display_name   = var.org_display_name
  messaging_locale   = var.messaging_locale
  messaging_timezone = var.messaging_timezone

  auto_register_tags     = var.auto_register_tags
  point_in_time_recovery = var.point_in_time_recovery
  log_retention_days     = var.log_retention_days
  tags                   = var.tags
}
