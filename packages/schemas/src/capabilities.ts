import { z } from "zod";

export const capabilityKeys = [
  "profile",
  "terms",
  "timetable",
  "courses",
  "assignments",
  "grades",
  "exams",
  "attendance",
  "notifications",
  "documents",
  "tuition",
  "news",
  "trainingPoints",
  "requests",
  // Verified only for daotao.vnu.edu.vn's captured HTML shapes.
  "classLookup",
  // Cross-student lookup requires verified upstream behavior and deployment authorization.
  "crossLookup",
] as const;

export const capabilityKeySchema = z.enum(capabilityKeys);
export type CapabilityKey = z.infer<typeof capabilityKeySchema>;
