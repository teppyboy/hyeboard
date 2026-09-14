import {
  decryptVnuCrossDetailPermitEnvelope,
  encryptVnuCrossDetailPermitEnvelope,
  HyeboardError,
  type VnuCrossDetailPermitEnvelope,
} from "@hyeboard/core";
import {
  VNU_CROSS_DETAIL_POLICY_VERSION,
  type VnuCrossDetailConsumeInput,
  type VnuCrossDetailIssuedPermit,
} from "./vnu-probe-budget";

// ─── VNU cross-student grade detail ────────────────────────────────────────
// Permit-gated access to detailPoint.asp for ANOTHER student's course rows.
// A permit is minted only after a validated cross-transcript fetch: the
// upstream selector (target stdId/classId/termOrdinal) is sealed inside a
// server-encrypted envelope, and the Durable Object stores only keyed HMAC
// bindings (requester bearer, target, transcript revision, row identity).
// Consumption is single-use and exact-match: the client can only ever replay
// the permit verbatim — never redirect it at another row, target, or session.

export type VnuCrossDetailComponent = {
  index: number;
  nature: string;
  weight?: number;
  attempt?: number;
  score?: number;
};

export type VnuCrossDetailRow = {
  courseCode: string;
  classId: string;
  termOrdinal: string;
};

const CROSS_DETAIL_HMAC_DOMAIN = "hyeboard:vnu-cross-detail:v1";
const VNU_CROSS_DETAIL_PERMIT_MAX_LENGTH = 1_100;
const VNU_CROSS_DETAIL_PERMIT_PATTERN =
  /^([0-9a-f]{32})\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const VNU_CROSS_DETAIL_BODY_OVERHEAD_BYTES = 1_024;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacVnuCrossDetail(
  secret: string,
  domain: "requester" | "target" | "revision" | "row" | "permit",
  value: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${CROSS_DETAIL_HMAC_DOMAIN}:${domain}\n${value}`),
  );
  return toHex(new Uint8Array(signature));
}

export function crossDetailUnavailable(): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_DETAIL_UNAVAILABLE",
    "Cross-student grade detail is unavailable on this deployment.",
    503,
  );
}

export function crossDetailPermitInvalid(): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_DETAIL_PERMIT_INVALID",
    "The cross-detail permit is invalid or expired.",
    403,
  );
}

export function crossDetailBodyInvalid(): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_DETAIL_BODY_INVALID",
    "The cross-detail request body is invalid.",
    400,
  );
}

function crossDetailNotExplicitlyAllowed(): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED",
    "Cross-student lookup requires the literal allowCrossLookup: true opt-in.",
    400,
  );
}

function crossDetailExportNotSelected(): HyeboardError {
  return new HyeboardError(
    "VNU_CROSS_DETAIL_EXPORT_NOT_SELECTED",
    "Cross-detail export requires an explicit selected set of row permits.",
    400,
  );
}

export type VnuCrossDetailMinter = {
  readonly issued: VnuCrossDetailIssuedPermit[];
  mint(input: {
    targetStdId: string;
    transcriptHtml: string;
    row: VnuCrossDetailRow;
  }): Promise<string | undefined>;
};

// Per-request mint budget: at most maxRows permits spanning at most
// maxTargets distinct targets per issuance call. Rows beyond the caps simply
// get no permit (the transcript data itself is unaffected).
export function createVnuCrossDetailMinter(options: {
  secret: string;
  requesterToken: string;
  maxTargets: number;
  maxRows: number;
  permitTtlSeconds: number;
}): VnuCrossDetailMinter {
  const issued: VnuCrossDetailIssuedPermit[] = [];
  const targets = new Set<string>();
  let pending = Promise.resolve();
  return {
    issued,
    mint(input) {
      const result = pending.then(async () => {
        if (issued.length >= options.maxRows) return undefined;
        const isNewTarget = !targets.has(input.targetStdId);
        if (isNewTarget && targets.size >= options.maxTargets) return undefined;

        const requesterHmac = await hmacVnuCrossDetail(
          options.secret,
          "requester",
          options.requesterToken,
        );
        const targetHmac = await hmacVnuCrossDetail(
          options.secret,
          "target",
          input.targetStdId,
        );
        const revisionHmac = await hmacVnuCrossDetail(
          options.secret,
          "revision",
          input.transcriptHtml,
        );
        const rowHmac = await hmacVnuCrossDetail(
          options.secret,
          "row",
          `${input.targetStdId}\n${input.row.termOrdinal}\n${input.row.classId}\n${input.row.courseCode}`,
        );
        const permitId = toHex(crypto.getRandomValues(new Uint8Array(16)));
        const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
        const envelope = await encryptVnuCrossDetailPermitEnvelope(
          {
            version: 1,
            purpose: "vnu-cross-detail",
            nonce,
            targetHmac,
            revisionHmac,
            rowHmac,
            selector: {
              stdId: input.targetStdId,
              classId: input.row.classId,
              termOrdinal: input.row.termOrdinal,
            },
          },
          options.secret,
        );
        issued.push({
          permitHash: await hmacVnuCrossDetail(
            options.secret,
            "permit",
            permitId,
          ),
          record: {
            requesterHmac,
            targetHmac,
            revisionHmac,
            rowHmac,
            policyVersion: VNU_CROSS_DETAIL_POLICY_VERSION,
            nonce,
            envelope,
            expiresAt: Date.now() + options.permitTtlSeconds * 1000,
          },
        });
        targets.add(input.targetStdId);
        return `${permitId}.${envelope}`;
      });
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export function parseVnuCrossDetailPermitString(value: unknown): {
  permitId: string;
  envelope: string;
} {
  if (
    typeof value !== "string" ||
    value.length > VNU_CROSS_DETAIL_PERMIT_MAX_LENGTH
  )
    throw crossDetailPermitInvalid();
  const match = VNU_CROSS_DETAIL_PERMIT_PATTERN.exec(value);
  if (!match) throw crossDetailPermitInvalid();
  return { permitId: match[1], envelope: match[2] };
}

export async function buildVnuCrossDetailConsumeInput(
  secret: string,
  requesterToken: string,
  parsed: { permitId: string },
  presented: VnuCrossDetailPermitEnvelope,
): Promise<VnuCrossDetailConsumeInput> {
  return {
    permitHash: await hmacVnuCrossDetail(secret, "permit", parsed.permitId),
    nonce: presented.nonce,
    requesterHmac: await hmacVnuCrossDetail(
      secret,
      "requester",
      requesterToken,
    ),
    targetHmac: presented.targetHmac,
    revisionHmac: presented.revisionHmac,
    rowHmac: presented.rowHmac,
    policyVersion: VNU_CROSS_DETAIL_POLICY_VERSION,
  };
}

export function crossDetailBodyMaxBytes(maxRows: number): number {
  const boundedRows = Math.min(Math.max(1, maxRows), 512);
  return (
    boundedRows * (VNU_CROSS_DETAIL_PERMIT_MAX_LENGTH + 16) +
    VNU_CROSS_DETAIL_BODY_OVERHEAD_BYTES
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
    throw new HyeboardError(
      "PAYLOAD_TOO_LARGE",
      "The request body is too large.",
      413,
    );
  if (!request.body) throw crossDetailBodyInvalid();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HyeboardError(
          "PAYLOAD_TOO_LARGE",
          "The request body is too large.",
          413,
        );
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const encoded = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      encoded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(encoded),
    );
  } catch (error) {
    if (error instanceof HyeboardError) throw error;
    throw crossDetailBodyInvalid();
  }
}

const CROSS_DETAIL_BODY_KEYS: Record<string, readonly string[]> = {
  single: ["allowCrossLookup", "permit"],
  bulk: ["allowCrossLookup", "permits"],
  export: ["allowCrossLookup", "permits"],
};

function parsePermitArray(
  value: unknown,
  maxRows: number,
  shapeInvalid: () => HyeboardError,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxRows)
    throw shapeInvalid();
  const seen = new Set<string>();
  for (const permit of value) {
    if (
      typeof permit !== "string" ||
      permit.length > VNU_CROSS_DETAIL_PERMIT_MAX_LENGTH ||
      !VNU_CROSS_DETAIL_PERMIT_PATTERN.test(permit)
    )
      throw crossDetailBodyInvalid();
    if (seen.has(permit)) throw crossDetailBodyInvalid();
    seen.add(permit);
  }
  return value as string[];
}

export async function readVnuCrossDetailBody(
  request: Request,
  kind: "single",
  maxRows: number,
): Promise<{ permit: string }>;
export async function readVnuCrossDetailBody(
  request: Request,
  kind: "bulk" | "export",
  maxRows: number,
): Promise<{ permits: string[] }>;
export async function readVnuCrossDetailBody(
  request: Request,
  kind: "single" | "bulk" | "export",
  maxRows: number,
): Promise<{ permit: string } | { permits: string[] }> {
  const value = await readBoundedJsonBody(
    request,
    crossDetailBodyMaxBytes(maxRows),
  );
  if (!isRecord(value)) throw crossDetailBodyInvalid();
  if (value.allowCrossLookup !== true) throw crossDetailNotExplicitlyAllowed();
  const keys = Object.keys(value);
  const hasUnknownKeys = keys.some(
    (key) => !CROSS_DETAIL_BODY_KEYS[kind].includes(key),
  );

  if (kind === "single") {
    if (hasUnknownKeys) throw crossDetailBodyInvalid();
    if (
      typeof value.permit !== "string" ||
      value.permit.length > VNU_CROSS_DETAIL_PERMIT_MAX_LENGTH ||
      !VNU_CROSS_DETAIL_PERMIT_PATTERN.test(value.permit)
    )
      throw crossDetailBodyInvalid();
    return { permit: value.permit };
  }

  // An export request without an explicit, bounded permits selection is the
  // "all/unbounded" shape the selected export mode exists to reject — that
  // gets its own stable code; smuggled extra keys stay plain body-invalid.
  if (
    kind === "export" &&
    (!Array.isArray(value.permits) ||
      value.permits.length === 0 ||
      value.permits.length > maxRows)
  )
    throw crossDetailExportNotSelected();
  if (hasUnknownKeys) throw crossDetailBodyInvalid();
  return {
    permits: parsePermitArray(
      value.permits,
      maxRows,
      kind === "export" ? crossDetailExportNotSelected : crossDetailBodyInvalid,
    ),
  };
}
