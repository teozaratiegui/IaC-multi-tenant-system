output "api_key_value" {
  value       = random_password.api_key.result
  sensitive   = true
  description = "API key: send in header X-Api-Key. Run: terraform output -raw api_key_value"
}

output "tags_table_name" {
  value       = module.access_control.tags_table_name
  description = "DynamoDB table for tags (tagId -> allowed)"
}

output "events_table_name" {
  value       = module.access_control.events_table_name
  description = "DynamoDB table for events (tagId + eventTime per scan)"
}

output "access_control_url" {
  value       = module.access_control.function_url
  description = "Lambda Function URL: POST with x-api-key and body {\"tag\":\"...\", \"timestamp\":\"...\"}"
}
