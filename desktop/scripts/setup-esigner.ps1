$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:WINDOWS_SIGNING_PROVIDER -ne "sslcom-esigner") {
  Write-Output "eSigner setup skipped"
  exit 0
}

$required = @(
  "SSL_ESIGNER_USERNAME",
  "SSL_ESIGNER_PASSWORD",
  "SSL_ESIGNER_CREDENTIAL_ID",
  "SSL_ESIGNER_TOTP_SECRET"
)
foreach ($name in $required) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    Write-Output "::add-mask::$value"
  }
}

$version = "1.3.2"
$expectedSha256 = "f14b1e1ef14bfa1fd00279c363aab0debbf5dcfba0e4bcdce5d22bb771de0e3a"
$url = "https://github.com/SSLcom/CodeSignTool/releases/download/v$version/CodeSignTool-v$version.zip"
$archive = Join-Path $env:RUNNER_TEMP "CodeSignTool-v$version.zip"
$destination = Join-Path $env:RUNNER_TEMP "CodeSignTool-v$version"

Invoke-WebRequest -Uri $url -OutFile $archive
$actualSha256 = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "CodeSignTool archive digest mismatch"
}

if (Test-Path $destination) {
  Remove-Item -Recurse -Force $destination
}
Expand-Archive -Path $archive -DestinationPath $destination
$jars = @(Get-ChildItem -Path $destination -Recurse -File -Filter "code_sign_tool-$version.jar")
if ($jars.Count -ne 1) {
  throw "Expected exactly one pinned CodeSignTool jar, found $($jars.Count)"
}

"SSL_CODE_SIGN_JAR=$($jars[0].FullName)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
Write-Output "Verified CodeSignTool v$version"
