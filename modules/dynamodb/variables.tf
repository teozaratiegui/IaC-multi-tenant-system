variable "table_name" {
  description = "Name of the DynamoDB table"
  type        = string
}

variable "hash_key" {
  description = "Attribute to use as the hash (partition) key"
  type        = string
}

variable "range_key" {
  description = "Optional attribute to use as the range (sort) key"
  type        = string
  default     = null
}

variable "attributes" {
  description = "List of attribute definitions. Must include hash_key and range_key if used."
  type = list(object({
    name = string
    type = string # S, N, B
  }))
}

variable "billing_mode" {
  description = "Billing mode: PROVISIONED or PAY_PER_REQUEST"
  type        = string
  default     = "PAY_PER_REQUEST"
}

variable "read_capacity" {
  description = "Read capacity units (required when billing_mode is PROVISIONED)"
  type        = number
  default     = null
}

variable "write_capacity" {
  description = "Write capacity units (required when billing_mode is PROVISIONED)"
  type        = number
  default     = null
}

variable "global_secondary_indexes" {
  description = "List of global secondary index definitions"
  type = list(object({
    name            = string
    hash_key        = string
    range_key       = optional(string)
    projection_type = string # ALL, KEYS_ONLY, INCLUDE
    read_capacity   = optional(number)
    write_capacity  = optional(number)
  }))
  default = []
}

variable "point_in_time_recovery" {
  description = "Enable point-in-time recovery"
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags to apply to the table"
  type        = map(string)
  default     = {}
}
