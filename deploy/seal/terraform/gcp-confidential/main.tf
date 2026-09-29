# GCP A3 High confidential VM (Intel TDX, NVIDIA H100 in confidential-computing mode) with the SEAL installer staged.
#
# This is the attested-lane target: TDX gives the sidecar a quote, and the H100 can run in CC mode. The module creates
# one VM and a firewall rule for the sidecar port; it does not start the engine or the sidecar (see NEXT.txt on the VM).
# Check current A3 confidential availability (zones, provisioning model, supported images) before applying.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0"
    }
  }
}

locals {
  installer_flags = trimspace(join(" ", [
    "--non-interactive --tee tdx --attestation tdx",
    "--region ${var.seal_region}",
    var.seal_flags,
  ]))
}

resource "google_compute_instance" "seal" {
  project      = var.project
  zone         = var.zone
  name         = var.name
  machine_type = var.machine_type
  tags         = ["anyroute-seal"]

  confidential_instance_config {
    confidential_instance_type = "TDX"
  }

  scheduling {
    on_host_maintenance         = "TERMINATE"
    automatic_restart           = false
    provisioning_model          = var.provisioning_model
    preemptible                 = var.provisioning_model == "SPOT"
    instance_termination_action = var.provisioning_model == "SPOT" ? "STOP" : null
  }

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = var.boot_disk_size_gb
      type  = var.boot_disk_type
    }
  }

  network_interface {
    network = var.network
    dynamic "access_config" {
      for_each = var.public_ip ? [1] : []
      content {}
    }
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    startup-script = templatefile("${path.module}/../shared/stage-installer.sh.tftpl", {
      installer_b64   = filebase64("${path.module}/../../install.sh")
      installer_flags = local.installer_flags
      notes           = "Intel TDX confidential VM: the attested lanes are available once the sidecar runs with --attestation tdx."
    })
  }
}

resource "google_compute_firewall" "sidecar" {
  project       = var.project
  name          = "${var.name}-sidecar"
  network       = var.network
  direction     = "INGRESS"
  target_tags   = ["anyroute-seal"]
  source_ranges = var.allowed_cidrs

  allow {
    protocol = "tcp"
    ports    = [tostring(var.sidecar_port)]
  }
}
