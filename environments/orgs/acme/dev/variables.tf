variable "org_slug" {
  description = "Organization identifier (acme)"
  type        = string
  default     = "acme"
}

variable "environment" {
  description = "Environment (dev)"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "sa-east-1"
}

variable "tags" {
  description = "Tags for all resources"
  type        = map(string)
  default     = {}
}
