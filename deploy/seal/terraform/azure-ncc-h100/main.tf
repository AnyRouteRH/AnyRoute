# Azure NCC H100 v5 confidential VM (AMD SEV-SNP CPU, NVIDIA H100) with the SEAL installer staged.
#
# Limit, stated up front: SEV-SNP hosts are CPU-attested only. SNP has no runtime measurement register to bind GPU
# evidence into, so a SEAL host here can never carry confidential-GPU claims, and the sidecar has no SEV-SNP evidence
# provider yet, so today it cannot attest this VM at all. The module therefore stages the installer with
# --tee sev-snp --cc-mode off --lanes public: the attested and unlinkable lanes are refused by the installer and by the
# router. Use gcp-confidential (Intel TDX) or bare-metal TDX for the attested lanes.

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.0"
    }
  }
}

locals {
  installer_flags = trimspace(join(" ", [
    "--non-interactive --tee sev-snp --cc-mode off --lanes public",
    "--region ${var.seal_region}",
    var.seal_flags,
  ]))
}

resource "azurerm_resource_group" "seal" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_virtual_network" "seal" {
  name                = "${var.name}-vnet"
  resource_group_name = azurerm_resource_group.seal.name
  location            = azurerm_resource_group.seal.location
  address_space       = ["10.42.0.0/16"]
}

resource "azurerm_subnet" "seal" {
  name                 = "${var.name}-subnet"
  resource_group_name  = azurerm_resource_group.seal.name
  virtual_network_name = azurerm_virtual_network.seal.name
  address_prefixes     = ["10.42.1.0/24"]
}

resource "azurerm_public_ip" "seal" {
  name                = "${var.name}-ip"
  resource_group_name = azurerm_resource_group.seal.name
  location            = azurerm_resource_group.seal.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_security_group" "seal" {
  name                = "${var.name}-nsg"
  resource_group_name = azurerm_resource_group.seal.name
  location            = azurerm_resource_group.seal.location

  security_rule {
    name                       = "sidecar"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = tostring(var.sidecar_port)
    source_address_prefixes    = var.allowed_cidrs
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "ssh"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.ssh_cidrs
    destination_address_prefix = "*"
  }
}

resource "azurerm_network_interface" "seal" {
  name                = "${var.name}-nic"
  resource_group_name = azurerm_resource_group.seal.name
  location            = azurerm_resource_group.seal.location

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.seal.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.seal.id
  }
}

resource "azurerm_network_interface_security_group_association" "seal" {
  network_interface_id      = azurerm_network_interface.seal.id
  network_security_group_id = azurerm_network_security_group.seal.id
}

resource "azurerm_linux_virtual_machine" "seal" {
  name                  = var.name
  resource_group_name   = azurerm_resource_group.seal.name
  location              = azurerm_resource_group.seal.location
  size                  = var.vm_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.seal.id]
  secure_boot_enabled   = true
  vtpm_enabled          = true

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  os_disk {
    caching                  = "ReadWrite"
    storage_account_type     = "Premium_LRS"
    disk_size_gb             = var.os_disk_size_gb
    security_encryption_type = "VMGuestStateOnly"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-confidential-vm-jammy"
    sku       = "22_04-lts-cvm"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/../shared/stage-installer.sh.tftpl", {
    installer_b64   = filebase64("${path.module}/../../install.sh")
    installer_flags = local.installer_flags
    notes           = "AMD SEV-SNP: CPU-attested only, no confidential-GPU claims, and no sidecar evidence provider yet. Public lane only."
  }))
}
