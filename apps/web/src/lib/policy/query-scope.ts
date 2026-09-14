const INVALIDATABLE_QUERY_NAMES = new Set([
  "dashboard",
  "terms",
  "timetable",
  "courses",
  "assignments",
  "grades",
  "exams",
  "tuition",
  "documents",
  "training-points",
  "requests",
  "news",
  "vnu-point-detail",
  "vnu-cross-student-code",
  "vnu-cross-student-id",
  "vnu-cross-transcript",
  "vnu-cross-detail",
  "vnu-lookup-catalog",
  "vnu-lookup-profile",
]);

type AccountQueryCandidate = {
  queryKey: readonly unknown[];
  isActive(): boolean;
};

export function shouldInvalidateAccountQuery(query: AccountQueryCandidate): boolean {
  return query.isActive()
    && typeof query.queryKey[0] === "string"
    && INVALIDATABLE_QUERY_NAMES.has(query.queryKey[0]);
}

export function shouldInvalidateScopedAccountQuery(
  query: AccountQueryCandidate,
  universityId: string,
  sessionNonce: number,
): boolean {
  const name = query.queryKey[0];
  const nonceIndex = typeof name === "string" && name.startsWith("vnu-") ? 2 : 3;
  return shouldInvalidateAccountQuery(query)
    && query.queryKey[1] === universityId
    && query.queryKey[nonceIndex] === sessionNonce;
}

export async function invalidatePolicyQueries(
  queryClient: {
    cancelQueries(options: unknown): Promise<unknown>;
    invalidateQueries(options: unknown): Promise<unknown>;
  },
  scope: { universityId: string; sessionNonce: number },
): Promise<void> {
  await queryClient.cancelQueries({
    predicate: (query: AccountQueryCandidate) => shouldInvalidateScopedAccountQuery(query, scope.universityId, scope.sessionNonce),
  });
  await queryClient.invalidateQueries({ queryKey: ["universities"], refetchType: "active" });
  await queryClient.invalidateQueries({
    predicate: (query: AccountQueryCandidate) => shouldInvalidateScopedAccountQuery(query, scope.universityId, scope.sessionNonce),
    refetchType: "active",
  });
}
