output "public_ip" {
  value = azurerm_public_ip.seal.ip_address
}

output "lanes" {
  description = "What this host can offer: SEV-SNP is CPU-attested only and carries no confidential-GPU claims."
  value       = ["public"]
}

output "limit" {
  value = "SEV-SNP: CPU claims only, never GPU-CC claims; the sidecar has no SEV-SNP evidence provider yet, so this host serves the public lane only."
}
