output "api_key_value" {
  value       = module.tenant.api_key_value
  sensitive   = true
  description = "API key: send in header X-Api-Key. Run: terraform output -raw api_key_value"
}

output "access_control_table_name" {
  value       = module.tenant.access_control_table_name
  description = "DynamoDB table for access_control (acme-dev-access-control)"
}

output "access_control_url" {
  value       = module.tenant.access_control_url
  description = "Lambda Function URL: POST with x-api-key and body {\"tag\":\"...\", \"timestamp\":\"...\"}"
}
