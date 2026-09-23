output "evidence_bucket_name" {
  description = "Bucket that stores immutable Base Sepolia staging evidence."
  value       = aws_s3_bucket.evidence.id
}

output "evidence_writer_role_arn" {
  description = "OIDC role assumed only by the protected evidence environment."
  value       = aws_iam_role.writer.arn
}

output "evidence_archive_key_arn" {
  description = "Customer-managed KMS key that encrypts archive objects and audit logs."
  value       = aws_kms_key.archive.arn
}

output "audit_trail_arn" {
  description = "CloudTrail trail that records data events for the evidence archive."
  value       = aws_cloudtrail.evidence.arn
}
