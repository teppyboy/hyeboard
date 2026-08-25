import { decryptVnuCrossDetailPermitEnvelope } from "@hyeboard/core";
import { describe, expect, it } from "vitest";
import {
  buildVnuCrossDetailConsumeInput,
  createVnuCrossDetailMinter,
  parseVnuCrossDetailPermitString,
  readVnuCrossDetailBody,
} from "./vnu-cross-detail";

const SECRET = "worker-test-secret-worker-test-secret";
const TARGET = "99000000001";
const TRANSCRIPT_HTML = `<table><tr><td>Sinh viên: SYNTHETIC</td><td>Mã số: 99000001</td></tr></table>`;
const ROW = { courseCode: "SYN9901", classId: "990099", termOrdinal: "2" };

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/vnu/cross-lookup/detail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cross-detail minter", () => {
  it("mints an opaque bound permit carrying only the encrypted selector envelope", async () => {
    const minter = createVnuCrossDetailMinter({ secret: SECRET, requesterToken: "token-a", maxTargets: 2, maxRows: 3, permitTtlSeconds: 60 });
    const permit = await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: ROW });

    expect(permit).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(minter.issued).toHaveLength(1);
    const serialized = JSON.stringify(minter.issued);
    expect(serialized).not.toContain(TARGET);
    expect(serialized).not.toContain("990099");
    expect(serialized).not.toContain("SYN9901");
    expect(serialized).not.toContain("token-a");

    const [, envelope] = permit!.split(/\.(.*)/);
    const decrypted = await decryptVnuCrossDetailPermitEnvelope(envelope, SECRET);
    expect(decrypted.selector).toEqual({ stdId: TARGET, classId: "990099", termOrdinal: "2" });
    expect(decrypted.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a consume input whose bindings exactly match the issued record", async () => {
    const minter = createVnuCrossDetailMinter({ secret: SECRET, requesterToken: "token-a", maxTargets: 2, maxRows: 3, permitTtlSeconds: 60 });
    const permit = await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: ROW });

    const parsed = parseVnuCrossDetailPermitString(permit);
    const presented = await decryptVnuCrossDetailPermitEnvelope(parsed.envelope, SECRET);
    const input = await buildVnuCrossDetailConsumeInput(SECRET, "token-a", parsed, presented);
    const [issued] = minter.issued;

    expect(input.permitHash).toBe(issued.permitHash);
    expect(input.nonce).toBe(issued.record.nonce);
    expect(input.requesterHmac).toBe(issued.record.requesterHmac);
    expect(input.targetHmac).toBe(issued.record.targetHmac);
    expect(input.revisionHmac).toBe(issued.record.revisionHmac);
    expect(input.rowHmac).toBe(issued.record.rowHmac);
    expect(input.policyVersion).toBe(1);
  });

  it("binds the requester token so a different bearer produces a different requester HMAC", async () => {
    const minter = createVnuCrossDetailMinter({ secret: SECRET, requesterToken: "token-a", maxTargets: 2, maxRows: 3, permitTtlSeconds: 60 });
    const permit = await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: ROW });
    const parsed = parseVnuCrossDetailPermitString(permit);
    const presented = await decryptVnuCrossDetailPermitEnvelope(parsed.envelope, SECRET);

    const otherInput = await buildVnuCrossDetailConsumeInput(SECRET, "token-b", parsed, presented);

    expect(otherInput.requesterHmac).not.toBe(minter.issued[0].record.requesterHmac);
  });

  it("binds the transcript revision so a changed transcript mints different permits", async () => {
    const minter = createVnuCrossDetailMinter({ secret: SECRET, requesterToken: "token-a", maxTargets: 2, maxRows: 3, permitTtlSeconds: 60 });
    await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: ROW });
    await minter.mint({ targetStdId: TARGET, transcriptHtml: `${TRANSCRIPT_HTML}<tr></tr>`, row: ROW });

    expect(minter.issued[0].record.revisionHmac).not.toBe(minter.issued[1].record.revisionHmac);
    expect(minter.issued[0].record.targetHmac).toBe(minter.issued[1].record.targetHmac);
  });

  it("binds the row identity across target, term, class, and course", async () => {
    const minter = createVnuCrossDetailMinter({ secret: SECRET, requesterToken: "token-a", maxTargets: 2, maxRows: 5, permitTtlSeconds: 60 });
    await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: ROW });
    await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: { ...ROW, courseCode: "SYN9902" } });

    expect(minter.issued[0].record.rowHmac).not.toBe(minter.issued[1].record.rowHmac);
  });

  it("stops minting beyond configured row and distinct-target caps", async () => {
    const minter = createVnuCrossDetailMinter({ secret: SECRET, requesterToken: "token-a", maxTargets: 1, maxRows: 2, permitTtlSeconds: 60 });

    expect(await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: ROW })).toBeDefined();
    expect(await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: { ...ROW, courseCode: "SYN9902" } })).toBeDefined();
    expect(await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: { ...ROW, courseCode: "SYN9903" } })).toBeUndefined();
    expect(await minter.mint({ targetStdId: "99000000002", transcriptHtml: TRANSCRIPT_HTML, row: ROW })).toBeUndefined();
    expect(minter.issued).toHaveLength(2);
  });

  it("sets expiry from the configured TTL", async () => {
    const minter = createVnuCrossDetailMinter({ secret: SECRET, requesterToken: "token-a", maxTargets: 1, maxRows: 1, permitTtlSeconds: 45 });
    const before = Date.now();
    await minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: ROW });

    expect(minter.issued[0].record.expiresAt).toBeGreaterThanOrEqual(before + 45_000);
    expect(minter.issued[0].record.expiresAt).toBeLessThanOrEqual(Date.now() + 45_000);
  });

  it("serializes concurrent mints within row and target caps", async () => {
    const minter = createVnuCrossDetailMinter({ secret: SECRET, requesterToken: "token-a", maxTargets: 1, maxRows: 2, permitTtlSeconds: 60 });
    const permits = await Promise.all(Array.from({ length: 8 }, (_, index) => minter.mint({ targetStdId: TARGET, transcriptHtml: TRANSCRIPT_HTML, row: { ...ROW, courseCode: `SYN${index}` } })));
    expect(permits.filter(Boolean)).toHaveLength(2);
    expect(minter.issued).toHaveLength(2);
  });
});

describe("parseVnuCrossDetailPermitString", () => {
  it.each([
    ["empty", ""],
    ["no separator", "a".repeat(32)],
    ["short id", `${"a".repeat(31)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA`],
    ["non-hex id", `${"g".repeat(32)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA`],
    ["missing envelope segment", `${"a".repeat(32)}.AAAAAAAAAAAAAAAA`],
    ["non-string", 42],
  ])("rejects %s as a generic invalid permit", (_label, value) => {
    expect(() => parseVnuCrossDetailPermitString(value)).toThrowError(
      expect.objectContaining({ code: "VNU_CROSS_DETAIL_PERMIT_INVALID", status: 403 }) as unknown as Error,
    );
  });
});

describe("readVnuCrossDetailBody", () => {
  it("accepts a single-permit body with the explicit opt-in", async () => {
    const permit = `${"a".repeat(32)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA`;
    await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permit }), "single", 10)).resolves.toEqual({ permit });
  });

  it("requires the literal boolean opt-in", async () => {
    const permit = `${"a".repeat(32)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA`;
    for (const allowCrossLookup of [undefined, "true", 1, false]) {
      await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup, permit }), "single", 10)).rejects.toMatchObject({ code: "VNU_CROSS_LOOKUP_NOT_EXPLICITLY_ALLOWED", status: 400 });
    }
  });

  it.each([
    ["stdId", { stdId: "99000000001" }],
    ["class id", { id: "990099" }],
    ["classId", { classId: "990099" }],
    ["term", { Term: "2" }],
    ["termOrdinal", { termOrdinal: "2" }],
    ["selector", { selector: "99000000001" }],
    ["val", { val: "8.8" }],
  ])("rejects a body smuggling a direct %s input", async (_label, extra) => {
    const permit = `${"a".repeat(32)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA`;
    await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permit, ...extra }), "single", 10)).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_BODY_INVALID", status: 400 });
  });

  it("rejects malformed permit values and missing permits", async () => {
    for (const permit of [undefined, "", "not-a-permit", 42, null]) {
      await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permit }), "single", 10)).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_BODY_INVALID", status: 400 });
    }
  });

  it("applies the supplied effective row ceiling", async () => {
    const permit = (seed: string) => `${seed.repeat(32)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA`;
    await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permits: [permit("a"), permit("b")] }), "bulk", 1))
      .rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_BODY_INVALID", status: 400 });
  });

  it("accepts a bounded bulk permit batch and rejects oversize batches", async () => {
    const permit = (seed: string) => `${seed.repeat(32)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA`;
    const permits = ["a", "b", "c"].map(permit);
    await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permits }), "bulk", 3)).resolves.toEqual({ permits });
    await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permits: [...permits, permit("d")] }), "bulk", 3)).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_BODY_INVALID", status: 400 });
    await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permits: [] }), "bulk", 3)).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_BODY_INVALID", status: 400 });
    await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permits: ["a", "a"].map(permit) }), "bulk", 3)).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_BODY_INVALID", status: 400 });
  });

  it("rejects an unbounded export request while accepting an explicit selection", async () => {
    const permit = `${"a".repeat(32)}.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAA`;
    await expect(readVnuCrossDetailBody(jsonRequest({ allowCrossLookup: true, permits: [permit] }), "export", 3)).resolves.toEqual({ permits: [permit] });
    for (const body of [
      { allowCrossLookup: true },
      { allowCrossLookup: true, permits: [] },
      { allowCrossLookup: true, permits: "*" },
      { allowCrossLookup: true, scope: "all" },
    ]) {
      await expect(readVnuCrossDetailBody(jsonRequest(body), "export", 3)).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_EXPORT_NOT_SELECTED", status: 400 });
    }
  });

  it("rejects non-JSON and oversized bodies", async () => {
    await expect(readVnuCrossDetailBody(new Request("http://localhost/x", { method: "POST", body: "{" }), "single", 10)).rejects.toMatchObject({ code: "VNU_CROSS_DETAIL_BODY_INVALID", status: 400 });
    const huge = JSON.stringify({ allowCrossLookup: true, permit: `${"a".repeat(32)}.AAAAAAAAAAAAAAAA.${"A".repeat(300_000)}` });
    await expect(readVnuCrossDetailBody(new Request("http://localhost/x", { method: "POST", body: huge }), "single", 10)).rejects.toMatchObject({ status: 413 });
  });
});
