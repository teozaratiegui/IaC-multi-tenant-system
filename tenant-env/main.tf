# -----------------------------------------------------------------------------
# Tenant environment: one org + one env (e.g. acme / dev)
# API key en Parameter Store (SSM) Standard = gratis (sin Secrets Manager)
# -----------------------------------------------------------------------------

resource "random_password" "api_key" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "api_key" {
  # SSM path segments can't be empty (e.g. ///api-key is invalid)
  name        = "/${coalesce(var.org_slug, "org")}/${coalesce(var.environment, "env")}/api-key"
  description = "API key for Lambda; client sends in X-Api-Key header"
  type        = "SecureString"
  value       = random_password.api_key.result

  tags = var.tags
}

module "access_control" {
  source = "./modules/access_control"

  org_slug                 = var.org_slug
  environment              = var.environment
  api_key_parameter_name   = aws_ssm_parameter.api_key.name
  api_key_parameter_arn     = aws_ssm_parameter.api_key.arn
  tags                     = var.tags
}
