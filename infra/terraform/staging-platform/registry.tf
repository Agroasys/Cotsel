locals {
  # The relayer repository is a foundation prerequisite. Keeping it out of the
  # runtime state prevents a full-platform plan from being required merely to
  # restore the release-image publication path.
  platform_registry_services = setsubtract(local.services, toset(["relayer"]))
}

resource "aws_ecr_repository" "service" {
  for_each = local.platform_registry_services

  name                 = "cotsel/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.platform.arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = aws_ecr_repository.service

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
