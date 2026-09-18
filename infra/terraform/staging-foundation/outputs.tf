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
