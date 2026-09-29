output "commands" {
  description = "What to run, in order. Nothing here is run by Terraform."
  value       = local.commands
}

output "note" {
  value = "Placeholder: no Phala Cloud resources are created by this module."
}
