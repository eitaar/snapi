param()

$ErrorActionPreference = 'Stop'

$FixedOrigin = 'https://web.snapchat.com'
$FixedVersionUrl = 'https://web.snapchat.com/web/version.json?version=8dd50222'
$DefaultEndpointPath = '/messagingcoreservice.MessagingCoreService/DeltaSync'
$AllowedReadUrls = @(
    'https://web.snapchat.com/messagingcoreservice.MessagingCoreService/DeltaSync',
    'https://web.snapchat.com/messagingcoreservice.MessagingCoreService/BatchDeltaSync',
    'https://web.snapchat.com/messagingcoreservice.MessagingCoreService/GetGroups'
)
$AllowedCapturedHeaderNames = @(
    'authorization',
    'cookie',
    'x-snapchat-client',
    'x-snapchat-user-agent',
    'x-user-agent'
)
$StaticHeaders = [ordered]@{
    'accept' = 'application/grpc-web+proto'
    'content-type' = 'application/grpc-web+proto'
    'x-grpc-web' = '1'
}

function Write-SanitizedResult {
    param(
        [AllowNull()][string]$ResultAuthEpoch,
        [string]$EndpointPath,
        [AllowNull()][Nullable[int]]$Status,
        [AllowNull()][Nullable[int]]$RequestBodyBytes,
        [AllowNull()][string]$RequestBodySha256,
        [string[]]$SafeHeaderNames,
        [AllowNull()][string]$TransportError
    )

    $result = [ordered]@{
        authEpoch = $ResultAuthEpoch
        context = 'dotnet-http3'
        operation = 'messaging-read'
        endpointPath = $EndpointPath
        status = $Status
        protocol = 'h3'
        requestBodyBytes = $RequestBodyBytes
        requestBodySha256 = $RequestBodySha256
        safeHeaderNames = @($SafeHeaderNames | Sort-Object -Unique)
        transportError = $TransportError
    }

    $result | ConvertTo-Json -Compress
}

function Exit-SanitizedFailure {
    param(
        [AllowNull()][string]$ResultAuthEpoch,
        [string]$EndpointPath,
        [AllowNull()][Nullable[int]]$Status,
        [AllowNull()][Nullable[int]]$RequestBodyBytes,
        [AllowNull()][string]$RequestBodySha256,
        [string[]]$SafeHeaderNames,
        [string]$Category
    )

    Write-SanitizedResult `
        -ResultAuthEpoch $ResultAuthEpoch `
        -EndpointPath $EndpointPath `
        -Status $Status `
        -RequestBodyBytes $RequestBodyBytes `
        -RequestBodySha256 $RequestBodySha256 `
        -SafeHeaderNames $SafeHeaderNames `
        -TransportError $Category
    exit 1
}

$resultAuthEpoch = $null
$endpointPath = $DefaultEndpointPath
$requestBodyBytes = $null
$requestBodySha256 = $null
$safeHeaderNames = @()

$harPath = $null
$authEpoch = $null
$seenHarPath = $false
$seenAuthEpoch = $false
$hasExpectedArgumentCount = $args.Count -eq 4
$invalidArguments = -not $hasExpectedArgumentCount

if (-not $invalidArguments) {
    for ($index = 0; $index -lt $args.Count; $index += 2) {
        $option = [string]$args[$index]
        $value = [string]$args[$index + 1]

        if ($option -notin @('-HarPath', '-AuthEpoch') -or
            [string]::IsNullOrEmpty($value) -or
            $value.StartsWith('-')) {
            $invalidArguments = $true
            break
        }

        if ($option -eq '-HarPath') {
            if ($seenHarPath) {
                $invalidArguments = $true
                break
            }
            $harPath = $value
            $seenHarPath = $true
        }
        else {
            if ($seenAuthEpoch) {
                $invalidArguments = $true
                break
            }
            $authEpoch = $value
            $seenAuthEpoch = $true
        }
    }
}

if ($invalidArguments -or -not $seenHarPath -or -not $seenAuthEpoch) {
    Exit-SanitizedFailure -ResultAuthEpoch $null -EndpointPath $endpointPath -Status $null -RequestBodyBytes $null -RequestBodySha256 $null -SafeHeaderNames $safeHeaderNames -Category 'invalid-input'
}

$HarPath = $harPath
$AuthEpoch = $authEpoch

if ([string]::IsNullOrWhiteSpace($AuthEpoch) -or
    $AuthEpoch.Length -gt 64 -or
    $AuthEpoch -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    Exit-SanitizedFailure -ResultAuthEpoch $null -EndpointPath $endpointPath -Status $null -RequestBodyBytes $null -RequestBodySha256 $null -SafeHeaderNames $safeHeaderNames -Category 'invalid-input'
}
$resultAuthEpoch = $AuthEpoch

if ([string]::IsNullOrWhiteSpace($HarPath)) {
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $null -RequestBodyBytes $null -RequestBodySha256 $null -SafeHeaderNames $safeHeaderNames -Category 'invalid-input'
}

try {
    $har = [System.Text.Json.JsonDocument]::Parse([System.IO.File]::ReadAllText($HarPath))
}
catch {
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $null -RequestBodyBytes $null -RequestBodySha256 $null -SafeHeaderNames $safeHeaderNames -Category 'invalid-har'
}

try {
    $entries = $har.RootElement.GetProperty('log').GetProperty('entries')
    $selectedEntry = $null
    $selectedStartedAt = $null

    foreach ($entry in $entries.EnumerateArray()) {
        $request = $entry.GetProperty('request')
        $response = $entry.GetProperty('response')
        $method = $request.GetProperty('method').GetString()
        $url = $request.GetProperty('url').GetString()
        $status = $response.GetProperty('status').GetInt32()

        if ($method -ne 'POST' -or $status -ne 200 -or $url -notin $AllowedReadUrls) {
            continue
        }

        try {
            $postData = $request.GetProperty('postData')
            $bodyTextElement = $postData.GetProperty('text')
        }
        catch {
            continue
        }
        if ($bodyTextElement.ValueKind -ne [System.Text.Json.JsonValueKind]::String) {
            continue
        }

        $startedAt = $null
        try {
            $startedAtText = $entry.GetProperty('startedDateTime').GetString()
            $parsedStartedAt = [DateTimeOffset]::MinValue
            if ([DateTimeOffset]::TryParse($startedAtText, [ref]$parsedStartedAt)) {
                $startedAt = $parsedStartedAt
            }
        }
        catch {}

        if ($null -eq $selectedEntry -or
            (($null -ne $startedAt) -and (($null -eq $selectedStartedAt) -or $startedAt -ge $selectedStartedAt)) -or
            (($null -eq $startedAt) -and ($null -eq $selectedStartedAt))) {
            $selectedEntry = $entry
            $selectedStartedAt = $startedAt
        }
    }
}
catch {
    $har.Dispose()
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $null -RequestBodyBytes $null -RequestBodySha256 $null -SafeHeaderNames $safeHeaderNames -Category 'invalid-har'
}

if ($null -eq $selectedEntry) {
    $har.Dispose()
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $null -RequestBodyBytes $null -RequestBodySha256 $null -SafeHeaderNames $safeHeaderNames -Category 'no-allowed-request'
}

try {
    $selectedRequest = $selectedEntry.GetProperty('request')
    $selectedUrl = $selectedRequest.GetProperty('url').GetString()
    $endpointPath = ([Uri]$selectedUrl).AbsolutePath
    $selectedPostData = $selectedRequest.GetProperty('postData')
    $bodyText = $selectedPostData.GetProperty('text').GetString()
    $encoding = ''
    try {
        $encoding = $selectedPostData.GetProperty('encoding').GetString()
    }
    catch {}

    if ($encoding -eq 'base64') {
        $requestBodyBytes = [Convert]::FromBase64String($bodyText)
    }
    elseif ([string]::IsNullOrEmpty($encoding) -or $encoding -in @('utf8', 'utf-8')) {
        $requestBodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyText)
    }
    else {
        throw [InvalidOperationException]::new('unsupported HAR body encoding')
    }

    $requestBodySha256 = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($requestBodyBytes)).ToLowerInvariant()
    $forwardedHeaders = @{}
    foreach ($header in $selectedRequest.GetProperty('headers').EnumerateArray()) {
        $headerName = $header.GetProperty('name').GetString().ToLowerInvariant()
        if ($headerName -in $AllowedCapturedHeaderNames) {
            $forwardedHeaders[$headerName] = $header.GetProperty('value').GetString()
        }
    }

    if ([string]::IsNullOrEmpty($forwardedHeaders['authorization']) -or
        [string]::IsNullOrEmpty($forwardedHeaders['cookie'])) {
        throw [InvalidOperationException]::new('missing authenticated headers')
    }
    $safeHeaderNames = @($forwardedHeaders.Keys) + @($StaticHeaders.Keys)
}
catch {
    $har.Dispose()
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $null -RequestBodyBytes $requestBodyBytes.Length -RequestBodySha256 $requestBodySha256 -SafeHeaderNames $safeHeaderNames -Category 'request-construction-failed'
}

$har.Dispose()

try {
    $handler = [System.Net.Http.SocketsHttpHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.DefaultRequestVersion = [Version]::new(3,0)
    $client.DefaultVersionPolicy = [System.Net.Http.HttpVersionPolicy]::RequestVersionExact

    $versionRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $FixedVersionUrl)
    $versionResponse = $client.Send($versionRequest)
    $versionSucceeded = $versionResponse.IsSuccessStatusCode
    $versionResponse.Dispose()
    $versionRequest.Dispose()
    if (-not $versionSucceeded) {
        $client.Dispose()
        $handler.Dispose()
        Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $null -RequestBodyBytes $requestBodyBytes.Length -RequestBodySha256 $requestBodySha256 -SafeHeaderNames $safeHeaderNames -Category 'build-validation-failed'
    }

    $message = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$FixedOrigin$endpointPath")
    $content = [System.Net.Http.ByteArrayContent]::new($requestBodyBytes)
    $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($StaticHeaders['content-type'])
    $message.Content = $content
    foreach ($headerName in $forwardedHeaders.Keys) {
        if (-not $message.Headers.TryAddWithoutValidation($headerName, $forwardedHeaders[$headerName])) {
            throw [InvalidOperationException]::new('header rejected')
        }
    }
    foreach ($staticHeaderName in $StaticHeaders.Keys) {
        if ($staticHeaderName -eq 'content-type') {
            continue
        }
        if (-not $message.Headers.TryAddWithoutValidation($staticHeaderName, $StaticHeaders[$staticHeaderName])) {
            throw [InvalidOperationException]::new('static header rejected')
        }
    }

    $response = $client.Send($message)
    $postStatus = [int]$response.StatusCode
    $isHttp3 = $response.Version.Major -eq 3
    $response.Dispose()
    $message.Dispose()
    $client.Dispose()
    $handler.Dispose()
}
catch {
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $null -RequestBodyBytes $requestBodyBytes.Length -RequestBodySha256 $requestBodySha256 -SafeHeaderNames $safeHeaderNames -Category 'transport-failed'
}

if (-not $isHttp3) {
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $postStatus -RequestBodyBytes $requestBodyBytes.Length -RequestBodySha256 $requestBodySha256 -SafeHeaderNames $safeHeaderNames -Category 'protocol-mismatch'
}

if ($postStatus -eq 429) {
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $postStatus -RequestBodyBytes $requestBodyBytes.Length -RequestBodySha256 $requestBodySha256 -SafeHeaderNames $safeHeaderNames -Category 'http-status'
}

if ($postStatus -lt 200 -or $postStatus -ge 300) {
    Exit-SanitizedFailure -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $postStatus -RequestBodyBytes $requestBodyBytes.Length -RequestBodySha256 $requestBodySha256 -SafeHeaderNames $safeHeaderNames -Category 'http-status'
}

Write-SanitizedResult -ResultAuthEpoch $resultAuthEpoch -EndpointPath $endpointPath -Status $postStatus -RequestBodyBytes $requestBodyBytes.Length -RequestBodySha256 $requestBodySha256 -SafeHeaderNames $safeHeaderNames -TransportError $null
