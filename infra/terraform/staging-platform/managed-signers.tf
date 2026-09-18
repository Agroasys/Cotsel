locals {
  managed_signer_aliases         = data.terraform_remote_state.foundation.outputs.managed_signer_aliases
  managed_signer_key_arns        = data.terraform_remote_state.foundation.outputs.managed_signer_key_arns
  managed_signer_task_role_arns  = data.terraform_remote_state.foundation.outputs.managed_signer_task_role_arns
  managed_signer_task_role_names = data.terraform_remote_state.foundation.outputs.managed_signer_task_role_names
}

check "foundation_exposes_only_approved_automated_signers" {
  assert {
    condition = (
      toset(keys(local.managed_signer_key_arns)) == toset(["oracle", "relayer"]) &&
      toset(keys(local.managed_signer_aliases)) == toset(["oracle", "relayer"]) &&
      toset(keys(local.managed_signer_task_role_arns)) == toset(["oracle", "relayer"]) &&
      toset(keys(local.managed_signer_task_role_names)) == toset(["oracle", "relayer"])
    )
    error_message = "The foundation state must expose exactly the Oracle and relayer signer custody identities."
  }
}
