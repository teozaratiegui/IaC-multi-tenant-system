output "table_name" {
  value = module.table.table_name
}

output "function_url" {
  value = aws_lambda_function_url.this.function_url
}
