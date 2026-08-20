resource "aws_cloudwatch_log_group" "service" {
  for_each = local.services

  name              = "/agroasys/cotsel/staging/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.platform.arn

  lifecycle {
    prevent_destroy = true
  }
}
