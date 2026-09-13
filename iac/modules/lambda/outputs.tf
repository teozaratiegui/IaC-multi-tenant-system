output "function_name" {
  description = "Name of the Lambda function"
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function"
  value       = aws_lambda_function.this.arn
}

output "role_arn" {
  description = "ARN of the function's execution role"
  value       = aws_iam_role.lambda.arn
}

output "log_group_name" {
  description = "CloudWatch log group, managed here so `destroy` removes it"
  value       = aws_cloudwatch_log_group.lambda.name
}
