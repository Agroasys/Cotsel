output "cluster_arn" {
  description = "Cotsel staging ECS cluster."
  value       = aws_ecs_cluster.staging.arn
}

output "ecr_repository_urls" {
  description = "Immutable per-service ECR repositories."
  value       = { for name, repository in aws_ecr_repository.service : name => repository.repository_url }
}

output "secret_arns" {
  description = "Secret identities only. Values are never managed by Terraform."
  value       = { for name, secret in aws_secretsmanager_secret.platform : name => secret.arn }
}

output "gateway_alb" {
  description = "Private origin details for the future CloudFront VPC origin."
  value = {
    arn              = aws_lb.gateway.arn
    dns_name         = aws_lb.gateway.dns_name
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

output "gateway_runtime" {
  description = "Gateway ECS runtime metadata. Contains no secret values."
  value = {
    execution_role_arn = aws_iam_role.gateway_execution.arn
    image_tag          = var.gateway_image_tag
    service_arn        = aws_ecs_service.gateway.id
    service_name       = aws_ecs_service.gateway.name
    task_family        = aws_ecs_task_definition.gateway.family
    task_revision      = aws_ecs_task_definition.gateway.revision
    task_role_arn      = aws_iam_role.gateway_task.arn
  }
}

output "runtime_dependencies" {
  description = "Non-secret managed dependency coordinates consumed by the runtime root."
  value = {
    data_client_security_group_id = local.data_client_sg_id
    gateway_security_group_id     = aws_security_group.gateway.id
    internal_security_group_id    = aws_security_group.internal_services.id
    postgres_endpoint             = local.postgres_endpoint
    private_subnet_ids            = local.private_subnet_ids
    redis_primary_endpoint        = local.redis_primary_endpoint
    vpc_id                        = local.vpc_id
  }
}

output "kms_key_arn" {
  description = "Cotsel staging platform KMS key."
  value       = aws_kms_key.platform.arn
}
