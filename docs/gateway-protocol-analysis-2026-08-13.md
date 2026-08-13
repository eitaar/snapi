# Snapchat Gateway プロトコル解析メモ（build `8dd50222`）

## 結論

GatewayのトランスポートはWebSocketである。手元の成功HARでは、次のUpgradeが成立している。

```text
GET wss://aws.duplex.snapchat.com/snapchat.gateway.Gateway/WebSocketConnect
→ 101 Switching Protocols
→ selected subprotocol: snap-ws-auth
```

ただし、WebSocketが「普通のJSONソケット」という意味ではない。成功HARと既存実装から、WebSocket上にgRPC-Web形式のバイナリフレームを置き、そのdata payloadにGateway独自のprotobuf envelopeを置く構造までは確認できる。

```text
WebSocket binary message
  └─ gRPC-Web frame: 1 byte flag + 4 byte big-endian length + payload
       └─ GatewayEnvelope protobuf
            ├─ field 1: path
            └─ field 2: messageContents
```

これは「フレームの外側」と「Envelopeのフィールド構造」についての結論である。`messageContents` の保護された本文、認証値、鍵、署名、メディア本文はこの資料に含めない。

## 直接観測できたこと

解析対象は `private/` にあるローカルHARで、値ではなくメタデータだけを抽出した。

| 対象 | 観測結果 |
|---|---|
| 接続先 | `aws.duplex.snapchat.com` の `snapchat.gateway.Gateway/WebSocketConnect` |
| Upgrade | 成功HARでHTTP `101` |
| 選択プロトコル | `snap-ws-auth` |
| 接続要求のOrigin | `https://www.snapchat.com` |
| WebSocket opcode | 成功HARの記録はbinary (`2`) |
| HAR上の表現 | WebSocket message dataはBase64文字列として保存 |
| 外側フレーム | gRPC-Web data frameとして整合する長さ/flag |
| Gateway path例 | `mcs`、`sync_trigger`、`http://pcs.snap/send-transient-message` |
| 既知RPC | `MessagingCoreService`、メディア送信では`GetUploadLocations`と`CreateContentMessage` |

成功HARごとの安全な要約は、次のコマンドで再生成できる。

```powershell
node scripts/analyze-gateway-har.mjs private/snap-login.har
```

解析器はヘッダー値、WebSocket本文、フレーム本文、Cookie、Bearer、署名URL、鍵、画像データを出力しない。

## 接続後の役割分担

Gatewayは主に双方向イベント経路で、Snap送信そのものの最終RPCではない。

```text
Gateway WebSocket
  → mcs / pcs 等のイベント・状態通知

Photo Snap send
  → 公式ランタイムでContentEnvelope生成
  → MediaDeliveryService/GetUploadLocations
  → 暗号化メディアをCDNへPUT
  → MessagingCoreService/CreateContentMessage
```

手元の `snap-sessio.har` では、画像Snapに対応する `GetUploadLocations 200` と `CreateContentMessage 200` が確認できる。したがって、Gateway `101` とSnap送信成功は関連するが、同一の最終送信処理ではない。

## 現在のCLI実装との照合

既存CLIは以下を実装している。

- `src/gateway/client.ts`: WebSocket接続、`snap-ws-auth` subprotocol、Origin、binary frame受信、再接続
- `src/wire/grpc-web.ts`: gRPC-Web外側フレームのencode/decode
- `src/wire/gateway-envelope.ts`: `path` と `messageContents` のprotobuf envelope
- `src/gateway/classifier.ts`: `mcs`、`pcs`、既知のSnapイベント分岐
- `src/runtime/official-websocket.ts`: 公式ランタイムがNodeでWebSocketを作れるようOriginを補う互換層
- `src/gateway/handshake.ts`: 認証値を出さずにUpgrade結果を分類する診断

このため、Gatewayの基本的な「接続してbinary envelopeを読む」部分は、コード上すでに存在する。現在の失敗はプロトコル未実装ではなく、接続前にAuthProviderのSSO更新が `303 /v2/login` で拒否されることが主因である。

## 推測と未解明点

### 高信頼の推測

- `sync_trigger` は同期開始を促す制御イベントとみられる。
- `mcs` はMessaging Core状態/イベントの経路とみられる。
- `http://pcs.snap/send-transient-message` は一時的なGateway経路とみられる。

### 未解明

- `messageContents` 内部の保護されたContentEnvelope仕様
- 接続時subprotocolの認証値生成・有効期限・サーバー側バインディング
- Gatewayの全path一覧と各pathのprotobuf schema
- 受信イベントとgRPC同期処理の完全な因果関係
- 再接続時に必要なサーバー状態、順序番号、再同期条件

これらは手元のフレーム長・path名・既存の公開境界だけでは確定できない。認証回避や秘密鍵抽出、キャプチャ済み認証フレームの再送で埋めるべき項目ではない。

## 実装上の判断

現時点で、Gatewayの外側プロトコルを推測で書き換える必要はない。既存の実装は、成功HARで確認したUpgrade・binary・gRPC-Web・Envelopeの境界と一致している。次に必要なのはプロトコル変更ではなく、管理された新しいログインHARで認証状態を更新し、Gateway `101` とread-only同期が再び成立するかを確認することだ。

