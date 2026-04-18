output "tags_table_name" {
  value       = module.table_tags.table_name
  description = "DynamoDB table for tags (tagId -> allowed)"
}

output "events_table_name" {
  value       = module.table_events.table_name
  description = "DynamoDB table for events (tagId + eventTime per scan)"
}

output "function_url" {
  value = aws_lambda_function_url.this.function_url
}
