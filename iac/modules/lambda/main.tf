# -----------------------------------------------------------------------------
# Lambda Function Module
# Creates a Lambda function with configurable runtime, env vars, and permissions
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_iam_role" "lambda" {
  name = "${var.function_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  role          = aws_iam_role.lambda.arn
  handler       = var.handler
  runtime       = var.runtime

  filename         = var.source_path != null ? var.source_path : null
  source_code_hash = var.source_path != null ? filebase64sha256(var.source_path) : null

  s3_bucket         = var.s3_bucket
  s3_key            = var.s3_key
  s3_object_version = var.s3_object_version

  timeout     = var.timeout
  memory_size = var.memory_size

  environment {
    variables = var.environment_variables
  }

  dynamic "vpc_config" {
    for_each = var.subnet_ids != null && var.security_group_ids != null ? [1] : []
    content {
      subnet_ids         = var.subnet_ids
      security_group_ids = var.security_group_ids
    }
  }

  tags = merge(var.tags, {
    Name = var.function_name
  })
}

# Optional: grant this Lambda permission to access specific DynamoDB tables
resource "aws_iam_role_policy" "dynamodb" {
  count = length(var.dynamodb_table_arns) > 0 ? 1 : 0

  name   = "${var.function_name}-dynamodb"
  role   = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:BatchGetItem",
          "dynamodb:BatchWriteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:ConditionCheckItem"
        ]
        Resource = var.dynamodb_table_arns
      }
    ]
  })
}

# Optional: grant this Lambda permission to read Secrets Manager secrets (e.g. DB credentials)
resource "aws_iam_role_policy" "secrets" {
  count = length(var.secrets_manager_arns) > 0 ? 1 : 0

  name   = "${var.function_name}-secrets"
  role   = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.secrets_manager_arns
      }
    ]
  })
}

# Optional: grant this Lambda permission to read SSM Parameter Store (Standard tier = free)
resource "aws_iam_role_policy" "ssm" {
  count = length(var.ssm_parameter_arns) > 0 ? 1 : 0

  name   = "${var.function_name}-ssm"
  role   = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = var.ssm_parameter_arns
      }
    ]
  })
}

# Deny costly/dangerous actions so use cases cannot incur unexpected charges (default: enabled)
resource "aws_iam_role_policy" "deny_costly" {
  count = var.deny_costly_actions ? 1 : 0

  name   = "${var.function_name}-deny-costly"
  role   = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyEC2"
        Effect = "Deny"
        Action = ["ec2:*"]
        Resource = ["*"]
      },
      {
        Sid    = "DenyRDS"
        Effect = "Deny"
        Action = ["rds:*"]
        Resource = ["*"]
      },
      {
        Sid    = "DenyLambdaCreate"
        Effect = "Deny"
        Action = [
          "lambda:CreateFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:DeleteFunction",
          "lambda:CreateEventSourceMapping",
          "lambda:CreateAlias",
          "lambda:PublishVersion"
        ]
        Resource = ["*"]
      },
      {
        Sid    = "DenyDynamoDBCreateDelete"
        Effect = "Deny"
        Action = [
          "dynamodb:CreateTable",
          "dynamodb:DeleteTable",
          "dynamodb:UpdateTable"
        ]
        Resource = ["*"]
      },
      {
        Sid    = "DenyS3Write"
        Effect = "Deny"
        Action = [
          "s3:CreateBucket",
          "s3:PutObject",
          "s3:PutObjectAcl",
          "s3:DeleteBucket",
          "s3:DeleteObject"
        ]
        Resource = ["*"]
      },
      {
        Sid    = "DenyEKSECS"
        Effect = "Deny"
        Action = ["eks:*", "ecs:*", "ecr:PutImage", "ecr:InitiateLayerUpload"]
        Resource = ["*"]
      }
    ]
  })
}
