# Builds the Windows installer on a Windows x64 machine from a source archive. build-win.sh on the Mac
# copies this folder and the archive over and runs it; it can also run by hand:
#
#   build-installer.ps1 -Source src.tar.gz -Work C:\rm-build\ableton-control-deck [-Icon control-deck.ico] [-NoSign]
#
# Output: <Work>\out\Ableton-Control-Deck-<version>-Windows-Setup.exe, for x64 and ARM64, signed with
# sign.cmd unless -NoSign. Node.js comes from nodejs.org, checked against SHASUMS256 and its signature.
param(
    [Parameter(Mandatory)] [string] $Source,
    [Parameter(Mandatory)] [string] $Work,
    [string] $Icon = '',
    [switch] $NoSign
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sign = Join-Path $here 'sign.cmd'
$signtool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'
$iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
$nodeSigners = 'OpenJS Foundation|Node\.js Foundation'

function Step($text) { Write-Output "`n> $text" }
function Run($exe) {
    & $exe @args
    if ($LASTEXITCODE -ne 0) { throw "$exe $args failed ($LASTEXITCODE)" }
}

$runtime = Join-Path $Work 'runtime'
$nodeDir = Join-Path $Work 'node'
$cache = Join-Path (Split-Path -Parent $Work) 'node-cache'
$out = Join-Path $Work 'out'
foreach ($dir in $runtime, $nodeDir, $out) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } }
New-Item -ItemType Directory -Force $runtime, $nodeDir, $out, $cache | Out-Null

# ------------------------------------------------------------------ runtime
Step 'Staging the runtime'
Run tar -xzf $Source -C $runtime
$version = (Get-Content (Join-Path $runtime 'package.json') -Raw | ConvertFrom-Json).version
$nodeVersion = (Get-Content (Join-Path $runtime 'installer\node-version.json') -Raw | ConvertFrom-Json).version
foreach ($item in 'tests', 'docs', 'macos', 'installer', '.github', 'remote-script\tests', 'dashboard\tests',
    'Install Ableton Control Deck.command', 'Install Ableton Control Deck.cmd', '.gitattributes', '.gitignore') {
    $path = Join-Path $runtime $item
    if (Test-Path $path) { Remove-Item -Recurse -Force $path }
}

Step 'Building'
Push-Location $runtime
try {
    Run npm.cmd ci --no-fund --no-audit --loglevel=error
    Run npm.cmd run --silent build
    Run node max-for-live\build-device.mjs | Out-Null
    Push-Location dashboard
    Run npm.cmd ci --no-fund --no-audit --loglevel=error
    Run npm.cmd run --silent build | Out-Null

    Step 'Removing build-only files'
    Run npm.cmd prune --omit=dev --no-fund --no-audit --loglevel=error
    # Compilers and image tools Next.js only needs while building, all native code for one architecture.
    foreach ($item in '.next\cache', 'node_modules\@img', 'node_modules\sharp') { if (Test-Path $item) { Remove-Item -Recurse -Force $item } }
    Get-ChildItem node_modules\@next -Directory -Filter 'swc-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Pop-Location
    Run npm.cmd prune --omit=dev --no-fund --no-audit --loglevel=error
} finally {
    Pop-Location
}
foreach ($item in 'tsconfig.json', 'vitest.config.ts') { $path = Join-Path $runtime $item; if (Test-Path $path) { Remove-Item -Force $path } }
Get-ChildItem (Join-Path $runtime 'max-for-live\build') -Filter '*.tmp' -ErrorAction SilentlyContinue | Remove-Item -Force
Set-Content -Encoding ascii (Join-Path $runtime 'packaged.json') "{ `"version`": `"$version`", `"node`": `"$nodeVersion`" }"

$native = Get-ChildItem $runtime -Recurse -File -Include '*.node', '*.dll', '*.exe' | Select-Object -ExpandProperty FullName
if ($native) { throw "Unexpected native code in the runtime (it would need building for both architectures):`n$($native -join "`n")" }

# --------------------------------------------------------------------- Node
Step "Node.js $nodeVersion from nodejs.org"
$base = "https://nodejs.org/dist/v$nodeVersion"
$sums = Join-Path $cache "SHASUMS256-$nodeVersion.txt"
Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile $sums -UseBasicParsing
foreach ($arch in 'x64', 'arm64') {
    $name = "node-v$nodeVersion-win-$arch"
    $zip = Join-Path $cache "$name.zip"
    if (-not (Test-Path $zip)) { Invoke-WebRequest "$base/$name.zip" -OutFile $zip -UseBasicParsing }
    $expected = (Select-String -Path $sums -Pattern "^([0-9a-f]{64})\s+$([regex]::Escape("$name.zip"))$").Matches.Groups[1].Value
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $expected -or $expected -ne $actual) {
        Remove-Item -Force $zip
        throw "Checksum mismatch for $name.zip; deleted it. Run the build again."
    }
    $unpacked = Join-Path $cache $name
    if (-not (Test-Path "$unpacked\$name\node.exe")) { Expand-Archive $zip -DestinationPath $unpacked -Force }
    New-Item -ItemType Directory -Force "$nodeDir\$arch" | Out-Null
    Copy-Item "$unpacked\$name\node.exe" "$nodeDir\$arch\node.exe"
    Copy-Item "$unpacked\$name\LICENSE" "$nodeDir\LICENSE" -Force
    $signature = Get-AuthenticodeSignature "$nodeDir\$arch\node.exe"
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch $nodeSigners) {
        throw "The $arch node.exe is not validly signed by the OpenJS Foundation: $($signature.Status) $($signature.SignerCertificate.Subject)"
    }
    Write-Output "  ${arch}: checksum matches, signed by $(($signature.SignerCertificate.Subject -split ',')[0])"
}
Set-Content -Encoding ascii "$nodeDir\VERSION" $nodeVersion

# ------------------------------------------------------------------ package
Step 'Packaging'
$defines = @("/DVersion=$version", "/DStaging=$runtime", "/DNodeDir=$nodeDir", "/DOutDir=$out")
if ($Icon) { $defines += "/DIcon=$((Resolve-Path $Icon).Path)" }
if (-not $NoSign) { $defines += '/DSign', "/Srmsign=`"$sign`" `$f" }
Run $iscc /Q @defines (Join-Path $here 'control-deck.iss')
$setup = Join-Path $out "Ableton-Control-Deck-$version-Windows-Setup.exe"
if (-not $NoSign) {
    & $signtool verify /pa /q $setup
    if ($LASTEXITCODE -ne 0) { throw 'installer signature check failed' }
    Write-Output "  signed by $((Get-AuthenticodeSignature $setup).SignerCertificate.Subject)"
}
Write-Output "`n$setup ($([math]::Round((Get-Item $setup).Length / 1MB)) MB)"
