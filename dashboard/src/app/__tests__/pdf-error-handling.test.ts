import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sonner', () => {
  const error = vi.fn();
  return { toast: { error } };
});

vi.mock('jspdf', () => {
  const mockImpl = vi.fn(() => ({}));
  return { default: mockImpl };
});

vi.mock('jspdf-autotable', () => ({
  default: vi.fn(),
}));

import { downloadBillAuditPDF, downloadMedicationPDF, downloadTransactionPDF, downloadDisputeLetterPDF } from '../pdf';
import type { BillAuditResult, Transaction, DisputeLetter } from '../../lib/types';
import { toast } from 'sonner';
import jsPDF from 'jspdf';

function makeAuditResult(): BillAuditResult {
  return {
    auditTimestamp: new Date().toISOString(),
    totalCharged: 1000,
    totalCorrect: 950,
    totalOvercharge: 50,
    savingsPercent: 5,
    errorCount: 1,
    recommendation: 'Review charges.',
    lineItems: [{ description: 'Test', cptCode: '99213', quantity: 1, chargedAmount: 100, status: 'valid' as const, suggestedAmount: 95 }],
  };
}

function makeMedicationParams() {
  return {
    priceResults: [{ drug: 'Lisinopril', prices: [{ pharmacyName: 'CVS', price: 10, distance: '1mi', inStock: true }], cheapest: { pharmacyName: 'CVS', price: 10, distance: '1mi', inStock: true }, potentialSavings: 5, savingsPercent: 33 }],
    interactionResult: undefined,
  };
}

function makeTransactions(): Transaction[] {
  return [{
    id: 'tx1', timestamp: new Date().toISOString(), type: 'medication' as const, description: 'Test', amount: 10, recipient: 'Rosa', stellarTxHash: 'abc', status: 'completed', category: 'meds',
  }];
}

function makeDisputeLetter(): DisputeLetter {
  return {
    billId: 'bill-1', recipientName: 'Rosa', facility: 'Hospital', totalOvercharge: 50, errorCount: 1, emailText: 'Dispute body', emailHtml: '<p>Dispute body</p>', generatedAt: new Date().toISOString(),
  };
}

describe('PDF download error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show toast when jsPDF constructor throws in downloadBillAuditPDF', () => {
    vi.mocked(jsPDF).mockImplementationOnce(() => { throw new Error('fail'); });
    downloadBillAuditPDF(makeAuditResult());
    expect(toast.error).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Couldn't generate PDF"));
  });

  it('should show toast when jsPDF constructor throws in downloadMedicationPDF', () => {
    vi.mocked(jsPDF).mockImplementationOnce(() => { throw new Error('fail'); });
    downloadMedicationPDF(makeMedicationParams());
    expect(toast.error).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Couldn't generate PDF"));
  });

  it('should show toast when jsPDF constructor throws in downloadTransactionPDF', () => {
    vi.mocked(jsPDF).mockImplementationOnce(() => { throw new Error('fail'); });
    downloadTransactionPDF(makeTransactions(), null);
    expect(toast.error).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Couldn't generate PDF"));
  });

  it('should show toast when jsPDF constructor throws in downloadDisputeLetterPDF', () => {
    vi.mocked(jsPDF).mockImplementationOnce(() => { throw new Error('fail'); });
    downloadDisputeLetterPDF(makeDisputeLetter());
    expect(toast.error).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Couldn't generate PDF"));
  });
});
