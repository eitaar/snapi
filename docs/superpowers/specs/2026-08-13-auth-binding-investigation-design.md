# Snapchat Web Auth Binding Investigation Design

## 目的

build `8dd50222` において、Braveでは成功するGateway接続とread-only Messaging同期が、同じ認証値を使うNode/.NETクライアントではHTTP `401`になる条件を、一変数ずつ比較して最小のバインディング単位まで特定する。

この調査は、認証を回避する方法を探すものではない。CLI単体実装が成立する条件を特定し、成立しない場合はサーバー側で要求されるブラウザ境界を証拠付きで確定する。

## 現在確認できている事実

`private/fresh7.har` には、同じlogin epoch内で次の成功が含まれている。

- BraveのGateway UpgradeはHTTP `101`で、選択subprotocolは`snap-ws-auth`である。
- BraveのMessagingCoreService `BatchDeltaSync`と`DeltaSync`はHTTP `200`である。
- Gatewayと15件のMessaging POSTは同じ292文字の認証値を使用している。
- GatewayリクエストにはCookieとAuthorizationがなく、Originは`https://www.snapchat.com`である。
- MessagingリクエストにはAuthorizationがあり、Cookieはない。
- BraveのMessaging成功リクエストはHTTP/3 (`h3`) である。

同じepochの認証値とHAR本文を使った直後の比較では、次が確認されている。

- Node HTTPSによるGateway UpgradeはHTTP `401`。
- Node WebSocketは接続エラー。
- Windows `ClientWebSocket`も認証またはhandshake段階で失敗。
- Node FetchとNode HTTP/2によるread-only Messaging replayはHTTP `401`。
- .NET 9 HttpClientのHTTP/3による同じread-only Messaging replayもHTTP `401`。

したがって、HTTP/3対応の有無だけでは差を説明できない。また、Browser成功と非Browser失敗だけから、TLS fingerprint、QUIC connection、browser profile、bootstrap state、server-side attestationのどれか一つに断定することもできない。

## 調査で答える質問

調査は次の順序で、前段の結果から不要になった後段を省略する。

1. 認証値は一回限り、または短時間限りか。
2. 認証値は成功した特定のWebSocket/TLS/QUIC connection instanceに固定されるか。
3. 認証値は特定のBrave processまたはbrowser profileに固定されるか。
4. HTTP/3/QUICそのものが必要か。
5. HTTPバージョンを揃えても残るTLS/client implementation差が必要か。
6. 公式Worker、page principal、Network Isolation Key、先行bootstrap順序のどれかが必要か。
7. クライアントから観測できないserver-side attestationまたは登録状態までしか絞れないか。

## 採用する方法

### 同一epoch内のpaired causal matrix

各実験は、同じauth epoch、同じendpoint、同じrequest body length、同じbody SHA-256を比較する。一度に変える要素は一つだけとし、複数条件が変わった結果を因果判定に使用しない。

基準となるepochでは、Braveが自然に生成したGateway `101`とread-only Messaging `200`を最初に確認する。その直後に非Browser probeを一回ずつ実行し、最後にBrave側の新規接続またはreplayを確認する。最初と最後のBrowser成功でprobe期間を挟むことで、単なるtoken expirationを他の失敗と混同しない。

### Browser側の比較

Browser側では、通常のログイン済みBraveと公式Web Workerを基準にする。ユーザーによる通常ログインは許可するが、自動ログイン、OTP、CAPTCHA、device approvalは行わない。

比較は次の順序で行う。

1. 同じpage lifetime内で、自然なread-only同期が再度成功するか確認する。
2. page reload後に、connection IDが変わったGateway `101`とMessaging `200`が成立するか確認する。
3. Braveを完全終了して同じprofileで再起動し、認証値の一致真偽と新規接続の成功を確認する。
4. 別epochとして、Braveを`--disable-quic`で起動し、手動ログイン後の自然なMessaging通信がh2で成功するか確認する。
5. 必要な場合のみ、ログイン済みpage内からallowlisted read-only requestを一回replayする。

reloadやprocess restartで認証値が変化した場合、その比較からconnection bindingを断定しない。記録するのは認証値の一致真偽だけで、値やhashは出力しない。

### 非Browser側の比較

非Browser probeは同じWindows host、同じ通常network routeから実行する。対象はallowlisted read-only Messaging RPCとGateway handshakeだけである。

- Node Fetch HTTP/1.1
- Node `http2` HTTP/2
- .NET 9 HttpClient HTTP/3
- Node HTTPS Gateway Upgrade
- Windows `ClientWebSocket` Gateway handshake

同じhostからBrowserは成功し非Browserは失敗するため、proxy、VPN、address family、network interfaceの一致をbooleanで確認できればpublic IPだけへのbindingは除外できる。HTTP/3同士でもBrave成功・.NET失敗なら、HTTP/3 requirementだけでは説明できない。

### Browser subcontextとbootstrapの比較

transportを揃えてもBrowserだけが成功する場合、次にexecution principalを調べる。

- 公式Web Workerが自然に送ったread-only request
- 同じlogin epochでpageから一回だけ送るread-only replay
- reload後に公式Web Workerが自然に送るread-only request
- それぞれに先行したSSO、session bootstrap、Messaging initializationの順序

page replayが失敗しても、直ちにWorker bindingとは判定しない。body freshnessまたはsingle-use fieldでも同じ結果になるため、同じepoch内の二つの自然成功requestについてbody length、full SHA-256、header-name setの一致を確認する。

公式Worker contextでのreplayが必要になった場合のみ、Braveのremote debuggingをユーザーが明示的に有効にし、既存Worker targetへ接続する。接続できない場合は`browser-subcontext-or-freshness`で停止し、CDP制限を回避しない。

先行APIをblockするperturbation testは初期調査に含めない。受動観測で候補が一つに絞れた後、追加のユーザー承認を得た一つのread-only候補に限って実施する。

## 証拠モデル

すべてのprobeは、次のsanitized observationだけを生成する。

```ts
type AuthBindingContext =
  | "brave-natural"
  | "brave-reload"
  | "brave-restart"
  | "brave-h2-natural"
  | "brave-page-replay"
  | "brave-worker-replay"
  | "node-http1"
  | "node-http2"
  | "dotnet-http3"
  | "node-gateway"
  | "dotnet-gateway";

interface SafeAuthBindingObservation {
  readonly authEpoch: string;
  readonly context: AuthBindingContext;
  readonly endpointPath: string;
  readonly operation: "messaging-read" | "gateway-handshake";
  readonly startedAt: string;
  readonly status?: number;
  readonly protocol?: "http/1.1" | "h2" | "h3" | "websocket";
  readonly requestBodyBytes?: number;
  readonly requestBodySha256?: string;
  readonly safeHeaderNames: readonly string[];
  readonly tokenEqualsEpochBaseline: boolean;
  readonly connectionEqualsPrevious?: boolean;
  readonly browserProcessEqualsPrevious?: boolean;
  readonly networkRouteEqualsBaseline?: boolean;
  readonly bootstrapStage?: string;
  readonly transportError?: "timeout" | "connection" | "tls" | "other";
}

type AuthBindingConclusion =
  | "token-freshness-bound"
  | "connection-instance-bound"
  | "browser-process-or-profile-bound"
  | "http3-quic-bound"
  | "tls-client-bound"
  | "browser-principal-bound"
  | "bootstrap-sequence-bound"
  | "server-side-browser-binding"
  | "insufficient-evidence";
```

connection ID、browser process ID、remote address、token、Cookie、request/response bodyは記録しない。比較結果はbooleanへ変換してから通常出力へ渡す。raw HAR、NetLog、CDP event、session exportは`private/`の外へ出さない。

## 判定モデル

classifierは、比較可能なobservationsから次の狭い結論だけを返す。

### `token-freshness-bound`

Browser originalは成功し、同じBrowser execution contextで同一requestを直後にreplayすると失敗する。自然成功request間でもbodyまたはtokenが変化する。single-use body fieldとtoken freshnessは別証拠が得られるまで統合カテゴリとして扱う。

### `connection-instance-bound`

同じtokenが既存connectionでは成功し、connection IDが変わった同一Browser processの自然な再接続では失敗する。tokenが変わった場合、この判定はしない。

### `browser-process-or-profile-bound`

同じtokenが同じprocess内の新規connectionでは成功するが、同じprofileのprocess restart後に失敗する。TLS session resumptionを排除できない場合、profileとTLS sessionを分離して断定しない。

### `http3-quic-bound`

同一Browser implementationの通常h3 epochは成功し、`--disable-quic`で取得したh2 epochは自然な公式通信でも失敗する。異なるtoken epochを直接比較せず、各epoch内のBrowser baselineを使う。

### `tls-client-bound`

Brave h2の自然な公式通信または同一page replayが成功し、同じepoch・同じbodyのNode h2が失敗する。これはHTTP/3 requirementを除外するが、TLS fingerprintとbrowser principalはまだ統合カテゴリである。

### `browser-principal-bound`

同じBrowser process・同じnetwork routeで、公式Worker内の同一request replayは成功し、page replayだけが失敗する。Worker targetへ安全に接続できずWorker replayを実行できない場合、この判定はせず`insufficient-evidence`にする。Worker principal、Network Isolation Key、browser-managed client signalは、追加証拠なしに個別断定しない。

### `bootstrap-sequence-bound`

同じBrowser contextとtransportで、自然なbootstrap完了後だけ成功し、未完了状態だけ失敗する。先行candidateを一つだけ変えたperturbation testで再現するまで判定しない。

### `server-side-browser-binding`

Browserの新規connectionとreplayは繰り返し成功し、同じhost・protocol・token・bodyの非Browser clientだけが失敗するが、clientから観測可能な差ではこれ以上分離できない。これはattestation、TLS client identity、server-side registrationのいずれかを含む上限カテゴリであり、具体的な秘密や検証方式を推測しない。

### `insufficient-evidence`

auth epoch、body hash、token equality、Browser baselineのいずれかが揃わない場合、またはtransport errorしか得られない場合に返す。

## 実験順序と停止条件

1. fresh Browser baselineを取得する。
2. 同一epochで既存のNode/.NET one-shot probeを実行する。
3. Browser reloadとprocess restartでnew-connection behaviorを確認する。
4. 同一Browser内のread-only replayでfreshnessを確認する。
5. 別のBrave h2 epochでprotocol requirementを確認する。
6. 必要な場合のみWorker targetとbootstrap順序を調査する。
7. classifierが一つの結論を返すか、観測限界に達した時点で終了する。

各modeは一epochにつき一回だけ実行し、自動retryしない。HTTP `429`、account warning、login challenge、予期しないwrite endpoint、または送信系RPCを検出した場合は、全live probeを直ちに停止する。

## セキュリティ境界

- operator-controlled account以外を使用しない。
- Chat、Snap、typing notification、既読、open/replay notificationを送らない。
- allowlistは`DeltaSync`、`BatchDeltaSync`、`GetGroups`とGateway handshakeに限定する。
- Bearer、Cookie、Gateway token、attestation、key material、raw protobuf、raw response bodyを表示・通常ログ保存・commitしない。
- token hash、token prefix、token suffixも出力しない。比較は同値booleanだけにする。
- TLS key log、session secret、QUIC key、DBSC key、App-Bound Cookie復号鍵を収集しない。
- TLS/QUIC fingerprint spoofing、attestation bypass、browser security control bypassを行わない。
- Brave remote debuggingは既存のログイン済みtargetを観測する用途だけに限定し、login automationやcredential extractionに使わない。
- raw captureはignored `private/`に置き、sanitized observationだけをtracked docsへ記録する。

## 実装境界

診断実装はproduction Chat/Snap send pathを変更しない。追加するのは安全なevidence type、HAR metadata analyzer、one-shot probe adapter、classifier、CLI debug command、tests、および調査結果文書だけである。

GatewayやMessaging transportの修正は、この調査のclassifierが直接Nodeで成立する条件を一つに確定した後、別の実装planで行う。`server-side-browser-binding`に到達した場合、CLI単体の直接transportを成功したものとして扱わない。

## 代替案と採否

### Passive capture only

最も安全だが、Browser成功とNode失敗の相関しか増えず、connection、protocol、principalの因果分離ができないため採用しない。

### Browser impersonation first

TLS fingerprintやheader orderを先に模倣する方法は、どの条件が必要か判定できず、セキュリティ制御回避にも近づくため採用しない。

### Paired causal matrix

同一epochの前後にBrowser成功を置き、一変数ずつ変える。最少のlive request数で、token freshness、connection、protocol、client、principalを順に分離できるため採用する。

## 完了条件

- fresh Browser成功を挟んだ比較可能なsanitized observationsが揃う。
- Gatewayとread-only Messagingを別々に分類する。
- public IP only、HTTP/3 only、token one-timeなど、否定できた仮説を証拠とともに明記する。
- classifierが定義済みの結論を一つ返すか、`insufficient-evidence`となる欠落証拠を一つに特定する。
- raw credentialsやpayloadがsource、test fixture、console、Git historyに入らない。
- 調査結果から直接transport修正が可能か、browser boundaryが必須かを明示する。
