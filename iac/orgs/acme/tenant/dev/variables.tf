variable "org_slug" {
  description = "Organisation identifier"
  type        = string
  default     = "acme"
}

variable "environment" {
  description = "Environment name: dev, staging or prod"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "sa-east-1"
}

variable "messaging_use_cases" {
  description = <<-EOT
    Use cases of this tenant that need a bot token and a webhook secret of their
    own, by slug. Each entry creates /<org>/<env>/<slug>/{messaging-token,
    webhook-secret}, so two use cases of the same organisation can sit on
    different providers.
  EOT
  type        = set(string)
  default     = ["access-control"]
}

variable "tags" {
  description = "Extra tags"
  type        = map(string)
  default     = {}
}
