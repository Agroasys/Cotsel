locals {
  indexer_reviewed_config_sha256 = sha256(jsonencode([
    {
      name              = local.indexer_pipeline_container.name
      environment       = local.indexer_pipeline_environment
      secret_references = local.indexer_pipeline_secrets
    },
    {
      name              = local.indexer_graphql_container.name
      environment       = local.indexer_graphql_environment
      secret_references = local.indexer_graphql_secrets
    },
  ]))
}

resource "aws_ecs_task_definition" "indexer" {
  family                   = "${local.name_prefix}-indexer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = data.terraform_remote_state.foundation.outputs.runtime_execution_role_arns["indexer"]
  task_role_arn            = data.terraform_remote_state.foundation.outputs.runtime_task_role_arns["indexer"]
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "indexer-pipeline-tmp"
  }

  volume {
    name = "indexer-graphql-tmp"
  }

  container_definitions = jsonencode([
    local.indexer_pipeline_container,
    local.indexer_graphql_container,
  ])

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    ReviewedConfigSha256 = local.indexer_reviewed_config_sha256
  }
}

resource "aws_ecs_service" "indexer" {
  name                               = "${local.name_prefix}-indexer"
  cluster                            = aws_ecs_cluster.staging.id
  task_definition                    = aws_ecs_task_definition.indexer.arn
  desired_count                      = var.indexer_desired_count
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
    registry_arn = data.terraform_remote_state.foundation.outputs.runtime_service_discovery_arns["indexer-graphql"]
  }
}
