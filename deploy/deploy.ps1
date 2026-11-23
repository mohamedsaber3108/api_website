# Ships the committed HEAD to the server and activates it.
#   .\deploy\deploy.ps1 -Server 16.16.179.116 -Key C:\path\to\key.pem
# First time only, add -Setup to install Node, Caddy, the service, and /etc/wasl/wasl.env.
param(
  [Parameter(Mandatory)] [string] $Server,
  [Parameter(Mandatory)] [string] $Key,
  [string] $User = 'ubuntu',
  [switch] $Setup
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# Find OpenSSH even from 32-bit PowerShell, which cannot see System32\OpenSSH (it must use Sysnative).
function Find-Tool([string] $name) {
  $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  foreach ($dir in @("$env:windir\Sysnative\OpenSSH", "$env:windir\System32\OpenSSH", "$env:ProgramFiles\Git\usr\bin", "$env:ProgramFiles\OpenSSH")) {
    $p = Join-Path $dir "$name.exe"
    if (Test-Path $p) { return $p }
  }
  throw "$name was not found. Install it: Settings > System > Optional features > OpenSSH Client."
}
$sshExe = Find-Tool 'ssh'
$scpExe = Find-Tool 'scp'
if (-not (Test-Path $Key)) { throw "Key file not found: $Key" }

if (git status --porcelain) { throw 'Commit or stash your changes first: only committed code is deployed.' }
$sha = (git rev-parse HEAD).Trim()
$tar = Join-Path $env:TEMP "wasl-$sha.tar.gz"
git archive --format=tar.gz -o $tar HEAD
if ($LASTEXITCODE) { throw 'git archive failed' }
$ssh = @('-i', $Key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')
$target = "$User@$Server"

# Scripts are taken from the archive, not the working tree, so they always match the release.
& $sshExe @ssh $target "mkdir -p /tmp/wasl-deploy"
& $scpExe @ssh $tar "${target}:/tmp/wasl-deploy/release.tar.gz"
if ($LASTEXITCODE) { throw 'Upload failed' }
$remote = "set -e; cd /tmp/wasl-deploy; rm -rf src; mkdir src; tar -xzf release.tar.gz -C src deploy; " +
  $(if ($Setup) { 'sudo bash src/deploy/setup-server.sh; ' } else { '' }) +
  "sudo bash src/deploy/release.sh /tmp/wasl-deploy/release.tar.gz $sha"
& $sshExe @ssh $target $remote
if ($LASTEXITCODE) { throw 'Release failed' }
Remove-Item $tar
Write-Host "Deployed $sha to http://$Server"
