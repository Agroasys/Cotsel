terraform {
  required_version = "~> 1.15"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  backend "s3" {
    bucket       = "agroasys-tfstate-655177116834"
    key          = "cotsel/base-sepolia-evidence-archive/terraform.tfstate"
    region       = "eu-north-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Programme   = "cotsel-production-readiness"
      WorkPackage = "WP-1"
      ManagedBy   = "terraform"
      Root        = "base-sepolia-evidence-archive"
      Environment = "staging"
    }
  }
}
