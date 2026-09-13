# -----------------------------------------------------------------------------
# Tenant layer — what belongs to an (organisation, environment) pair rather than
# to a single use case. Today: the credentials.
#
# They live here because their SSM names, /<org>/<env>/<thing>, do not mention the
# use case. Creating them from a use-case root meant the second use case of the
# same tenant collided with the first.
#
# The API key stays at /<org>/<env>/api-key, shared by every use case of the
# tenant: it is the tenant's own credential and the gateway holds exactly one.
# The messaging credentials are per use case — see the note on them below.
#
# ── Terraform declares the container, not the secret ──────────────────────────
# These parameters are created with a placeholder and their value is then set out
# of band. The alternative — generating with `random_password` — writes the secret
# in *plain text* into the state file, and that cannot be fixed by encrypting
# harder: Terraform needs the plaintext to create the parameter. (`sensitive =
# true` only hides CLI output; it stores the same string.) Verified in the state
# of the previous deployment: api-key 32 chars and messaging token 46 chars, both
# readable by anyone with s3:GetObject on the shared state bucket.
#
# Secrets Manager would rotate this properly at US$0.40/secret/month, and a
# customer-managed KMS key at US$1/month. Both were ruled out: this project must
# stay free. SSM Standard + the AWS-managed key alias/aws/ssm is encrypted at rest
# and costs nothing.
#
# After `terraform apply`:
#   aws ssm put-parameter --name /<org>/<env>/api-key --type SecureString \
#     --value "$(openssl rand -hex 32)" --overwrite --region <region>
#
# `ignore_changes` is what keeps the real value from being reverted to the
# placeholder on the next apply. Do not remove it.
# -----------------------------------------------------------------------------

locals {
  prefix = "/${var.org_slug}/${var.environment}"

  common_tags = merge(var.tags, {
    Org         = var.org_slug
    Environment = var.environment
  })
}

resource "aws_ssm_parameter" "api_key" {
  name        = "${local.prefix}/api-key"
  description = "API key for ${var.org_slug}/${var.environment}; callers send it in the x-api-key header"
  type        = "SecureString"
  value       = "REPLACE-ME"

  tags = local.common_tags

  lifecycle {
    ignore_changes = [value]
  }
}

# One bot token per use case that needs one, so an organisation that does not
# notify anybody carries no empty credential — and two use cases of the same
# tenant can use different providers, which a single shared token could not
# support: it can only ever hold one provider's credential.
resource "aws_ssm_parameter" "messaging_token" {
  for_each = var.messaging_use_cases

  name        = "${local.prefix}/${each.key}/messaging-token"
  description = "Messaging bot token for ${var.org_slug}/${var.environment}/${each.key}"
  type        = "SecureString"
  value       = "REPLACE-ME"

  tags = merge(local.common_tags, { UseCase = each.key })

  lifecycle {
    ignore_changes = [value]
  }
}

# The other half of the messaging credentials: what the provider proves itself
# with when it calls our webhook.
#
#   Telegram   the `secret_token` given to setWebhook, echoed back in the
#              X-Telegram-Bot-Api-Secret-Token header on every call
#   WhatsApp   the app secret Meta signs the request body with, in
#              X-Hub-Signature-256
#
# It is a separate parameter from the bot token because it is a separate secret
# with a separate lifecycle: rotating the webhook secret is a setWebhook call,
# rotating the bot token is a new bot. And it is per use case for the same reason
# the token is: each use case has its own bot, so its own webhook.
#
# After `terraform apply`, for Telegram:
#   SECRET=$(openssl rand -hex 32)
#   aws ssm put-parameter --name /<org>/<env>/<use case>/webhook-secret \
#     --type SecureString --value "$SECRET" --overwrite --region <region>
#   curl -X POST "https://api.telegram.org/bot<token>/setWebhook" \
#     -d "url=<webhook_url>" -d "secret_token=$SECRET"
resource "aws_ssm_parameter" "webhook_secret" {
  for_each = var.messaging_use_cases

  name        = "${local.prefix}/${each.key}/webhook-secret"
  description = "Secret the webhook of ${var.org_slug}/${var.environment}/${each.key} is verified with"
  type        = "SecureString"
  value       = "REPLACE-ME"

  tags = merge(local.common_tags, { UseCase = each.key })

  lifecycle {
    ignore_changes = [value]
  }
}
