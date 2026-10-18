"use client";

import { useEffect, useState } from "react";
import { downloadMedicationPDF } from "../../app/pdf";
import {
  DrugInteractionResultSchema,
  PharmacyCompareResultSchema,
  type RecipientProfile,
} from "../../lib/types";
import type { AgentResult } from "../types";

const MEDS = ["Lisinopril", "Metformin", "Atorvastatin", "Amlodipine"] as const;

type SideEffectEntry = {
  id: string;
  recipientId: string;
  medicationId: string;
  description: string;
  severity: "mild" | "moderate" | "severe";
  timestamp: string;
};

const DEFAULT_SIDE_EFFECT_FORM = {
  description: "",
  severity: "mild" as const,
};

export interface MedicationsTabProps {
  agentResult: AgentResult | null;
  recipient: RecipientProfile;
}

export function MedicationsTab({ agentResult, recipient }: MedicationsTabProps) {
  const hasPriceResults = agentResult?.toolCalls.some(
    (t) => t.tool === "compare_pharmacy_prices",
  );
  const interactionCalls = agentResult?.toolCalls.filter(
    (t) => t.tool === "check_drug_interactions",
  );
  const medications = Array.from(new Set([...(recipient.medications ?? []), ...MEDS]));
  const storageKey = `careguard-side-effects-${recipient.name?.toLowerCase().replace(/\s+/g, "-") || "recipient"}`;
  const [entries, setEntries] = useState<Record<string, SideEffectEntry[]>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [forms, setForms] = useState<Record<string, typeof DEFAULT_SIDE_EFFECT_FORM>>(() =>
    Object.fromEntries(medications.map((med) => [med, { ...DEFAULT_SIDE_EFFECT_FORM }]))
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, JSON.stringify(entries));
    }
  }, [entries, storageKey]);

  function addEntry(medicationId: string) {
    const value = forms[medicationId]?.description?.trim();
    if (!value) return;
    const nextEntry: SideEffectEntry = {
      id: `${medicationId}-${Date.now()}`,
      recipientId: recipient.name,
      medicationId,
      description: value,
      severity: forms[medicationId]?.severity ?? "mild",
      timestamp: new Date().toISOString(),
    };
    setEntries((prev) => ({
      ...prev,
      [medicationId]: [...(prev[medicationId] ?? []), nextEntry].sort((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      ),
    }));
    setForms((prev) => ({
      ...prev,
      [medicationId]: { ...DEFAULT_SIDE_EFFECT_FORM },
    }));
  }

  return (
    <div
      role="tabpanel"
      id="tabpanel-medications"
      aria-labelledby="tab-medications"
      tabIndex={0}
      className="space-y-6"
    >
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-700">
            {recipient.name}&apos;s Medications
          </h2>
          {hasPriceResults && (
            <button
              onClick={() => {
                const priceResults = agentResult!.toolCalls
                  .filter((t) => t.tool === "compare_pharmacy_prices")
                  .map((t) => PharmacyCompareResultSchema.parse(t.result));
                const interactionResult = agentResult!.toolCalls.find(
                  (t) => t.tool === "check_drug_interactions",
                )?.result;
                downloadMedicationPDF(
                  {
                    priceResults,
                    interactionResult: interactionResult
                      ? DrugInteractionResultSchema.parse(interactionResult)
                      : undefined,
                    sideEffectEntries: Object.values(entries).flat(),
                  },
                  { recipient },
                );
              }}
              className="px-3 py-1.5 bg-sky-50 text-sky-700 rounded-lg text-xs font-medium hover:bg-sky-100 active:bg-sky-200 cursor-pointer transition-all"
            >
              Download PDF
            </button>
          )}
        </div>
        <div className="space-y-3">
          {medications.map((drug) => {
            const r = agentResult?.toolCalls.find(
              (t) =>
                t.tool === "compare_pharmacy_prices" &&
                t.result?.drug?.toLowerCase() === drug.toLowerCase(),
            )?.result;
            const drugEntries = entries[drug] ?? [];
            return (
              <div
                key={drug}
                className="p-4 bg-slate-50 rounded-lg space-y-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{drug}</div>
                    <div className="text-xs text-slate-500">
                      {r
                        ? `Best: ${r.cheapest.pharmacyName} at $${r.cheapest.price}`
                        : "Not yet compared"}
                    </div>
                  </div>
                  {r && (
                    <div className="text-right">
                      <div className="text-sm font-medium text-green-600">
                        Save ${r.potentialSavings}/mo
                      </div>
                      <div className="text-xs text-slate-400">
                        {r.savingsPercent}% savings
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Side effect journal
                  </div>
                  <div className="grid grid-cols-[1fr_120px_auto] gap-2">
                    <input
                      aria-label={`Side effect description for ${drug}`}
                      value={forms[drug]?.description ?? ""}
                      onChange={(e) =>
                        setForms((prev) => ({
                          ...prev,
                          [drug]: {
                            ...(prev[drug] ?? DEFAULT_SIDE_EFFECT_FORM),
                            description: e.target.value,
                          },
                        }))
                      }
                      placeholder="Describe observed side effects"
                      className="px-2 py-1.5 border border-slate-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                    <select
                      aria-label={`Severity for ${drug}`}
                      value={forms[drug]?.severity ?? "mild"}
                      onChange={(e) =>
                        setForms((prev) => ({
                          ...prev,
                          [drug]: {
                            ...(prev[drug] ?? DEFAULT_SIDE_EFFECT_FORM),
                            severity: e.target.value as "mild" | "moderate" | "severe",
                          },
                        }))
                      }
                      className="px-2 py-1.5 border border-slate-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-sky-500"
                    >
                      <option value="mild">Mild</option>
                      <option value="moderate">Moderate</option>
                      <option value="severe">Severe</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => addEntry(drug)}
                      className="px-2.5 py-1.5 rounded-md bg-sky-500 text-white text-xs font-medium hover:bg-sky-600"
                    >
                      Save
                    </button>
                  </div>

                  {drugEntries.length > 0 ? (
                    <ul className="space-y-2">
                      {drugEntries.map((entry) => (
                        <li key={entry.id} className="rounded-md border border-slate-200 bg-slate-50 p-2">
                          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                            <span>{new Date(entry.timestamp).toLocaleDateString()}</span>
                            <span className={`px-1.5 py-0.5 rounded-full ${entry.severity === "severe" ? "bg-red-100 text-red-700" : entry.severity === "moderate" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                              {entry.severity}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-slate-700">{entry.description}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-slate-500">No side effects logged yet.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {interactionCalls && interactionCalls.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-sm font-semibold text-slate-700 mb-4">
            Drug Interactions
          </h2>
          {interactionCalls.map((t, i) => (
            <div key={i} className="space-y-2">
              <p className="text-sm text-slate-600">{t.result.summary}</p>
              {t.result.interactions?.map((ix: any, j: number) => (
                <div
                  key={j}
                  className={`p-3 rounded-lg text-sm ${
                    ix.severity === "severe"
                      ? "bg-red-50 border border-red-200"
                      : ix.severity === "moderate"
                        ? "bg-amber-50 border border-amber-200"
                        : "bg-blue-50 border border-blue-200"
                  }`}
                >
                  <div className="font-medium">
                    {ix.drug1} + {ix.drug2} ({ix.severity})
                  </div>
                  <div className="text-xs mt-1 text-slate-600">
                    {ix.recommendation}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
