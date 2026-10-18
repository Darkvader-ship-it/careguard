// CareGuard Shared Types

/**
 * Drug Interaction Severity Convention
 *
 * The following severity levels are used for drug interactions,
 * ordered by clinical risk:
 * - "severe" (0): Life-threatening or requires immediate intervention
 * - "moderate" (1): Significant interaction requiring monitoring/adjustment
 * - "mild" (2): Minor interaction with minimal clinical impact
 *
 * When sorting interactions, severe > moderate > mild.
 * For interactions with equal severity, sort alphabetically by drug names.
 */

import { z } from 'zod';

// ── Medication ────────────────────────────────────────────────────────────────

export const MedicationSchema = z.object({
  name: z.string().min(1),
  dosage: z.string().min(1),
  frequency: z.string().min(1),
  currentPharmacy: z.string().optional(),
  currentPrice: z.number().nonnegative().optional(),
  nextRefillDate: z.string().optional(),
});

export type Medication = z.infer<typeof MedicationSchema>;

// ── PharmacyPrice ─────────────────────────────────────────────────────────────

export type SeverityThreshold = 'any' | 'major' | 'moderate' | 'mild';

export interface SideEffectEntry {
  id: string;
  recipientId: string;
  medicationId: string;
  description: string;
  severity: 'mild' | 'moderate' | 'severe';
  timestamp: string;
}

export interface SpendingPolicy {
  dailyLimit: number;
  monthlyLimit: number;
  medicationMonthlyBudget: number;
  billMonthlyBudget: number;
  approvalThreshold: number; // require caregiver approval above this amount
  holdTimeSeconds: number; // time before pending approvals auto-approve
  severityThreshold?: SeverityThreshold;
  /**
   * IANA timezone string for the caregiver's local day (Issue #207).
   * Example: "America/Phoenix", "America/New_York", "Europe/London".
   * When set, daily-limit checks use this timezone to determine "today"
   * rather than UTC or the global SPENDING_TIMEZONE env var.
   * Defaults to the SPENDING_TIMEZONE env var if omitted.
   */
  timezone?: string;
  toolFees?: Record<string, number>; // per-tool query fees (e.g., comparePharmacyPrices: 0.002)
  notifications?: {
    email: boolean;
    sms: boolean;
    emailAddress?: string;
    phoneNumber?: string;
  };
}

// A confirmed Stellar transaction hash is always 64 lowercase/uppercase hex chars.
export const STELLAR_TX_HASH_RE = /^[0-9a-f]{64}$/i;

export const TRANSACTION_CATEGORY = {
  MEDICATIONS: 'medications',
  BILLS: 'bills',
  SERVICE_FEES: 'service_fees',
} as const;

export const TRANSACTION_CATEGORIES = [
  TRANSACTION_CATEGORY.MEDICATIONS,
  TRANSACTION_CATEGORY.BILLS,
  TRANSACTION_CATEGORY.SERVICE_FEES,
] as const;

export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number];

export function isTransactionCategory(
  category: unknown,
): category is TransactionCategory {
  return (
    typeof category === 'string' &&
    (TRANSACTION_CATEGORIES as readonly string[]).includes(category)
  );
}

export function normalizeTransactionCategory(
  category: unknown,
): TransactionCategory {
  return isTransactionCategory(category)
    ? category
    : TRANSACTION_CATEGORY.SERVICE_FEES;
}

// ── Transaction ───────────────────────────────────────────────────────────────

export const TransactionSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  type: z.enum(['medication', 'bill', 'service_fee']),
  description: z.string(),
  amount: z.number().nonnegative(),
  recipient: z.string(),
  // Always a real 64-char hex Stellar tx hash, or undefined. Never a raw/base64
  // payment receipt — the backend normalizes that before recording the transaction (#14).
  stellarTxHash: z.string().regex(STELLAR_TX_HASH_RE).optional(),
  // 'extracted': hash was successfully parsed from the x402 PAYMENT-RESPONSE header.
  // 'extraction_failed': header was present but all parse strategies failed (#191).
  txHashStatus: z.enum(['extracted', 'extraction_failed']).optional(),
  mppOrderId: z.string().optional(),
  status: z.enum([
    'pending',
    'approved',
    'completed',
    'blocked',
    'disputed',
    'cancelled',
    'rejected',
  ]),
  category: z.enum(TRANSACTION_CATEGORIES),
  pendingUntil: z.string().optional(),
  submittedAt: z.string().optional(),
});

export type Transaction = z.infer<typeof TransactionSchema>;

// ── AgentAction ───────────────────────────────────────────────────────────────

export const AgentActionSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  action: z.string(),
  details: z.string(),
  cost: z.number().nonnegative(),
  result: z.string(),
  transactions: z.array(TransactionSchema),
});

export type AgentAction = z.infer<typeof AgentActionSchema>;

// ── CareRecipientProfile (Issue #1067) ────────────────────────────────────────

export interface CareRecipientProfile {
  name: string;
  walletAddress: string;
  medications: Medication[];
  spendingPolicy: SpendingPolicy;
  monthlySpending: {
    medications: number;
    bills: number;
    serviceFees: number;
    total: number;
  };
  savingsAchieved: number;
}

/** Legacy type alias for CareRecipientProfile (Issue #1067) */
export type CareRecipient = CareRecipientProfile;

// ── Alert ─────────────────────────────────────────────────────────────────────

export const AlertSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  type: z.enum([
    'approval_needed',
    'error_found',
    'refill_due',
    'budget_warning',
    'policy_blocked',
  ]),
  title: z.string(),
  description: z.string(),
  amount: z.number().nonnegative().optional(),
  actionRequired: z.boolean(),
  resolved: z.boolean(),
});

export type Alert = z.infer<typeof AlertSchema>;
