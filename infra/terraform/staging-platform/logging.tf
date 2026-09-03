resource "aws_cloudwatch_log_group" "service" {
  for_each = local.services

  name              = "/agroasys/cotsel/staging/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.platform.arn

  lifecycle {
    prevent_destroy = true
  }
}

# WAF requires this prefix for a CloudWatch Logs destination. Redact every header that can
# contain an API credential or signed request material before the match record is retained.
resource "aws_cloudwatch_log_group" "gateway_waf" {
  provider = aws.edge

  name              = "aws-waf-logs-${local.name_prefix}-gateway"
  retention_in_days = var.log_retention_days
}

resource "aws_wafv2_web_acl_logging_configuration" "gateway" {
  provider = aws.edge

  resource_arn            = aws_wafv2_web_acl.gateway.arn
  log_destination_configs = [aws_cloudwatch_log_group.gateway_waf.arn]

  dynamic "redacted_fields" {
    for_each = toset([
      "authorization",
      "cookie",
      "x-agroasys-nonce",
      "x-agroasys-signature",
      "x-agroasys-timestamp",
      "x-api-key",
      "x-nonce",
      "x-signature",
      "x-timestamp",
    ])

    content {
      single_header {
        name = redacted_fields.key
      }
    }
  }
}

# Standard logging v2 writes CloudFront access logs directly to CloudWatch Logs without a
# bucket ACL. It records edge behavior while the WAF logger above redacts signed headers.
resource "aws_cloudwatch_log_group" "gateway_cloudfront" {
  provider = aws.edge

  name              = "/aws/cloudfront/${local.name_prefix}-gateway"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_delivery_source" "gateway_cloudfront" {
  provider = aws.edge

  name         = "${local.name_prefix}-gateway-access-logs"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.gateway.arn
}

resource "aws_cloudwatch_log_delivery_destination" "gateway_cloudfront" {
  provider = aws.edge

  name          = "${local.name_prefix}-gateway-access-logs"
  output_format = "json"

  delivery_destination_configuration {
    destination_resource_arn = aws_cloudwatch_log_group.gateway_cloudfront.arn
  }
}

resource "aws_cloudwatch_log_delivery" "gateway_cloudfront" {
  provider = aws.edge

  delivery_source_name     = aws_cloudwatch_log_delivery_source.gateway_cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.gateway_cloudfront.arn
}
