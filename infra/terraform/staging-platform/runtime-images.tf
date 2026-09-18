locals {
  postgres_host = split(":", local.postgres_endpoint)[0]

  # Reuse the deployment service set from naming.tf. Inventory tests keep both sources aligned.
  runtime_services = local.services

  runtime_repository_names = merge(
    { for service, repository in aws_ecr_repository.service : service => repository.name },
    { relayer = data.terraform_remote_state.foundation.outputs.ecr_repository_names["relayer"] },
  )

  runtime_repository_urls = merge(
    { for service, repository in aws_ecr_repository.service : service => repository.repository_url },
    { relayer = data.terraform_remote_state.foundation.outputs.ecr_repository_urls["relayer"] },
  )

  runtime_images = {
    for service in local.runtime_services : service =>
    "${local.runtime_repository_urls[service]}@${data.aws_ecr_image.release[service].image_digest}"
  }
}

data "aws_ecr_image" "release" {
  for_each = local.runtime_services

  repository_name = local.runtime_repository_names[each.value]
  image_tag       = var.gateway_image_tag
}
