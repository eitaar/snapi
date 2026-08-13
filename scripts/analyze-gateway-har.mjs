import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const GATEWAY_PATH = "/snapchat.gateway.Gateway/WebSocketConnect";

function isRecord(value) {
  return value !== null && typeof value === "object";
}

function bytesFromBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(value)) return undefined;
  try {
    const bytes = Uint8Array.from(Buffer.from(value, "base64"));
    return bytes.length === 0 && value.length > 0 ? undefined : bytes;
  } catch {
    return undefined;
  }
}

function readVarint(bytes, offset) {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length && shift <= 49; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: index + 1 };
    shift += 7;
  }
  return undefined;
}

function fields(bytes) {
  const result = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (tag === undefined) return undefined;
    offset = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (fieldNumber < 1) return undefined;
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      if (value === undefined) return undefined;
      result.push({ fieldNumber, wireType });
      offset = value.next;
      continue;
    }
    if (wireType !== 2) return undefined;
    const length = readVarint(bytes, offset);
    if (length === undefined || length.value > bytes.length - length.next) return undefined;
    result.push({ fieldNumber, wireType, value: bytes.slice(length.next, length.next + length.value) });
    offset = length.next + length.value;
  }
  return result;
}

function grpcFrames(bytes) {
  const result = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 5) return undefined;
    const flag = bytes[offset];
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
    const start = offset + 5;
    const end = start + length;
    if (end > bytes.length) return undefined;
    result.push({ flag, payload: bytes.slice(start, end) });
    offset = end;
  }
  return result;
}

function utf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function gatewayPath(payload) {
  const parsed = fields(payload);
  if (parsed === undefined) return undefined;
  const path = parsed.filter((field) => field.fieldNumber === 1 && field.wireType === 2)
    .map((field) => utf8(field.value))
    .find((value) => value !== undefined && value.length > 0);
  const contents = parsed.filter((field) => field.fieldNumber === 2 && field.wireType === 2);
  return path !== undefined && contents.length > 0 ? path : undefined;
}

function frameDescriptor(message) {
  const decoded = bytesFromBase64(message?.data);
  const descriptor = {
    direction: message?.type === "receive" ? "receive" : "send",
    opcode: typeof message?.opcode === "number" ? message.opcode : undefined,
    encodedLength: typeof message?.data === "string" ? message.data.length : 0,
    decodedLength: decoded?.length ?? undefined,
    grpcKinds: [],
    gatewayPaths: [],
  };
  if (decoded === undefined) return descriptor;
  const frames = grpcFrames(decoded);
  if (frames === undefined) return descriptor;
  for (const frame of frames) {
    if (frame.flag === 0x00) {
      descriptor.grpcKinds.push("data");
      const path = gatewayPath(frame.payload);
      if (path !== undefined) descriptor.gatewayPaths.push(path);
    } else if (frame.flag === 0x80) {
      descriptor.grpcKinds.push("trailers");
    } else {
      descriptor.grpcKinds.push("unknown");
    }
  }
  return descriptor;
}

function headerValue(headers, wanted) {
  const header = (Array.isArray(headers) ? headers : []).find((candidate) =>
    isRecord(candidate) && String(candidate.name ?? "").toLowerCase() === wanted,
  );
  return isRecord(header) ? String(header.value ?? "") : undefined;
}

function safePath(url) {
  try { return new URL(String(url)).pathname; } catch { return undefined; }
}

function pathSequence(entries) {
  return entries.flatMap((entry) => {
    const request = isRecord(entry?.request) ? entry.request : {};
    const path = safePath(request.url);
    const method = String(request.method ?? "").toUpperCase();
    const status = isRecord(entry?.response) ? entry.response.status : undefined;
    return path !== undefined && method !== "" && typeof status === "number"
      ? [`${method} ${path} ${status}`]
      : [];
  });
}

export function analyzeGatewayHar(har) {
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const gatewayHandshakes = entries.flatMap((entry) => {
    const request = isRecord(entry?.request) ? entry.request : {};
    const response = isRecord(entry?.response) ? entry.response : {};
    const path = safePath(request.url);
    if (path !== GATEWAY_PATH) return [];
    const selectedProtocol = headerValue(response.headers, "sec-websocket-protocol");
    const protocol = selectedProtocol === "snap-ws-auth" ? "snap-ws-auth" : selectedProtocol === undefined ? "none" : "other";
    const status = typeof response.status === "number" ? response.status : 0;
    const classification = status === 101 && protocol === "snap-ws-auth"
      ? "open"
      : status === 401 || status === 403 ? "authorization-rejected"
        : status === 429 ? "rate-limited" : "unexpected-status";
    const messages = Array.isArray(entry?._webSocketMessages) ? entry._webSocketMessages : [];
    return [{
      startedDateTime: typeof entry.startedDateTime === "string" ? entry.startedDateTime : undefined,
      status,
      classification,
      protocol,
      requestHeaderNames: (Array.isArray(request.headers) ? request.headers : []).map((header) => String(header?.name ?? "").toLowerCase()).sort(),
      responseHeaderNames: (Array.isArray(response.headers) ? response.headers : []).map((header) => String(header?.name ?? "").toLowerCase()).sort(),
      websocketMessageCount: messages.length,
      frameDescriptors: messages.map(frameDescriptor),
    }];
  });
  return { gatewayHandshakes, pathSequence: pathSequence(entries) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (file === undefined) {
    console.error("Usage: node scripts/analyze-gateway-har.mjs <har-file>");
    process.exitCode = 2;
  } else {
    const har = JSON.parse(await readFile(file, "utf8"));
    process.stdout.write(`${JSON.stringify(analyzeGatewayHar(har), null, 2)}\n`);
  }
}
