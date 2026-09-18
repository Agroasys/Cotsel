locals {
  existing_release_services = toset([
    "auth",
    "gateway",
    "indexer-graphql",
    "indexer-pipeline",
    "oracle",
    "reconciliation",
    "ricardian",
    "treasury",
  ])

  foundation_release_services = toset([
    "relayer",
  ])

  authoritative_release_services = setunion(
    local.existing_release_services,
    local.foundation_release_services,
  )
}

# The existing repositories remain owned by the historical staging-platform
# state. Reading them here proves that the foundation plan is operating against
# the complete release cohort without taking duplicate Terraform ownership.
data "aws_ecr_repository" "existing" {
  for_each = local.existing_release_services

  name = "cotsel/${each.key}"
}

data "aws_kms_alias" "platform" {
  name = "alias/cotsel-staging-platform"
}

resource "aws_ecr_repository" "foundation" {
  for_each = local.foundation_release_services

  name                 = "cotsel/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = data.aws_kms_alias.platform.target_key_arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecr_lifecycle_policy" "foundation" {
  for_each = aws_ecr_repository.foundation

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged build layers after seven days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Retain the latest 50 immutable release images"
        selection = {
          tagStatus = "tagged"
          tagPrefixList = [
            "sha-",
          ]
          countType   = "imageCountMoreThan"
          countNumber = 50
        }
        action = { type = "expire" }
      },
    ]
  })
}

check "release_repository_cohort_is_complete" {
  assert {
    condition = local.authoritative_release_services == toset([
      "auth",
      "gateway",
      "indexer-graphql",
      "indexer-pipeline",
      "oracle",
      "reconciliation",
      "relayer",
      "ricardian",
      "treasury",
    ])
    error_message = "The staging foundation must describe the complete authoritative release-image cohort."
  }
}
