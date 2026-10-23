import { z } from "zod";
export const restoreRecordSchema = z.object({
  formatVersion: z.literal(1),
  targetFingerprint: z.string().min(1).max(128),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  backupIdentity: z.string().min(1).max(1000),
  backupCapturedAt: z.string().datetime(),
  restoredSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/),
  restoredAt: z.string().datetime(),
  verificationLog: z.string().min(40).max(20000),
  acceptedMaxAgeMinutes: z.number().int().min(1).max(10080),
  downtimeLimitMinutes: z.number().int().min(0).max(10080),
  dataLossLimitMinutes: z.number().int().min(0).max(10080),
  affectedServices: z.array(z.string().min(1).max(200)).min(1).max(100),
}).strict();
export type RestoreVerificationRecord = z.infer<typeof restoreRecordSchema>;
