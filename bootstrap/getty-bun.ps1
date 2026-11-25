# getty-bun.ps1: the Windows starter of Getty's Bun runtime (Windows PowerShell 5.1 and
# PowerShell 7).
#
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <root>\bootstrap\getty-bun.ps1 <command>
#     run <entry> [args...]   ensure, then run the pinned Bun on <root>\<entry>
#     ensure                  install the pinned Bun if missing
#     status                  one JSON object on stdout
#
# Contract: bootstrap/README.md and docs/plan.md in getty-bun; behavior and exit codes are
# those of getty-bun.sh. stdout belongs to the entry; every starter failure is one
# "getty-bun: " line on stderr and exit 1. Keep this file pure ASCII with LF line endings:
# Windows PowerShell 5.1 reads a file without BOM in the ANSI code page.
#
# >>> getty-bun pin: generated, do not edit >>>
# version 1.4.5
# target linux-x64 bun-linux-x64.zip 94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb bun-linux-x64/bun
# target linux-x64-baseline bun-linux-x64-baseline.zip dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463 bun-linux-x64-baseline/bun
# target linux-aarch64 bun-linux-aarch64.zip 18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 bun-linux-aarch64/bun
# target windows-x64 bun-windows-x64.zip 815ab45ec7f549abf87e6869584b506eab088e24225683957b7e150b47d6de30 bun-windows-x64/bun.exe
# target windows-x64-baseline bun-windows-x64-baseline.zip 3c081c73865e7a3453a9d514cc2ba3d699880621bcf67bb17241ff5194cb1d4b bun-windows-x64-baseline/bun.exe
# <<< getty-bun pin <<<

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- failures and output -----------------------------------------------------------

# A starter failure: the main body prints the message as one "getty-bun: " line, exit 1.
function Fail([string]$Message) {
    $e = New-Object System.Exception $Message
    $e.Data['getty-bun'] = $true
    throw $e
}

# The .NET exception behind PowerShell's wrappers (MethodInvocationException and kin).
function Get-Cause($Exception) {
    $e = $Exception
    while ($e -is [System.Management.Automation.RuntimeException] -and $null -ne $e.InnerException) { $e = $e.InnerException }
    $e
}

# One line as UTF-8 bytes with LF on a standard stream, independent of the console code page.
function Write-Bytes([System.IO.Stream]$Stream, [string]$Text) {
    $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($Text + "`n")
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

function ConvertTo-JsonString([string]$Value) {
    '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

# --- environment and target --------------------------------------------------------

# Drive-absolute (C:\ or C:/) or UNC (\\server\share, \\?\...).
function Test-AbsolutePath([string]$Path) {
    if ($Path.StartsWith('\\', [System.StringComparison]::Ordinal)) { return $true }
    if ($Path.Length -lt 3 -or $Path[1] -cne ':' -or ($Path[2] -cne '\' -and $Path[2] -cne '/')) { return $false }
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.IndexOf($Path[0]) -ge 0
}

# GETTY_HOME if set (absolute), else the user profile's .getty (never $HOME: Git Bash sets
# HOME to a /c/Users/... path).
function Get-GettyHome {
    $h = $env:GETTY_HOME
    if ($null -eq $h) {
        $userProfile = [Environment]::GetFolderPath('UserProfile')
        if ([string]::IsNullOrEmpty($userProfile)) { Fail 'cannot find the user profile directory; set GETTY_HOME to an absolute path' }
        return [System.IO.Path]::Combine($userProfile, '.getty')
    }
    if (-not (Test-AbsolutePath $h)) { Fail ("GETTY_HOME must be an absolute path, got '" + $h + "'") }
    if ($h.IndexOfAny([char[]](0..31)) -ge 0) { Fail 'GETTY_HOME contains control characters' }
    while ($h.Length -gt 3 -and ($h.EndsWith('\', [System.StringComparison]::Ordinal) -or $h.EndsWith('/', [System.StringComparison]::Ordinal))) {
        $h = $h.Substring(0, $h.Length - 1)
    }
    $h
}

function Get-LockWait {
    $w = $env:GETTY_BUN_LOCK_WAIT
    if ($null -eq $w) { return 300 }
    if ($w.Length -eq 0 -or $w.Trim([char[]]'0123456789').Length -ne 0) {
        Fail ("GETTY_BUN_LOCK_WAIT must be a whole number of seconds, got '" + $w + "'")
    }
    $w = $w.TrimStart([char]'0')
    if ($w.Length -eq 0) { return 0 }
    if ($w.Length -gt 9) { return 999999999 }
    [int]$w
}

function Assert-Architecture {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrEmpty($arch)) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -eq 'AMD64') { return }
    $supported = ': getty-bun.ps1 supports windows-x64 and windows-x64-baseline'
    if ($arch -eq 'ARM64') { Fail ('unsupported target windows-aarch64 (PROCESSOR_ARCHITECTURE ARM64)' + $supported) }
    if ([string]::IsNullOrEmpty($arch)) { Fail ('unsupported target windows-unknown (PROCESSOR_ARCHITECTURE is not set)' + $supported) }
    Fail ('unsupported target windows-' + $arch.ToLowerInvariant() + ' (PROCESSOR_ARCHITECTURE ' + $arch + ')' + $supported)
}

# PF_AVX2_INSTRUCTIONS_AVAILABLE (40); false whenever the probe cannot run (Constrained
# Language Mode, no compiler, an old Windows). Add-Type compiles: install and status only.
function Test-Avx2 {
    try {
        if ($null -eq ('GettyBun.Cpu' -as [type])) {
            Add-Type -Namespace GettyBun -Name Cpu -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(uint feature);'
        }
        return [bool]([GettyBun.Cpu]::IsProcessorFeaturePresent(40))
    } catch {
        return $false
    }
}

function Get-InstallTarget {
    if (Test-Avx2) { 'windows-x64' } else { 'windows-x64-baseline' }
}

# --- pin ---------------------------------------------------------------------------

# The pin block of this file (format: bootstrap/README.md): exact string comparisons only.
function Read-Pin([string]$Path) {
    try { $lines = [System.IO.File]::ReadAllLines($Path) } catch { Fail ('cannot read the starter ' + $Path + ' to find its pin') }
    $pin = @{ file = $Path; version = ''; targets = @{} }
    $inBlock = $false
    foreach ($line in $lines) {
        if ($line -ceq '# >>> getty-bun pin: generated, do not edit >>>') { $inBlock = $true; continue }
        if (-not $inBlock) { continue }
        if ($line -ceq '# <<< getty-bun pin <<<') { break }
        if ($line.StartsWith('# version ', [System.StringComparison]::Ordinal)) {
            $pin.version = $line.Substring(10)
        } elseif ($line.StartsWith('# target ', [System.StringComparison]::Ordinal)) {
            $fields = $line.Substring(9).Split([char]' ')
            if ($fields.Count -eq 4) { $pin.targets[$fields[0]] = $fields }
        }
    }
    if (-not $inBlock) { Fail ('no pin block in ' + $Path) }
    if ($pin.version.Length -eq 0) { Fail ('the pin block in ' + $Path + ' has no version line') }
    $pin
}

# target, archive, sha256, member
function Get-PinTarget($Pin, [string]$Target) {
    if (-not $Pin.targets.ContainsKey($Target)) { Fail ('the pin block in ' + $Pin.file + ' has no line for target ' + $Target) }
    $Pin.targets[$Target]
}

# --- slot --------------------------------------------------------------------------

# ready: the receipt's first three lines name this pin's version and the target and
# bin\bun.exe exists; missing: no slot; mismatch: anything else. No JSON parse, no hashing,
# no Bun start.
function Get-SlotState([string]$Slot, [string]$Version, [string]$Target) {
    if (-not [System.IO.Directory]::Exists($Slot)) {
        if ([System.IO.File]::Exists($Slot)) { return 'mismatch' }
        try { $null = [System.IO.File]::GetAttributes($Slot) } catch { return 'missing' }
        return 'mismatch' # a dangling link or junction
    }
    $receipt = [System.IO.Path]::Combine($Slot, 'receipt.json')
    if (-not [System.IO.File]::Exists($receipt) -or -not [System.IO.File]::Exists([System.IO.Path]::Combine($Slot, 'bin', 'bun.exe'))) {
        return 'mismatch'
    }
    # The bytes as they are (Latin-1: no BOM skipped, no decoding); three whole LF lines, as
    # getty-bun.sh reads them (a CRLF receipt is a mismatch there too).
    try { $text = [System.Text.Encoding]::GetEncoding(28591).GetString([System.IO.File]::ReadAllBytes($receipt)) } catch { return 'mismatch' }
    $head = "{`n" + '  "version": "' + $Version + "`",`n" + '  "target": "' + $Target + '",'
    if ($text.StartsWith($head, [System.StringComparison]::Ordinal) -and
        ($text.Length -eq $head.Length -or $text[$head.Length] -ceq "`n")) {
        return 'ready'
    }
    'mismatch'
}

# The fast path: the first ready slot of windows-x64 and windows-x64-baseline, without
# AVX2 detection (an x64 install that died with an illegal instruction left a baseline slot).
function Find-ReadySlot([string]$BunDir, $Pin) {
    foreach ($target in 'windows-x64', 'windows-x64-baseline') {
        if (-not $Pin.targets.ContainsKey($target)) { continue }
        $slot = [System.IO.Path]::Combine($BunDir, $Pin.version, $target)
        if ((Get-SlotState $slot $Pin.version $target) -ceq 'ready') {
            return @{ target = $target; slot = $slot }
        }
    }
}

function Fail-Mismatch([string]$Slot, [string]$Version, [string]$Target) {
    Fail ('slot ' + $Slot + ' does not match the pin ' + $Version + ' ' + $Target + ' (receipt.json or bin\bun.exe); it is left untouched, remove it to reinstall')
}

function Get-ReceiptText([string]$Version, [string[]]$Fields, [string]$BinarySha256, [string]$VerifiedAt) {
    (@(
        '{',
        ('  "version": "' + $Version + '",'),
        ('  "target": "' + $Fields[0] + '",'),
        ('  "archiveSha256": "' + $Fields[2] + '",'),
        '  "contractVersion": 1,',
        ('  "archive": "' + $Fields[1] + '",'),
        ('  "member": "' + $Fields[3] + '",'),
        ('  "binarySha256": "' + $BinarySha256 + '",'),
        '  "executable": "bin/bun.exe",',
        ('  "verifiedAt": "' + $VerifiedAt + '"'),
        '}'
    ) -join "`n") + "`n"
}

# --- install -----------------------------------------------------------------------

# The install lock: the lock file opened with FileShare.None, retried until the deadline.
# Returns the open FileStream, or nothing when the wait ran out.
function Enter-Lock([string]$Path, [int]$WaitSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    while ($true) {
        try {
            return [System.IO.File]::Open($Path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch {
            $cause = Get-Cause $_.Exception
            if ($cause.GetType() -ne [System.IO.IOException]) { Fail ('cannot open the lock file ' + $Path + ': ' + $cause.Message) }
        }
        if ([DateTime]::UtcNow -ge $deadline) { return }
        Start-Sleep -Milliseconds 200
    }
}

# Diagnostics for a waiter; never ownership (README "Install lock and .installing"): a
# complete temporary file, then a rename in the same directory. processStartToken is the
# process creation time as a FILETIME, environmentId the machine name and the user SID.
function Write-Installing([string]$Path, [string]$InstallId, [string]$Version, [string]$Target) {
    $name = 'powershell'
    $start = 'null'
    $environment = 'null'
    try {
        $me = [System.Diagnostics.Process]::GetCurrentProcess()
        $name = $me.ProcessName
        $start = '"start-filetime:' + $me.StartTime.ToFileTimeUtc() + '"'
    } catch { }
    try {
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if (-not [string]::IsNullOrEmpty($sid)) { $environment = ConvertTo-JsonString ([Environment]::MachineName + '/windows/' + $sid) }
    } catch { }
    $text = (@(
        '{',
        '  "schemaVersion": 1,',
        ('  "pid": ' + $PID + ','),
        ('  "processName": ' + (ConvertTo-JsonString $name) + ','),
        ('  "processStartToken": ' + $start + ','),
        ('  "installId": "' + $InstallId + '",'),
        ('  "environmentId": ' + $environment + ','),
        ('  "requestedVersion": "' + $Version + '",'),
        ('  "target": "' + $Target + '"'),
        '}'
    ) -join "`n") + "`n"
    $temp = $Path + '.' + $PID
    try { [System.IO.File]::WriteAllText($temp, $text) } catch { Fail ('cannot write ' + $temp + ': ' + (Get-Cause $_.Exception).Message) }
    # The lock holder is the only writer: an old record (a killed holder's) goes first, since
    # File.Move on .NET Framework does not overwrite.
    try {
        if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Delete($Path) }
        [System.IO.File]::Move($temp, $Path)
    } catch {
        Fail ('cannot write ' + $Path + ': ' + (Get-Cause $_.Exception).Message)
    }
}

# Removes .installing and its temporary file; never fails.
function Remove-Installing([string]$Path) {
    foreach ($file in $Path, ($Path + '.' + $PID)) {
        try { [System.IO.File]::Delete($file) } catch { }
    }
}

function Save-Archive([string]$Url, [string]$Path) {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    $client = New-Object System.Net.WebClient
    try {
        $client.Headers.Add('User-Agent', 'getty-bun')
        $client.DownloadFile($Url, $Path)
    } catch {
        Fail ('download of ' + $Url + ' failed: ' + (Get-Cause $_.Exception).Message)
    } finally {
        $client.Dispose()
    }
}

function Get-Sha256([string]$Path) {
    try { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
    catch { Fail ('cannot compute the SHA256 of ' + $Path + ': ' + (Get-Cause $_.Exception).Message) }
}

# The archive holds exactly the member plus directory entries of its parents; extracts
# the member by name.
function Expand-Member([string]$Zip, [string]$Member, [string]$Destination, [string]$Url) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    try { $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip) }
    catch { Fail ('cannot list the entries of the archive from ' + $Url + ': ' + (Get-Cause $_.Exception).Message) }
    try {
        $found = @()
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if ($name -ceq $Member) { $found += $entry; continue }
            if ($name.EndsWith('/', [System.StringComparison]::Ordinal) -and $Member.Length -gt $name.Length -and
                $Member.StartsWith($name, [System.StringComparison]::Ordinal)) { continue }
            Fail ("unexpected entry '" + $name + "' in the archive from " + $Url + ' (expected only ' + $Member + ')')
        }
        if ($found.Count -ne 1) {
            Fail ('the archive from ' + $Url + ' holds the member ' + $Member + ' ' + $found.Count + ' times, expected once')
        }
        try { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($found[0], $Destination, $false) }
        catch { Fail ('cannot extract ' + $Member + ' from ' + $Url + ': ' + (Get-Cause $_.Exception).Message) }
    } finally {
        $archive.Dispose()
    }
}

# bun --version with its own empty stdin (never the host's input) and its stderr discarded
# (the starter's stderr carries one getty-bun line at most), as getty-bun.sh does.
function Invoke-Probe([string]$Exe) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = '--version'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    try { $p = [System.Diagnostics.Process]::Start($psi) }
    catch { return @{ code = $null; text = ''; error = (Get-Cause $_.Exception).Message } }
    try {
        Close-Quietly $p.StandardInput
        $null = $p.StandardError.ReadToEndAsync()
        $text = $p.StandardOutput.ReadToEnd()
        $p.WaitForExit()
        @{ code = $p.ExitCode; text = $text.Trim(); error = $null }
    } finally {
        $p.Dispose()
    }
}

# The --version probe, retried once after about 1 s when Bun does not start or fails
# (antivirus may hold a fresh exe). result: ok, illegal-instruction, fails or version.
function Test-Bun([string]$Exe, [string]$Version) {
    $illegalInstruction = -1073741795 # STATUS_ILLEGAL_INSTRUCTION, 0xC000001D
    $r = Invoke-Probe $Exe
    if ($r.code -ne 0 -and $r.code -ne $illegalInstruction) {
        Start-Sleep -Seconds 1
        $r = Invoke-Probe $Exe
    }
    if ($r.code -eq $illegalInstruction) { return @{ result = 'illegal-instruction'; detail = 'illegal instruction, STATUS_ILLEGAL_INSTRUCTION' } }
    if ($null -ne $r.error) { return @{ result = 'fails'; detail = ($Exe + ' --version could not start: ' + $r.error) } }
    if ($r.code -ne 0) { return @{ result = 'fails'; detail = ($Exe + ' --version exited with ' + $r.code) } }
    if ($r.text -cne $Version) { return @{ result = 'version'; detail = $r.text } }
    @{ result = 'ok'; detail = '' }
}

# Directory.Move of the whole staged slot, retried on sharing violations for about 10 s
# (antivirus); never a copy into the slot.
function Move-Directory([string]$From, [string]$To) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($true) {
        if ([System.IO.Directory]::Exists($To) -or [System.IO.File]::Exists($To)) {
            Fail ('slot ' + $To + ' appeared during the install; it is left untouched')
        }
        try {
            [System.IO.Directory]::Move($From, $To)
            return
        } catch {
            $cause = Get-Cause $_.Exception
            if ([DateTime]::UtcNow -ge $deadline -or -not ($cause -is [System.IO.IOException] -or $cause -is [System.UnauthorizedAccessException])) {
                Fail ('cannot publish ' + $To + ' (rename from ' + $From + ' failed: ' + $cause.Message + ')')
            }
        }
        Start-Sleep -Milliseconds 250
    }
}

function Remove-Tree([string]$Path) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([System.IO.Directory]::Exists($Path)) {
        try { [System.IO.Directory]::Delete($Path, $true) }
        catch {
            if ([DateTime]::UtcNow -ge $deadline) { return }
            Start-Sleep -Milliseconds 250
        }
    }
}

# One target under its lock: 'ready', or 'illegal-instruction' when the staged Bun cannot
# run on this CPU (nothing published, staging removed, lock released).
function Install-Target($Pin, [string]$BunDir, [string]$Target, [int]$WaitSeconds) {
    $version = $Pin.version
    $fields = Get-PinTarget $Pin $Target
    $sha256 = $fields[2]
    $slot = [System.IO.Path]::Combine($BunDir, $version, $Target)
    $state = Get-SlotState $slot $version $Target
    if ($state -ceq 'ready') { return 'ready' }
    if ($state -ceq 'mismatch') { Fail-Mismatch $slot $version $Target }

    $lockDir = [System.IO.Path]::Combine($BunDir, '.locks', $version, $Target)
    $lockPath = [System.IO.Path]::Combine($lockDir, '.install.lock')
    $installing = [System.IO.Path]::Combine($lockDir, '.installing')
    try { $null = [System.IO.Directory]::CreateDirectory($lockDir) }
    catch { Fail ('cannot create the lock directory ' + $lockDir + ': ' + (Get-Cause $_.Exception).Message) }
    $lock = Enter-Lock $lockPath $WaitSeconds
    if ($null -eq $lock) {
        if ((Get-SlotState $slot $version $Target) -ceq 'ready') { return 'ready' }
        $see = ''
        if ([System.IO.File]::Exists($installing)) { $see = '; see ' + $installing }
        Fail ('timed out after ' + $WaitSeconds + ' s waiting for the install lock ' + $lockPath + $see)
    }
    $stage = $null
    $wroteInstalling = $false
    try {
        # Another process may have published while this one waited.
        $state = Get-SlotState $slot $version $Target
        if ($state -ceq 'ready') { return 'ready' }
        if ($state -ceq 'mismatch') { Fail-Mismatch $slot $version $Target }

        $stagingRoot = [System.IO.Path]::Combine($BunDir, '.staging')
        $id = [System.IO.Path]::GetRandomFileName().Replace('.', '')
        $stage = [System.IO.Path]::Combine($stagingRoot, $id)
        try { $null = [System.IO.Directory]::CreateDirectory([System.IO.Path]::Combine($stage, 'slot', 'bin')) }
        catch { Fail ('cannot create a staging directory in ' + $stagingRoot + ': ' + (Get-Cause $_.Exception).Message) }
        $wroteInstalling = $true
        Write-Installing $installing $id $version $Target

        $mirror = $env:GETTY_BUN_MIRROR
        if ([string]::IsNullOrEmpty($mirror)) { $mirror = 'https://github.com/oven-sh/bun/releases/download' }
        $url = $mirror.TrimEnd('/') + '/bun-v' + $version + '/' + $fields[1]
        $zip = [System.IO.Path]::Combine($stage, 'archive.zip')
        Save-Archive $url $zip
        $got = Get-Sha256 $zip
        if ($got -cne $sha256) { Fail ('checksum mismatch for ' + $url + ': sha256 ' + $got + ', pinned ' + $sha256 + '; nothing was published') }

        $stagedExe = [System.IO.Path]::Combine($stage, 'slot', 'bin', 'bun.exe')
        Expand-Member $zip $fields[3] $stagedExe $url
        $probe = Test-Bun $stagedExe $version
        if ($probe.result -ceq 'illegal-instruction') { return 'illegal-instruction' }
        if ($probe.result -ceq 'fails') { Fail ('the Bun from ' + $url + ' does not run (' + $probe.detail + '); nothing was published') }
        if ($probe.result -ceq 'version') {
            Fail ("version mismatch: the Bun from " + $url + " reports '" + $probe.detail + "', pinned " + $version + '; nothing was published')
        }

        $receiptPath = [System.IO.Path]::Combine($stage, 'slot', 'receipt.json')
        $verifiedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
        $receipt = Get-ReceiptText $version $fields (Get-Sha256 $stagedExe) $verifiedAt
        try { [System.IO.File]::WriteAllText($receiptPath, $receipt) }
        catch { Fail ('cannot write ' + $receiptPath + ': ' + (Get-Cause $_.Exception).Message) }
        $versionDir = [System.IO.Path]::Combine($BunDir, $version)
        try { $null = [System.IO.Directory]::CreateDirectory($versionDir) }
        catch { Fail ('cannot create ' + $versionDir + ': ' + (Get-Cause $_.Exception).Message) }
        Move-Directory ([System.IO.Path]::Combine($stage, 'slot')) $slot

        # Published. Free the lock before anything starts Bun again: an entry never holds it.
        Remove-Installing $installing
        $wroteInstalling = $false
        $lock.Dispose()
        $lock = $null
        Remove-Tree $stage
        $stage = $null

        $exe = [System.IO.Path]::Combine($slot, 'bin', 'bun.exe')
        $probe = Test-Bun $exe $version
        if ($probe.result -cne 'ok') {
            $detail = $probe.detail
            if ($probe.result -ceq 'version') { $detail = "reports '" + $probe.detail + "', pinned " + $version }
            Fail ('the published Bun ' + $exe + ' does not run (' + $detail + '); the slot ' + $slot + ' stays as published')
        }
        return 'ready'
    } finally {
        if ($wroteInstalling) { Remove-Installing $installing }
        if ($null -ne $lock) { $lock.Dispose() }
        if ($null -ne $stage) { Remove-Tree $stage }
    }
}

# Detect, then install; an AVX2 build that dies with an illegal instruction falls back to
# the baseline build under its own lock (as Bun's own install.ps1 does).
function Install-Pinned($Pin, [string]$BunDir) {
    $wait = Get-LockWait
    $target = Get-InstallTarget
    $result = Install-Target $Pin $BunDir $target $wait
    if ($result -ceq 'illegal-instruction' -and $target -ceq 'windows-x64') {
        $target = 'windows-x64-baseline'
        $result = Install-Target $Pin $BunDir $target $wait
    }
    if ($result -ceq 'illegal-instruction') {
        Fail ('the Bun for ' + $target + ' does not run on this CPU (illegal instruction, STATUS_ILLEGAL_INSTRUCTION); nothing was published')
    }
    @{ target = $target; slot = [System.IO.Path]::Combine($BunDir, $Pin.version, $target) }
}

# --- run ---------------------------------------------------------------------------

# One command line from arguments, each quoted by the CommandLineToArgvW rules (the MSVC
# runtime parses alike): Windows PowerShell 5.1's .NET has only ProcessStartInfo.Arguments.
function ConvertTo-CommandLine([string[]]$Arguments) {
    $backslash = [char]92
    $quote = [char]34
    $line = New-Object System.Text.StringBuilder
    foreach ($argument in $Arguments) {
        if ($line.Length -gt 0) { $null = $line.Append([char]32) }
        if ($argument.Length -gt 0 -and $argument.IndexOfAny([char[]](9, 10, 11, 32, 34)) -lt 0) {
            $null = $line.Append($argument)
            continue
        }
        $null = $line.Append($quote)
        $slashes = 0
        foreach ($c in $argument.ToCharArray()) {
            if ($c -ceq $backslash) { $slashes++; continue }
            if ($c -ceq $quote) { $null = $line.Append($backslash, 2 * $slashes + 1) }
            elseif ($slashes -gt 0) { $null = $line.Append($backslash, $slashes) }
            $slashes = 0
            $null = $line.Append($c)
        }
        $null = $line.Append($backslash, 2 * $slashes).Append($quote)
    }
    $line.ToString()
}

function Close-Quietly($Stream) {
    try { $Stream.Dispose() } catch { }
}

# Bun with stdin and stdout as raw byte copies, never through PowerShell's pipeline or
# `&` (5.1 does not pass the end of stdin to a native program); stderr inherited.
# Returns Bun's exit code once Bun has ended and its stdout is copied; the host's stdin is
# not waited for (a host may keep it open).
function Invoke-Bun([string]$Exe, [string[]]$Arguments) {
    # .NET Framework writes the console input encoding's preamble into a redirected stdin;
    # with the UTF-8 code page that is a BOM in front of the hook's input.
    $inputEncoding = [Console]::InputEncoding
    if ($inputEncoding.CodePage -eq 65001 -and $inputEncoding.GetPreamble().Length -gt 0) {
        try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = ConvertTo-CommandLine $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    try { $child = [System.Diagnostics.Process]::Start($psi) }
    catch { Fail ('cannot start ' + $Exe + ': ' + (Get-Cause $_.Exception).Message) }

    $toChild = $child.StandardInput.BaseStream
    if ($toChild -is [System.IO.FileStream]) {
        # Process buffers its stdin FileStream (4096 bytes) and CopyToAsync never flushes:
        # write unbuffered, so input reaches Bun while the host keeps stdin open.
        $toChild = New-Object System.IO.FileStream($toChild.SafeFileHandle, [System.IO.FileAccess]::Write, 1)
    }
    $fromChild = $child.StandardOutput.BaseStream
    $stdout = [Console]::OpenStandardOutput()
    $inCopy = [Console]::OpenStandardInput().CopyToAsync($toChild)
    $outCopy = $fromChild.CopyToAsync($stdout)

    $inClosed = $false
    if ([System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($inCopy, $outCopy)) -eq 0) {
        Close-Quietly $toChild # end of input reaches Bun
        $inClosed = $true
    }
    while (-not $child.WaitForExit(100)) {
        if (-not $inClosed -and $inCopy.IsCompleted) {
            Close-Quietly $toChild
            $inClosed = $true
        }
        if ($outCopy.IsFaulted) { Close-Quietly $fromChild } # our stdout is gone: let Bun's writes fail
    }
    # Bun has ended: finish its stdout. The stdin copy is abandoned, never awaited; its
    # write to the dead child fails inside the task and is never observed.
    $null = [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($outCopy))
    try { $stdout.Flush() } catch { }
    $child.ExitCode
}

# --- main --------------------------------------------------------------------------

function Invoke-GettyBun([string]$ScriptPath, [string[]]$Argv) {
    $Argv = @($Argv)
    $command = ''
    if ($Argv.Count -gt 0) { $command = $Argv[0] }
    $usage = 'usage: getty-bun.ps1 run <entry> [args...] | ensure | status'
    if ($command -ceq 'run') {
        if ($Argv.Count -lt 2) { Fail 'usage: getty-bun.ps1 run <entry> [args...]' }
    } elseif ($command -ceq 'ensure' -or $command -ceq 'status') {
        if ($Argv.Count -ne 1) { Fail $usage }
    } else {
        Fail $usage
    }

    $gettyHome = Get-GettyHome
    $null = Get-LockWait
    Assert-Architecture
    $pin = Read-Pin $ScriptPath
    $bunDir = [System.IO.Path]::Combine($gettyHome, 'runtimes', 'bun')
    $found = Find-ReadySlot $bunDir $pin

    if ($command -ceq 'status') {
        if ($null -ne $found) {
            $target = $found.target
            $slot = $found.slot
            $state = 'ready'
        } else {
            $target = Get-InstallTarget
            $null = Get-PinTarget $pin $target
            $slot = [System.IO.Path]::Combine($bunDir, $pin.version, $target)
            $state = Get-SlotState $slot $pin.version $target
        }
        Write-Bytes ([Console]::OpenStandardOutput()) ('{"pin":' + (ConvertTo-JsonString $pin.version) + ',"target":' + (ConvertTo-JsonString $target) +
            ',"slot":' + (ConvertTo-JsonString $slot) + ',"state":' + (ConvertTo-JsonString $state) + '}')
        return 0
    }
    if ($null -eq $found) { $found = Install-Pinned $pin $bunDir }
    if ($command -ceq 'ensure') { return 0 }

    # run: the consumer root is the parent of this starter's directory, never the cwd.
    $root = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($ScriptPath))
    $entry = $root + [System.IO.Path]::DirectorySeparatorChar + $Argv[1].Replace([char]'/', [System.IO.Path]::DirectorySeparatorChar)
    $rest = @()
    if ($Argv.Count -gt 2) { $rest = $Argv[2..($Argv.Count - 1)] }
    $exe = [System.IO.Path]::Combine($found.slot, 'bin', 'bun.exe')
    Invoke-Bun $exe (@('--no-install', $entry) + $rest)
}

$exitCode = 1
try {
    $result = @(Invoke-GettyBun $PSCommandPath $args)
    if ($result.Count -ne 1 -or $result[0] -isnot [int]) { Fail ('internal error: ' + $result.Count + ' values instead of one exit code') }
    $exitCode = $result[0]
} catch {
    $cause = Get-Cause $_.Exception
    $message = $cause.Message
    if (-not $cause.Data.Contains('getty-bun')) { $message = 'unexpected error at line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + $message }
    try { Write-Bytes ([Console]::OpenStandardError()) ('getty-bun: ' + $message.Replace("`r", ' ').Replace("`n", ' ')) } catch { }
    $exitCode = 1
}
exit $exitCode
