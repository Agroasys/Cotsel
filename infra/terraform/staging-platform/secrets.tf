# This root creates secret identities only. Secret versions are written through
# a controlled bootstrap or rotation operation, so plaintext never enters
# Terraform configuration, plan output, or state.
resource "aws_secretsmanager_secret" "platform" {
  for_each = local.secret_names

  name                    = "/agroasys/${var.environment}/cotsel/${each.key}"
  description             = "Cotsel ${var.environment} ${replace(each.key, "-", " ")}"
  kms_key_id              = aws_kms_key.platform.arn
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}
