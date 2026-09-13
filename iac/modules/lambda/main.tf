# -----------------------------------------------------------------------------
# Lambda function — the pieces that are identical for every use case.
#
# The function, its role, its log group and the cost guardrail live here because
# they are the same everywhere. What *differs* between use cases — which AWS
# resources the code touches, and with which actions — arrives as data, in
# `policy_statements`. The module used to guess instead: one optional variable per
# AWS service, each with a hardcoded action list. That is why the access-control
# function could `Scan` and `DeleteItem` on tables it only ever reads and appends.
# -----------------------------------------------------------------------------

resource "aws_iam_role" "lambda" {
  name = "${var.function_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action    = "sts:AssumeRole"
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Declared rather than left to Lambda: see the note on var.log_retention_days.
# The name is the one Lambda would use itself — any other and the function writes
# to a second, unmanaged group.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  role          = aws_iam_role.lambda.arn
  handler       = var.handler
  runtime       = var.runtime

  filename         = var.source_path
  source_code_hash = var.source_code_hash

  timeout     = var.timeout
  memory_size = var.memory_size

  environment {
    variables = var.environment_variables
  }

  tags = merge(var.tags, { Name = var.function_name })

  # Without this the function can race its own log group and create the
  # unmanaged one first.
  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_iam_role_policy" "permissions" {
  count = length(var.policy_statements) > 0 ? 1 : 0

  name = "${var.function_name}-permissions"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in var.policy_statements : {
        Sid      = statement.sid
        Effect   = "Allow"
        Action   = statement.actions
        Resource = statement.resources
      }
    ]
  })
}

# FinOps guardrail: even with a compromised function, these cannot be called.
#
# Two things to know before adding a use case:
#   - a Deny always beats an Allow, so DenyS3Write below will break the first use
#     case that legitimately writes to S3. Narrow it to specific buckets then,
#     rather than removing the guardrail;
#   - ec2:* is denied, which is also why this module no longer offers a VPC
#     config: attaching an ENI needs ec2:CreateNetworkInterface, so the two
#     features could never have worked together.
resource "aws_iam_role_policy" "deny_costly" {
  count = var.deny_costly_actions ? 1 : 0

  name = "${var.function_name}-deny-costly"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DenyCompute"
        Effect   = "Deny"
        Action   = ["ec2:*", "rds:*", "eks:*", "ecs:*"]
        Resource = ["*"]
      },
      {
        Sid    = "DenyInfraMutation"
        Effect = "Deny"
        Action = [
          "lambda:CreateFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:DeleteFunction",
          "lambda:CreateEventSourceMapping",
          "dynamodb:CreateTable",
          "dynamodb:DeleteTable",
          "dynamodb:UpdateTable"
        ]
        Resource = ["*"]
      },
      {
        Sid      = "DenyS3Write"
        Effect   = "Deny"
        Action   = ["s3:CreateBucket", "s3:PutObject", "s3:DeleteBucket", "s3:DeleteObject"]
        Resource = ["*"]
      }
    ]
  })
}
