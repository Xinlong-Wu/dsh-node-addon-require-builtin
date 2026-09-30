$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# VS is only the build host. Keep the VS2022-era compiler, linker, STL and CRT.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$installation = & $vswhere -latest -products * -version '[18.0,19.0)' `
    -requires Microsoft.VisualStudio.Component.VC.14.44.17.14.ARM64 `
    -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) {
    throw 'VS2026 with the MSVC 14.44 ARM64 component is required'
}

$tools = Get-ChildItem (Join-Path $installation 'VC\Tools\MSVC') -Directory |
    Where-Object { $_.Name -match '^14\.44\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
if (-not $tools) {
    throw 'MSVC 14.44 was not found; refusing to use the latest toolset'
}
foreach ($file in @('bin\Hostarm64\arm64\cl.exe', 'bin\Hostarm64\arm64\link.exe',
                    'lib\arm64\libcmt.lib', 'lib\arm64\libcpmt.lib', 'include\yvals_core.h')) {
    if (-not (Test-Path (Join-Path $tools.FullName $file))) {
        throw "Incomplete MSVC 14.44 installation: $file"
    }
}

$sdk = '10.0.26100.0'
$sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10"
foreach ($file in @("Include\$sdk\um\Windows.h", "Lib\$sdk\ucrt\arm64\libucrt.lib",
                    "Lib\$sdk\um\arm64\kernel32.lib")) {
    if (-not (Test-Path (Join-Path $sdkRoot $file))) {
        throw "Required Windows SDK $sdk is incomplete: $file"
    }
}

Write-Host "VS build host: $installation"
Write-Host "Pinned toolset: v143 / MSVC $($tools.Name); Windows SDK: $sdk"
if (-not $env:GITHUB_ENV) {
    throw 'GITHUB_ENV is required'
}
@(
    "npm_config_msvs_version=$installation"
    "NARB_MSVC_VERSION=$($tools.Name)"
    "NARB_WINDOWS_SDK_VERSION=$sdk"
) | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
