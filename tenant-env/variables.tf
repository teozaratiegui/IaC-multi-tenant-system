variable "org_slug" {
  description = "Organization identifier (e.g. acme)"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, prod)"
  type        = string
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
