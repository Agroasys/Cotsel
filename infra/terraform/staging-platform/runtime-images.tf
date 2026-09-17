locals {
  postgres_host = split(":", local.postgres_endpoint)[0]

  # Reuse the deployment service set from naming.tf. Inventory tests keep both sources aligned.
  runtime_services = local.services

  runtime_images = {
    for service in local.runtime_services : service =>
    "${aws_ecr_repository.service[service].repository_url}@${data.aws_ecr_image.release[service].image_digest}"
  }
}

data "aws_ecr_image" "release" {
  for_each = local.runtime_services

  repository_name = aws_ecr_repository.service[each.value].name
  image_tag       = var.gateway_image_tag
}

data "aws_secretsmanager_secret" "oracle_wallet" {
  name = var.oracle_wallet_secret_name
}
