output "ecr_repository_arns" {
  description = "ARNs for the complete authoritative Cotsel release-image cohort."
  value = merge(
    { for name, repository in data.aws_ecr_repository.existing : name => repository.arn },
    { for name, repository in aws_ecr_repository.foundation : name => repository.arn },
  )
}

output "ecr_repository_names" {
  description = "Repository names for the complete authoritative Cotsel release-image cohort."
  value = merge(
    { for name, repository in data.aws_ecr_repository.existing : name => repository.name },
    { for name, repository in aws_ecr_repository.foundation : name => repository.name },
  )
}

output "ecr_repository_urls" {
  description = "Repository URLs for the complete authoritative Cotsel release-image cohort."
  value = merge(
    { for name, repository in data.aws_ecr_repository.existing : name => repository.repository_url },
    { for name, repository in aws_ecr_repository.foundation : name => repository.repository_url },
  )
}

output "release_services" {
  description = "Closed-world service inventory covered by the release registry."
  value       = sort(tolist(local.authoritative_release_services))
}

output "registry_kms_key_arn" {
  description = "Existing Cotsel platform key used for ECR encryption."
  value       = data.aws_kms_alias.platform.target_key_arn
}

output "managed_signer_key_arns" {
  description = "Non-exportable secp256k1 KMS signer keys. IAM signing grants remain in the runtime root."
  value       = { for role, key in aws_kms_key.managed_signer : role => key.arn }
}

output "managed_signer_aliases" {
  description = "Stable aliases used to derive and attest each managed signer's EVM address."
  value       = { for role, alias in aws_kms_alias.managed_signer : role => alias.name }
}

output "managed_signer_task_role_arns" {
  description = "Dedicated workload roles named in each signer key policy."
  value       = { for role, task_role in aws_iam_role.managed_signer_task : role => task_role.arn }
}

output "managed_signer_task_role_names" {
  description = "Dedicated workload role names used by runtime-owned least-privilege policies."
  value       = { for role, task_role in aws_iam_role.managed_signer_task : role => task_role.name }
}
