output "instance_name" {
  value = google_compute_instance.seal.name
}

output "external_ip" {
  value = var.public_ip ? google_compute_instance.seal.network_interface[0].access_config[0].nat_ip : null
}

output "verify_command" {
  description = "Run once the sidecar is up."
  value       = var.public_ip ? "bun scripts/seal-cli.ts verify https://${google_compute_instance.seal.network_interface[0].access_config[0].nat_ip}:${var.sidecar_port}" : null
}
