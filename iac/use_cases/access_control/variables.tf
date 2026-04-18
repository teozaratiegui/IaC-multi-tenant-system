variable "org_slug" {
  description = "Organization identifier (e.g. acme)"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, prod)"
  type        = string
}

variable "api_key_parameter_name" {
  description = "SSM Parameter Store name where the API key is stored (e.g. /acme/dev/api-key); Lambda reads it at runtime"
  type        = string
}

variable "api_key_parameter_arn" {
  description = "ARN of the SSM parameter (for IAM policy so Lambda can read it)"
  type        = string
}

variable "tags" {
  description = "Tags for resources"
  type        = map(string)
  default     = {}
}
