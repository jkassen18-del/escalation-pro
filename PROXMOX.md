# Proxmox VE 9.1 work server: from USB stick to remote access

This guide turns a spare desktop into a small **work lab server** running Proxmox VE 9.1. When you finish:

- Proxmox runs on the desktop and you manage it from a web browser on your work laptop.
- InfraTicket (this repository) runs in its own Ubuntu virtual machine (VM), in Docker with PostgreSQL.
- You and your coworkers can reach it from the office network, and from outside the office over a secure private network (no ports opened to the internet).
- You can add more VMs for your other applications and projects (Linux or Windows).
- Everything is backed up every night.

It assumes no Linux experience. Every command is meant to be copied and pasted exactly. Text in `<angle brackets>` is a placeholder you replace with your own value (leave out the brackets).

> **Warning: installing Proxmox erases the whole disk you install it on.** Anything on that desktop's disk (Windows, files) is gone for good. Copy off anything you need first.

> **Before you start at work:** a server on the company network is something IT normally needs to know about. Ask them for (1) permission, (2) a **static IP address** (or a DHCP reservation) for the server and one for each VM, and (3) whether the company already has a VPN you should use for remote access. It also saves you from the server getting blocked by network security later.

---

## Contents

0. [What you need, and a worksheet to fill in](#0-what-you-need-and-a-worksheet-to-fill-in)
1. [Check the USB stick](#1-check-the-usb-stick)
2. [Set up the desktop's BIOS/UEFI](#2-set-up-the-desktops-biosuefi)
3. [Install Proxmox](#3-install-proxmox)
4. [First login from your laptop](#4-first-login-from-your-laptop)
5. [Switch to the free update repository and update](#5-switch-to-the-free-update-repository-and-update)
6. [Secure the root account (2FA)](#6-secure-the-root-account-2fa)
7. [Create accounts for you and your coworkers](#7-create-accounts-for-you-and-your-coworkers)
8. [Upload an Ubuntu installer to Proxmox](#8-upload-an-ubuntu-installer-to-proxmox)
9. [Create the InfraTicket VM](#9-create-the-infraticket-vm)
10. [Install Ubuntu inside the VM](#10-install-ubuntu-inside-the-vm)
11. [Connect to the VM over SSH](#11-connect-to-the-vm-over-ssh)
12. [Prepare Ubuntu (updates, guest agent, Docker)](#12-prepare-ubuntu-updates-guest-agent-docker)
13. [Install and start InfraTicket](#13-install-and-start-infraticket)
14. [Create the first administrator](#14-create-the-first-administrator)
15. [Remote access from outside the office](#15-remote-access-from-outside-the-office)
16. [HTTPS for InfraTicket](#16-https-for-infraticket)
17. [Backups](#17-backups)
18. [More VMs for your other apps and projects](#18-more-vms-for-your-other-apps-and-projects)
19. [Everyday tasks](#19-everyday-tasks)
20. [Troubleshooting](#20-troubleshooting)
21. [Glossary](#21-glossary)

---

## 0. What you need, and a worksheet to fill in

### Hardware

| | Minimum | Better |
| --- | --- | --- |
| CPU | 64-bit Intel or AMD with virtualization (almost any CPU from the last 10 years) | 6+ cores |
| RAM | 8 GB | 16–32 GB (each VM uses its own share) |
| Disk | 128 GB SSD | 500 GB+ SSD/NVMe, plus a second disk or USB drive for backups |
| Network | **Wired Ethernet cable** to the office network | Same |

> **Wi-Fi will not work properly.** Proxmox shares the network card with the VMs through a "bridge", and bridges do not work over Wi-Fi. Use a cable.

Also have: a monitor, keyboard and mouse for the desktop (only needed during installation), the USB stick, and your work laptop.

### Worksheet

Fill this in before step 3 (get the network values from IT, or see the tip below). Keep the passwords in a password manager.

| Item | Example | Yours |
| --- | --- | --- |
| Proxmox server IP address | `192.168.1.50` | |
| Network size (CIDR) | `/24` (same as subnet mask 255.255.255.0) | |
| Gateway (router) | `192.168.1.1` | |
| DNS server | `192.168.1.1` (or IT's DNS server) | |
| Proxmox hostname (FQDN) | `pve.lab.local` | |
| Proxmox `root` password | (long, unique) | |
| InfraTicket VM IP address | `192.168.1.51` | |
| InfraTicket VM username / password | `labadmin` / (long, unique) | |

**Tip: finding the network values yourself.** On your work laptop (connected to the same office network), open *Command Prompt* and run `ipconfig`. Under your Ethernet or Wi-Fi adapter:

- *Default Gateway* → your gateway.
- *Subnet Mask* `255.255.255.0` → `/24`; `255.255.254.0` → `/23`; `255.255.0.0` → `/16`.
- *IPv4 Address* tells you the range (for example `192.168.1.x`). **Do not just pick a free-looking address** on a work network. Ask IT for one; a duplicate IP knocks someone else offline.

Run `ipconfig /all` to see *DNS Servers*.

---

## 1. Check the USB stick

Proxmox's documentation says Rufus must write the image in **DD Image mode**. If Rufus asked you "ISO Image mode or DD Image mode" and you chose ISO mode, the stick may not boot or may fail halfway through installing.

If you are not sure, redo it (takes 2 minutes):

1. Open Rufus, select the USB stick under *Device*.
2. *Boot selection* → **SELECT** → choose `proxmox-ve_9.1-*.iso`.
3. Leave *Partition scheme* as Rufus sets it. Click **START**.
4. When asked, choose **Write in DD Image mode** → OK.
5. If Rufus offers to download a different GRUB or other files, click **No**.
6. Confirm that the stick will be erased. Wait for *READY*.

---

## 2. Set up the desktop's BIOS/UEFI

1. Plug the desktop into the **network cable**, monitor, keyboard and mouse. Plug in the USB stick.
2. Turn it on and immediately tap the setup key repeatedly. It is usually **Del** or **F2** (Dell: F2, HP: F10, Lenovo: F1 or F2). The screen at power-on usually tells you.
3. Find and set these (names vary by manufacturer; look under *Advanced*, *CPU Configuration*, *Security* or *Virtualization*):

| Setting | Set to | Why |
| --- | --- | --- |
| Intel Virtualization Technology (VT-x) / AMD-V / SVM Mode | **Enabled** | Required to run VMs |
| VT-d / AMD IOMMU | **Enabled** | Optional, useful later |
| Boot mode | **UEFI** | Modern default |
| Secure Boot | Either is fine (Proxmox 9 supports it). If the USB will not boot, set it to **Disabled** | |
| Restore on AC power loss / After power failure | **Power On** | Server comes back by itself after a power cut |
| Sleep / Deep sleep / ErP | **Disabled** | A server must not sleep |
| SATA mode | **AHCI** (not RAID/Intel RST) | Otherwise the installer may not see the disk |

4. Save and exit (usually **F10**).
5. As it restarts, open the **boot menu** (usually **F12**; HP: F9; some: F11 or Esc) and choose the USB stick (often listed as *UEFI: <USB brand>*).

---

## 3. Install Proxmox

The installer shows a menu. Choose **Install Proxmox VE (Graphical)** and press Enter. Wait for it to load (a minute or two).

> If you get an error that says *No support for hardware-accelerated KVM virtualization detected*, virtualization is off in the BIOS. Go back to step 2.

Go through the screens:

1. **End User License Agreement** → **I agree**.
2. **Target Harddisk** → pick the disk to install on (check the size so you pick the right one if there are several).
   - Click **Options**: *Filesystem* **ext4** is the simplest choice for a single disk. Leave the rest as is.
   - If you have **two identical disks** and want them mirrored, choose *ZFS (RAID1)* and tick both disks instead. Skip this if unsure.
   - → **Next**. Remember: this disk is wiped.
3. **Location and Time Zone** → your country, time zone and keyboard layout → **Next**.
4. **Administration Password and Email**
   - *Password* / *Confirm*: the `root` password from your worksheet. `root` is the all-powerful admin account, so make it long.
   - *Email*: your email (Proxmox sends alerts here, e.g. failed backups).
   - → **Next**.
5. **Management Network Configuration**. This is the most important screen:
   - *Management Interface*: the wired network card (usually `enp…` or `eno…`). It should show a green/connected indicator.
   - *Hostname (FQDN)*: from your worksheet, e.g. `pve.lab.local`. It must contain a dot.
   - *IP Address (CIDR)*: e.g. `192.168.1.50/24`.
   - *Gateway*: e.g. `192.168.1.1`.
   - *DNS Server*: e.g. `192.168.1.1`.
   - The installer pre-fills values it got from the network. Replace them with the static ones from your worksheet.
   - → **Next**.
6. **Summary** → check everything. Leave *Automatically reboot after successful installation* ticked. → **Install**.
7. When it says it will reboot, **pull out the USB stick** as the screen goes black, so it does not boot the installer again.

After the reboot the desktop shows a black text screen like:

```
Welcome to the Proxmox Virtual Environment. Please use your web browser to
configure this server - connect to:

  https://192.168.1.50:8006/

pve login:
```

That is correct. You will rarely use this screen again; you can unplug the monitor, keyboard and mouse once step 4 works.

---

## 4. First login from your laptop

1. On your work laptop (on the office network), open Chrome or Edge and go to **`https://<proxmox-ip>:8006`**, e.g. `https://192.168.1.50:8006`.
   - It must be **https** and must end in **:8006**.
2. The browser warns *Your connection is not private*. That is expected: Proxmox uses its own self-signed certificate. Click **Advanced** → **Continue to 192.168.1.50 (unsafe)**.
3. Log in:
   - *User name*: `root`
   - *Password*: your root password
   - *Realm*: **Linux PAM standard authentication**
   - → **Login**.
4. A pop-up says **No valid subscription**. This is normal for the free version. Click **OK**. It appears on every login; ignore it.

### A quick tour of the screen

- **Left panel (resource tree):** *Datacenter* at the top → your server (node, e.g. `pve`) → later your VMs and storage (`local`, `local-lvm`).
- **Middle panel:** settings for whatever you click on the left.
- **Top right:** **Create VM**, **Create CT** (container), and your user menu.
- **Bottom panel (Tasks):** a log of everything you do. If something fails, double-click the task to see why.

The node's **Shell** button (top right when you select the node) opens a root terminal on the server in your browser. You will use it a few times.

---

## 5. Switch to the free update repository and update

Out of the box Proxmox points at the **enterprise** repository, which needs a paid subscription; updates fail until you change it.

1. Left panel → click your node (`pve`) → **Updates** → **Repositories**.
2. In the list, select each row whose URL contains **`enterprise.proxmox.com`** (there is one for `pve-enterprise` and one for Ceph) → click **Disable**.
3. Click **Add** → *Repository*: **No-Subscription** → **Add**. (Click OK on the "no subscription" note.)
4. If there is a Ceph row and it complains, also **Add** → **Ceph … No-Subscription**. (You will not use Ceph; this just keeps the warnings quiet.)
5. Go to **Updates** (one level up) → **Refresh**. A window shows the package list downloading; wait for `TASK OK` and close it.
6. Click **Upgrade**. A terminal opens and asks `Do you want to continue? [Y/n]`. Type `y` and press Enter. Wait until it finishes.
7. If the kernel was updated, reboot: node → **Reboot** (top right). Wait 2–3 minutes and refresh the browser page.

Repeat steps 5–6 every few weeks (or whenever you see updates listed).

Same thing from the **Shell** if you prefer:

```bash
apt update && apt full-upgrade -y
```

---

## 6. Secure the root account (2FA)

Since other people will log in to this server, protect `root` with two-factor authentication.

1. Top right → **root@pam** → **TFA** → **Add** → **TOTP**.
2. Scan the QR code with an authenticator app (Microsoft Authenticator, Google Authenticator, Authy…).
3. Type the 6-digit code into *Verify Code* → **Add**.
4. Also add **Recovery Keys** (TFA → Add → Recovery Keys) and store them in your password manager. They get you in if you lose your phone.

From now on, logging in asks for the code.

> **Never forward port 8006 (or 22) on the router to the internet.** Section 15 gives safe ways to reach the server from outside.

---

## 7. Create accounts for you and your coworkers

Do not share the `root` password. Give each person their own account.

### 7.1 Create a group

1. **Datacenter** → **Permissions** → **Groups** → **Create**.
2. *Name*: `admins` (people who can do anything) → **Create**. Repeat for `users` (people who can only use VMs).

### 7.2 Create users

1. **Datacenter** → **Permissions** → **Users** → **Add**.
2. Fill in:
   - *User name*: e.g. `jordan`
   - *Realm*: **Proxmox VE authentication server**
   - *Password*: a temporary password (they change it later via their user menu → **Password**)
   - *Group*: `admins` or `users`
   - *Email*: optional
3. **Add**. Repeat for each person.

### 7.3 Give the groups permissions

1. **Datacenter** → **Permissions** → **Add** → **Group Permission**.
2. For admins: *Path* `/`, *Group* `admins`, *Role* **Administrator**, *Propagate* ticked → **Add**.
3. For users: *Path* `/`, *Group* `users`, *Role* **PVEVMUser** (can see, start, stop and use the console of VMs; cannot delete or create them) → **Add**.
   - To limit someone to a single VM, use *Path* `/vms/<vm-id>` (e.g. `/vms/101`) instead of `/`.

When they log in, they pick **Realm: Proxmox VE authentication server**. Ask everyone with admin rights to set up 2FA as in step 6.

> These accounts are for **Proxmox** (the server and its VMs). InfraTicket has its own separate accounts (step 14).

---

## 8. Upload an Ubuntu installer to Proxmox

InfraTicket runs in a VM with **Ubuntu Server 24.04 LTS** (free, supported until 2029, and the most documented Linux for beginners).

1. Left panel → expand your node → click **local (pve)** → **ISO Images**.
2. Click **Download from URL**:
   - *URL*: the link to the Ubuntu Server 24.04 LTS ISO. Get the current one from <https://ubuntu.com/download/server> (right-click the download button → *Copy link address*). It looks like `https://releases.ubuntu.com/24.04/ubuntu-24.04.x-live-server-amd64.iso`.
   - Click **Query URL** (fills in the file name) → **Download**.
3. Wait for `TASK OK` (it is about 3 GB).

(Alternatively, download the ISO on your laptop and use **Upload** instead.)

---

## 9. Create the InfraTicket VM

Click **Create VM** (top right). Turn on **Advanced** (bottom left of the wizard) so you see every option.

**General**
- *Node*: `pve`
- *VM ID*: `101`
- *Name*: `infraticket`
- Tick **Start at boot** (so it starts when the server boots).
- → **Next**

**OS**
- *Use CD/DVD disc image file (iso)*: *Storage* `local`, *ISO image*: the Ubuntu ISO.
- *Type*: **Linux**, *Version*: **6.x – 2.6 Kernel**.
- → **Next**

**System**
- *Graphic card*: Default
- *Machine*: **q35**
- *BIOS*: Default (SeaBIOS) is fine.
- *SCSI Controller*: **VirtIO SCSI single**
- Tick **Qemu Agent**.
- → **Next**

**Disks**
- *Bus/Device*: **SCSI**
- *Storage*: **local-lvm**
- *Disk size (GiB)*: **64** (more if you will store many attachments)
- Tick **Discard** and **SSD emulation** (if the server has an SSD), and **IO thread**.
- → **Next**

**CPU**
- *Sockets*: 1, *Cores*: **2** (4 if you have 8+ cores)
- *Type*: **host** (best performance)
- → **Next**

**Memory**
- *Memory (MiB)*: **4096** (4 GB). 8192 if you have RAM to spare.
- → **Next**

**Network**
- *Bridge*: **vmbr0** (this connects the VM to the office network like a real PC)
- *Model*: **VirtIO (paravirtualized)**
- Leave *Firewall* ticked.
- → **Next**

**Confirm** → tick **Start after created** → **Finish**.

The VM appears under your node as `101 (infraticket)`.

---

## 10. Install Ubuntu inside the VM

1. Click the VM `101 (infraticket)` → **Console**. You see the Ubuntu installer.
2. Click inside the console so it receives your keyboard. Use the **arrow keys**, **Tab**, **Space** (to tick boxes) and **Enter**.

Go through the installer:

1. *Language*: English → Enter.
2. If offered an installer update: **Continue without updating** is fine.
3. *Keyboard*: your layout → **Done**.
4. *Type of installation*: **Ubuntu Server** → **Done**.
5. **Network** (important): it shows an interface like `ens18` with a DHCP address.
   - To set the static IP from your worksheet: select `ens18` → Enter → **Edit IPv4** → *IPv4 Method*: **Manual**:
     - *Subnet*: `192.168.1.0/24` (your network, ending in `.0`, with your CIDR)
     - *Address*: `192.168.1.51`
     - *Gateway*: `192.168.1.1`
     - *Name servers*: `192.168.1.1`
     - *Search domains*: leave empty
     - → **Save** → **Done**.
   - (If IT gave you a DHCP reservation instead, leave it on DHCP.)
6. *Proxy*: leave empty → **Done** (unless your office requires a web proxy; ask IT).
7. *Ubuntu archive mirror*: wait for the test to pass → **Done**.
8. *Storage*: **Use an entire disk** (it's the 64 GB virtual disk, not the real one) → **Done**.
   - On the summary screen, the root `/` volume may only use part of the disk. Select the `ubuntu-lv` line → **Edit** → set *Size* to the maximum shown → **Save**. → **Done** → **Continue**.
9. *Profile*:
   - *Your name*: e.g. `Lab Admin`
   - *Server's name*: `infraticket`
   - *Username*: e.g. `labadmin`
   - *Password*: from your worksheet
   - → **Done**
10. *Ubuntu Pro*: **Skip for now** → **Continue**.
11. *SSH*: tick **Install OpenSSH server** (Space). Leave *Import SSH key* off. → **Done**.
12. *Featured server snaps*: tick **nothing** (Docker comes later the proper way) → **Done**.
13. Wait for the install to finish. When **Reboot Now** appears, select it.
14. If it says *Please remove the installation medium*, go to VM → **Hardware** → double-click **CD/DVD Drive** → **Do not use any media** → OK, then press Enter in the console.
15. Log in on the console with your username and password (the password is not shown as you type; that is normal).

---

## 11. Connect to the VM over SSH

The Proxmox console works, but copy/paste is clumsy. Use SSH from your laptop instead.

On your Windows work laptop, open **PowerShell** or **Windows Terminal** and run:

```powershell
ssh labadmin@192.168.1.51
```

- The first time it asks `Are you sure you want to continue connecting (yes/no)?` → type `yes`.
- Enter the VM password.

You now have a terminal on the VM. **Paste** with right-click (or Ctrl+Shift+V in Windows Terminal).

> **Tip for projects:** install **VS Code** on your laptop with the **Remote - SSH** extension. *F1 → Remote-SSH: Connect to Host → `labadmin@192.168.1.51`*. You then edit files on the server as if they were local, with a terminal built in.

### Optional: log in without a password (SSH key)

On your **laptop** (PowerShell):

```powershell
ssh-keygen -t ed25519
# press Enter three times to accept defaults (you may set a passphrase)
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh labadmin@192.168.1.51 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Next time `ssh labadmin@192.168.1.51` logs straight in.

---

## 12. Prepare Ubuntu (updates, guest agent, Docker)

Run each block in the SSH session. `sudo` runs a command as administrator and asks for your VM password.

### 12.1 Update everything

```bash
sudo apt update && sudo apt full-upgrade -y
```

### 12.2 Guest agent (lets Proxmox shut the VM down cleanly and show its IP)

```bash
sudo apt install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent
```

Then **reboot the VM** so Proxmox detects it:

```bash
sudo reboot
```

Wait a minute and reconnect with `ssh labadmin@192.168.1.51`. In Proxmox, the VM's **Summary** now shows its IP address.

### 12.3 Install Docker, Docker Compose and Git

```bash
sudo apt install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

The last line lets you use Docker without `sudo`. **Log out and back in** for it to apply:

```bash
exit
```

```powershell
ssh labadmin@192.168.1.51
```

Check it works:

```bash
docker run --rm hello-world
docker compose version
```

You should see *Hello from Docker!* and a Compose version number.

### 12.4 Automatic security updates

Ubuntu Server installs `unattended-upgrades`, which applies security updates daily. Confirm it is on:

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
```

Choose **Yes**.

---

## 13. Install and start InfraTicket

### 13.1 Give the server read access to the GitHub repository

The repository is private, so the VM needs a key GitHub accepts. A **deploy key** gives read-only access to this one repository.

On the VM:

```bash
ssh-keygen -t ed25519 -C "infraticket-lab-server" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
```

Copy the whole line it prints (starts with `ssh-ed25519`). Then in your browser:

1. Go to the repository on GitHub → **Settings** → **Deploy keys** → **Add deploy key**.
2. *Title*: `Proxmox lab server`. *Key*: paste. Leave **Allow write access** unticked → **Add key**.

Back on the VM, tell SSH to use that key for GitHub:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T git@github.com
```

Type `yes` when asked. It should say *You've successfully authenticated, but GitHub does not provide shell access.* That is success.

### 13.2 Download the code

```bash
sudo mkdir -p /opt/infraticket
sudo chown $USER:$USER /opt/infraticket
git clone git@github.com:jkassen18-del/escalation-pro.git /opt/infraticket
cd /opt/infraticket
```

### 13.3 Create the settings file (`.env`)

This creates the file with fresh random secrets. Before pasting, change `192.168.1.51` in the `APP_URL` line to your VM's IP, and `Service Desk` to your team's name (shown in the app). Then paste the whole block:

```bash
cd /opt/infraticket
cat > .env <<EOF
SESSION_SECRET=$(openssl rand -hex 32)
SECRET_KEY=$(openssl rand -hex 32)
SETUP_TOKEN=$(openssl rand -hex 16)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_URL=http://192.168.1.51:3000
ORGANIZATION_NAME=Service Desk
SESSION_COOKIE_SECURE=false
EOF
chmod 600 .env
cat .env
```

What these are:

| Setting | Meaning |
| --- | --- |
| `SESSION_SECRET` | Signs login cookies |
| `SECRET_KEY` | Encrypts stored integration passwords and backups. **If you lose it, those are unreadable.** |
| `SETUP_TOKEN` | Needed to create the first admin, so a stranger cannot claim the server |
| `POSTGRES_PASSWORD` | Database password (only applied the very first time the database is created) |
| `APP_URL` | The address people use; links in notifications are built from it |
| `SESSION_COOKIE_SECURE` | `false` while you use plain `http://`; `true` once you switch to HTTPS (section 16) |

**Copy the output of `cat .env` into your password manager now**, especially `SECRET_KEY` and `SETUP_TOKEN`.

### 13.4 Build and start

```bash
cd /opt/infraticket
docker compose up -d --build
```

The first build takes 3–10 minutes. Then check:

```bash
docker compose ps
curl -s localhost:3000/health
```

`docker compose ps` should show `app` and `postgres` as **running** (`healthy` after a minute), and the health check should print something like `{"status":"ok","database":"postgres",...}`.

Both containers have `restart: unless-stopped`, so they start again automatically after a reboot.

### 13.5 Open it

On your laptop browser: **`http://192.168.1.51:3000`** (your VM's IP).

---

## 14. Create the first administrator

The first page on a new install is **Create the first administrator**.

1. Fill in your name, email and a strong password.
2. *Setup token*: the `SETUP_TOKEN` value from `.env` (run `grep SETUP_TOKEN /opt/infraticket/.env` on the VM to see it).
3. Submit. You are signed in as the administrator.

Then add your coworkers in InfraTicket on the **People** page (there is no public sign-up). See [docs/getting-started.md](docs/getting-started.md) and [docs/roles-and-permissions.md](docs/roles-and-permissions.md) for the rest of the setup (departments, SLAs, integrations).

At this point anyone **in the office network** can use InfraTicket at `http://192.168.1.51:3000` and you can manage Proxmox at `https://192.168.1.50:8006`.

---

## 15. Remote access from outside the office

Pick **one** of these. In order of preference:

### Option A: the company VPN (ask IT first)

If your company already has a VPN, and you connect your work laptop to it from home, you can most likely reach `https://192.168.1.50:8006` and `http://192.168.1.51:3000` exactly as in the office. Nothing to install on the server. Ask IT to confirm the VPN can reach those addresses.

### Option B: Tailscale (easiest if there is no VPN)

Tailscale creates a private encrypted network between your devices. Nothing is opened to the internet, and it works through office firewalls. Check its current plans and pricing at <https://tailscale.com/pricing> (a free personal plan exists; a team of several people may need a paid plan or each person sharing access). **Check with IT that you may install it on your work laptop.**

1. Create an account at <https://tailscale.com> (sign in with your Microsoft/Google work account).
2. Install it on the **Proxmox host**: in Proxmox → node → **Shell**:

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   tailscale up
   ```

   It prints a link. Open it in your browser and approve the device.
3. Install it on the **InfraTicket VM** (SSH):

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

   Open the link and approve.
4. Install the Tailscale app on your **work laptop** and sign in with the same account.
5. In the Tailscale admin console (<https://login.tailscale.com/admin/machines>) each device gets a `100.x.y.z` address and a name. From anywhere with internet:
   - Proxmox: `https://<proxmox-tailscale-ip>:8006` (or `https://pve:8006` with MagicDNS)
   - InfraTicket: `http://<vm-tailscale-ip>:3000` (or `http://infraticket:3000`)
6. Recommended: in the admin console, for the server and VM, click **…** → **Disable key expiry**, so they do not drop off the network after 180 days.
7. Coworkers: invite them (**Users → Invite users**) or share the specific machines with them (**Machines → … → Share**).

### Option C: Cloudflare Tunnel (to publish InfraTicket on a real domain)

If you own a domain managed by Cloudflare, the repository's `docker-compose.yml` already includes a tunnel. This publishes InfraTicket at e.g. `https://tickets.yourdomain.com` with real HTTPS, again without opening ports, and **Cloudflare Access** (free for up to 50 users) can require a work-email login before anyone sees the page. See [docs/lab-server.md](docs/lab-server.md) and the comments in `docker-compose.yml`. Do **not** publish Proxmox itself this way.

### What not to do

- Do not forward ports on the router (8006, 22, 3000) to the internet.
- Do not install remote-desktop tools like AnyDesk/TeamViewer on the server for access. They are not needed and widen the attack surface.

---

## 16. HTTPS for InfraTicket

Plain `http://` works for a start. You want HTTPS for secure cookies and phone push notifications, and before Slack/Teams links. Two easy routes:

**With Tailscale (option B):**

1. Tailscale admin console → **DNS** → enable **MagicDNS** and **HTTPS Certificates**.
2. On the VM:

   ```bash
   sudo tailscale serve --bg 3000
   tailscale serve status
   ```

   It shows an address like `https://infraticket.<your-tailnet>.ts.net`, with a valid certificate.
3. Update `.env`:

   ```bash
   cd /opt/infraticket
   nano .env
   ```

   Change `APP_URL=https://infraticket.<your-tailnet>.ts.net` and `SESSION_COOKIE_SECURE=true`. Save with **Ctrl+O**, Enter, exit with **Ctrl+X**.
4. Apply:

   ```bash
   docker compose up -d
   ```

From then on use the `https://…ts.net` address. (With `SESSION_COOKIE_SECURE=true`, logging in at `http://192.168.1.51:3000` no longer works; that is intended.)

**With Cloudflare Tunnel (option C):** set `APP_URL=https://tickets.yourdomain.com` and `SESSION_COOKIE_SECURE=true`, then `docker compose --profile tunnel up -d`.

**Inside the office with your own domain/certificate:** see "HTTPS on the internal network" in [docs/lab-server.md](docs/lab-server.md).

---

## 17. Backups

A server without backups is a disaster waiting to happen. Set up two layers.

### 17.1 Whole-VM backups in Proxmox (to a separate disk)

Backups on the **same disk** as the VMs do not help when that disk dies. Use a second internal disk, a USB drive, or a network share (NAS).

**Using a USB drive or second disk** (this wipes that drive):

1. Plug it in. Node → **Disks**. Find it (e.g. `/dev/sdb`; check the size and model so you pick the right one).
2. Select it → **Wipe Disk** → Yes.
3. Node → **Disks** → **Directory** → **Create: Directory**:
   - *Disk*: the drive, *Filesystem*: **ext4**, *Name*: `backup`, tick **Add Storage** → **Create**.
4. **Datacenter** → **Storage** → double-click `backup` → *Content*: make sure **Backup** (VZDump backup file) is selected → OK.

**Using a NAS (Windows/SMB share):** **Datacenter** → **Storage** → **Add** → **SMB/CIFS** → ID `nas-backup`, server, username, password, share, *Content*: **Backup**.

**Schedule:**

1. **Datacenter** → **Backup** → **Add**.
2. *Storage*: `backup`, *Schedule*: `02:00` (daily at 2 am), *Selection mode*: **All**, *Mode*: **Snapshot**, *Compression*: ZSTD.
3. **Retention** tab: *Keep Daily* `7`, *Keep Weekly* `4`, *Keep Monthly* `3`.
4. **Notification**: *Notify* **Always** or **On failure only** (the email from step 3).
5. **Create**. Select the job → **Run now** once to test, and watch the task log at the bottom.

**Restore:** storage `backup` → **Backups** → select one → **Restore**.

### 17.2 Snapshots before risky changes

Before an upgrade or experiment: VM → **Snapshots** → **Take Snapshot** (name it, e.g. `before-upgrade`). If things break: select it → **Rollback**. Delete old snapshots when done; they are not backups (they live on the same disk).

### 17.3 InfraTicket's own data

Proxmox backups cover the whole VM, including the database. For an extra, portable copy of just the InfraTicket data, see [docs/backing-up-infraticket.md](docs/backing-up-infraticket.md). A simple one-off PostgreSQL dump:

```bash
cd /opt/infraticket
docker compose exec postgres pg_dump -U escalation -Fc escalation_pro > ~/infraticket-$(date +%F).pgdump
```

**Keep a copy of `.env` (the `SECRET_KEY`) in your password manager**, separate from the backups.

---

## 18. More VMs for your other apps and projects

Repeat steps 8–12 for each new Linux VM (new VM ID, name and IP). One VM per application or project keeps them from breaking each other, and you can snapshot/back up each separately.

Rough RAM budget for a 16 GB desktop: Proxmox itself ~2 GB, InfraTicket VM 4 GB, leaves ~10 GB for others. The node's **Summary** shows CPU, RAM and disk usage live.

### Several small apps in one VM

You can also run several Docker apps in one Ubuntu VM, each in its own folder with its own `docker-compose.yml`, each on a different port (e.g. 3000, 3001, 8080). A web UI like **Portainer** can help manage them.

### LXC containers (lighter than VMs)

**Create CT** makes a container that shares the host's kernel: it starts in seconds and uses little RAM. Templates: node → `local` → **CT Templates** → **Templates** → pick e.g. `ubuntu-24.04-standard`. Good for small single-purpose Linux services; use a VM for Docker and anything you are unsure about.

> You will find "Proxmox helper scripts" online that install apps with one command. They run as root on your server; read what a script does before running it, and prefer official install instructions on a work server.

### A Windows VM

1. Upload a Windows 11 or Windows Server ISO (you need a valid license; ask IT).
2. Also download the **VirtIO drivers ISO** (`virtio-win.iso`, linked from the Proxmox wiki "Windows VirtIO Drivers" page) to `local` → ISO Images → Download from URL.
3. **Create VM**: *OS Type* **Microsoft Windows**, *Version* **11/2022/2025**. The wizard then sets UEFI (OVMF), an EFI disk and TPM 2.0 (needed by Windows 11): keep them on `local-lvm`. Disk: SCSI, 80+ GB. CPU: 4 cores, type `host`. Memory: 8192. Network: VirtIO.
4. Before starting: VM → **Hardware** → **Add** → **CD/DVD Drive** → the `virtio-win` ISO.
5. During Windows setup, when no disk appears: **Load driver** → browse the VirtIO CD → `vioscsi\w11\amd64` → Next. The disk appears.
6. After installing, open the VirtIO CD in Windows and run **virtio-win-guest-tools.exe** (network driver, guest agent and more).
7. Enable **Remote Desktop** in Windows (Settings → System → Remote Desktop), then connect from your laptop with the **Remote Desktop Connection** app to the VM's IP. Much smoother than the Proxmox console.

---

## 19. Everyday tasks

| Task | How |
| --- | --- |
| Start/stop/restart a VM | Click it → **Start** / **Shutdown** (clean) / **Reboot**. Avoid **Stop** (like pulling the plug) unless it is frozen. |
| See a VM's screen | VM → **Console** |
| Shut down the whole server | Node → **Shutdown**. VMs with the guest agent shut down cleanly first. |
| Update Proxmox | Node → **Updates** → **Refresh** → **Upgrade** |
| Update Ubuntu in a VM | `sudo apt update && sudo apt full-upgrade -y` |
| Update InfraTicket | See below |
| View InfraTicket logs | `cd /opt/infraticket && docker compose logs -f app` (Ctrl+C to stop) |
| Restart InfraTicket | `cd /opt/infraticket && docker compose restart app` |
| Grow a VM's disk | VM → **Hardware** → select disk → **Disk Action** → **Resize**. Inside Ubuntu: `sudo growpart /dev/sda 3 && sudo pvresize /dev/sda3 && sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv` |
| Add RAM/CPU to a VM | VM → **Hardware** → double-click **Memory** or **Processors** → change → shut down and start the VM |

### Updating InfraTicket

Take a snapshot first (17.2). Then:

```bash
cd /opt/infraticket
git pull
docker compose up -d --build
curl -s localhost:3000/health
```

The database schema upgrades itself on start.

---

## 20. Troubleshooting

**The USB stick does not show in the boot menu / does not boot.**
Re-create it in Rufus with **DD Image mode** (step 1). Try another USB port (a rear one, USB 2.0 if available). Disable Secure Boot.

**The installer says no virtualization support (KVM).**
Enable VT-x/AMD-V in the BIOS (step 2).

**The installer does not see the disk.**
Set SATA mode to AHCI in the BIOS.

**Cannot open `https://<ip>:8006`.**
- Use `https://`, not `http://`, and include `:8006`.
- On the server's console, log in as `root` and run `ip a`. The address on **vmbr0** is the real IP. Check the cable light.
- From the laptop, `ping <ip>`. No reply: wrong IP/gateway, or the network blocks it (ask IT).
- If you need to fix the IP: on the server console run `nano /etc/network/interfaces`, correct the `address` and `gateway` lines under `vmbr0`, also fix the IP in `nano /etc/hosts`, save, and run `systemctl restart networking` (or reboot).

**"Login failed" on Proxmox.**
Check the *Realm*: `root` uses **Linux PAM**; the users you created use **Proxmox VE authentication server**.

**Updates fail with "401 Unauthorized" / enterprise repository errors.**
Do step 5 again: every `enterprise` repository must be disabled.

**A VM gets no IP address / no internet.**
Check its network device uses **vmbr0**. Some company networks only allow one device per wall port, or block unknown devices (802.1X/port security). If the Proxmox host works but VMs do not, ask IT.

**`docker: permission denied`.**
You skipped logging out after `usermod` in 12.3. Log out and back in, or put `sudo` in front.

**InfraTicket health shows `"database":"sqlite"`.**
The app is not using PostgreSQL. Run `docker compose up -d` (not `docker compose up -d app`) from `/opt/infraticket`.

**InfraTicket: login does nothing / you are thrown back to the login page.**
`SESSION_COOKIE_SECURE=true` while using `http://`. Either use the HTTPS address, or set it to `false` in `.env` and run `docker compose up -d`.

**"That setup token is not correct".**
Copy it again: `grep SETUP_TOKEN /opt/infraticket/.env`.

**The page does not load at `http://<vm-ip>:3000`.**
On the VM: `docker compose ps` (both running?), `curl -s localhost:3000/health`, `docker compose logs --tail 100 app` for errors.

**Everything is slow.**
Node → **Summary**: if RAM is near 100%, give VMs less memory or add RAM. Do not give VMs more total RAM than the machine has.

---

## 21. Glossary

| Term | Meaning |
| --- | --- |
| **Proxmox VE** | The operating system on the desktop. It runs virtual machines and containers, and you manage it in a browser. |
| **Node** | One physical Proxmox server (yours is `pve`). |
| **VM (virtual machine)** | A complete computer simulated in software, with its own OS. |
| **CT / LXC container** | A lightweight Linux environment sharing the host's kernel. |
| **ISO** | An installer disc image file. |
| **vmbr0** | The virtual network switch that connects VMs to your office network. |
| **local / local-lvm** | Proxmox's storage: `local` holds ISOs, templates and backups; `local-lvm` holds VM disks. |
| **Snapshot** | A point-in-time state of a VM you can roll back to (same disk; not a backup). |
| **SSH** | A secure text terminal to a Linux machine over the network. |
| **Docker / Compose** | Runs apps in containers; Compose starts several (InfraTicket + PostgreSQL) from one file. |
| **`sudo`** | Runs a command as administrator. |
| **CIDR (`/24`)** | Short way to write the subnet mask (`/24` = `255.255.255.0`). |
| **Tailscale** | A private, encrypted network linking your devices across the internet. |

---

Verified against the Proxmox VE, Ubuntu, Docker and Tailscale documentation as of Proxmox VE 9.1; untested on your hardware and network. Menu names can shift slightly between minor versions.
