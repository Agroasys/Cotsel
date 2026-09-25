output "evidence_bucket_name" {
  description = "Bucket that stores immutable Base Sepolia staging evidence."
  value       = aws_s3_bucket.evidence.id
}

output "evidence_writer_role_arn" {
  description = "OIDC role assumed only by the protected evidence environment."
  value       = aws_iam_role.writer.arn
}

output "evidence_reader_role_arn" {
  description = "OIDC role used by an independent reviewer to read exact evidence versions."
  value       = local.reader_role_arn
}

output "evidence_archive_key_arn" {
  description = "Customer-managed KMS key that encrypts archive objects and audit logs."
  value       = aws_kms_key.archive.arn
}

output "audit_trail_arn" {
  description = "CloudTrail trail that records data events for the evidence archive."
  value       = aws_cloudtrail.evidence.arn
}

output "audit_log_group_name" {
  description = "Externally governed CloudWatch log group that receives archive events."
  value       = local.audit_log_group
}

output "denied_mutation_alarm_arn" {
  description = "Externally governed alarm for denied archive mutation attempts."
  value       = "arn:${data.aws_partition.current.partition}:cloudwatch:${var.region}:${var.account_id}:alarm:${local.denial_alarm_name}"
}

output "archive_alert_topic_arn" {
  description = "Externally governed topic used by the denied archive mutation alarm."
  value       = "arn:${data.aws_partition.current.partition}:sns:${var.region}:${var.account_id}:${local.alert_topic_name}"
}
