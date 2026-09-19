locals {
  reconciliation_reviewed_config_sha256 = sha256(jsonencode({
    environment       = local.reconciliation_environment
    secret_references = local.reconciliation_secrets
    task_role_arn     = data.terraform_remote_state.foundation.outputs.runtime_task_role_arns["reconciliation"]
  }))
}

resource "aws_ecs_task_definition" "reconciliation" {
  family                   = "${local.name_prefix}-reconciliation"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = data.terraform_remote_state.foundation.outputs.runtime_execution_role_arns["reconciliation"]
  task_role_arn            = data.terraform_remote_state.foundation.outputs.runtime_task_role_arns["reconciliation"]
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "reconciliation-tmp"
  }

  container_definitions = jsonencode([local.reconciliation_container])

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    ReviewedConfigSha256 = local.reconciliation_reviewed_config_sha256
  }
}

resource "aws_ecs_service" "reconciliation" {
  name                               = "${local.name_prefix}-reconciliation"
  cluster                            = aws_ecs_cluster.staging.id
  task_definition                    = aws_ecs_task_definition.reconciliation.arn
  desired_count                      = var.reconciliation_desired_count
  launch_type                        = "FARGATE"
  enable_execute_command             = false
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
  health_check_grace_period_seconds  = 120

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups = [
      aws_security_group.internal_services.id,
      local.data_client_sg_id,
    ]
    subnets = local.private_subnet_ids
  }

  service_registries {
    registry_arn = data.terraform_remote_state.foundation.outputs.runtime_service_discovery_arns["reconciliation"]
  }

  depends_on = [
    aws_ecs_service.indexer,
  ]
}
